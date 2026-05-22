import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioRuntimeState } from "@/lib/home-agent/types";
import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import { saveApiConfig } from "@/lib/api-config";
import { createEmptyDramaProject } from "@/types/drama";
import { normalizeVideoGenerationPrefs } from "@/lib/home-agent/video-models";

const createStoredVideoProject = vi.fn();
const listStoredVideoProjects = vi.fn();
const loadStoredVideoProjectById = vi.fn();
const upsertStoredVideoProject = vi.fn(async (project: PersistedVideoProject) => ({
  ...project,
  updatedAt: "2026-04-03T01:00:00.000Z",
}));
const invokeFunction = vi.fn();
const cacheProjectVideoSource = vi.fn(async () => null);
const normalizeLocalVideoPath = vi.fn((url: string) =>
  decodeURIComponent(url.replace(/^file:\/\/+/, ""))
    .replace(/^\/([A-Za-z]:\/)/, "$1")
    .replace(/\//g, "\\"),
);
const dreaminaCliGetStatus = vi.fn(async () => ({
  ok: true,
  installed: true,
  loggedIn: true,
  message: "已登录 Dreamina CLI",
}));
const analyzeSegmentVideoVisualQuality = vi.fn(async () => null);
const analyzeReferenceImageQuality = vi.fn(async () => null);
const analyzeReferenceVariantDistinctness = vi.fn(async () => null);

vi.mock("@/hooks/use-local-persistence", () => ({
  createStoredVideoProject,
  listStoredVideoProjects,
  loadStoredVideoProjectById,
  upsertStoredVideoProject,
}));

vi.mock("@/lib/invoke-with-key", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/invoke-with-key")>();
  return {
    ...actual,
    invokeFunction,
  };
});

vi.mock("@/lib/home-agent/video-cache", () => ({
  cacheProjectVideoSource,
  normalizeLocalVideoPath,
}));

vi.mock("@/lib/dreamina-cli", () => ({
  dreaminaCliGetStatus,
}));

vi.mock("@/lib/home-agent/video-visual-quality-analysis", () => ({
  analyzeSegmentVideoVisualQuality,
}));

vi.mock("@/lib/home-agent/image-reference-quality-analysis", () => ({
  analyzeReferenceImageQuality,
  analyzeReferenceVariantDistinctness,
}));

const {
  __setVideoWorkflowMediaSubmissionGuardDelayForTests,
  abortVideoWorkflowGeneration,
  analyzeScriptForVideoAction,
  buildExactDialogueLockBlock,
  buildRequiredSegmentCoverageBlock,
  compileSegmentVideosAction,
  compileVideoShotPacketsAction,
  createVideoBridgeArtifactAction,
  extractVideoEntitiesAction,
  prepareVideoGenerationAction,
  prepareVideoPromptBatchAction,
  prepareSegmentVideoPromptAction,
  generateSegmentVideoAction,
  refreshSegmentVideoAction,
  refreshSegmentContinuityArtifactsFromSegmentVideoSource,
  promoteArchivedSegmentVideoCandidateToOfficialAsset,
  approveVideoAssetsAction,
  redoVideoAssetsAction,
  generateProjectImageAction,
  prepareStoryboardBatchAction,
  generateVideoReferenceAssetsAction,
  generateStoryboardFramesAction,
  generateVideoAssetsAction,
  refreshVideoAssetsAction,
  getSegmentContinuityGridFrameLabel,
  getSegmentContinuityGridSourceAspectRatio,
  getSegmentContinuityGridCanvasHeightForAspectRatio,
  planVideoWorkflowContinuation,
} = await import("./video-workflow-service");

function createVideoProject(
  overrides: Partial<PersistedVideoProject> = {},
): PersistedVideoProject {
  return {
    id: "video-project-1",
    title: "夜雨追击预告片",
    script: "女主在雨夜回头看见追兵。",
    targetPlatform: "抖音",
    shotStyle: "电影感近景",
    outputGoal: "预告片",
    productionNotes: "",
    scenes: [
      {
        id: "scene-1",
        sceneNumber: 1,
        sceneName: "雨夜追击",
        description: "女主在雨夜回头看见追兵。",
        characters: ["沈昭"],
        dialogue: "",
        cameraDirection: "中景跟拍",
        duration: 6,
        storyboardUrl: "https://media.storyforge.test/storyboard-1.jpg",
      },
    ],
    characters: [
      {
        id: "char-1",
        name: "沈昭",
        description: "红衣、清冷、警觉",
        imageUrl: "https://media.storyforge.test/char-1.jpg",
        isAIGenerated: false,
        source: "auto",
      },
    ],
    sceneSettings: [
      {
        id: "setting-1",
        name: "雨夜长街",
        description: "冷色夜雨中的长街",
        imageUrl: "https://media.storyforge.test/scene-1.jpg",
        isAIGenerated: false,
        source: "auto",
      },
    ],
    artStyle: "live-action",
    currentStep: 4,
    systemPrompt: "",
    analysisSummary: "视频提示词已经整理完成。",
    storyboardPlan: "镜头 1：雨夜追击",
    videoPromptBatch: "批次 1：雨夜追击",
    sourceProjectId: "drama-1",
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:30:00.000Z",
    styleLock: null,
    worldModel: null,
    assetManifest: null,
    shotPackets: [],
    reviewQueue: [],
    ...overrides,
  };
}

function buildMockStructuredSegmentPrompt(body: Record<string, unknown>): string {
  const shots = Array.isArray(body.shots)
    ? (body.shots as Array<Record<string, unknown>>)
    : [];
  const sceneNames = Array.from(
    new Set(
      shots
        .map((shot) => String(shot.sceneName || "").trim())
        .filter(Boolean),
    ),
  );
  const maxDuration = Math.max(
    1,
    Number(body.maxDuration) || Number(body.targetDuration) || 15,
  );
  const beatLines = shots.length
    ? shots.map((shot, index) => {
        const start = Math.floor((maxDuration * index) / shots.length);
        const end =
          index === shots.length - 1
            ? maxDuration
            : Math.floor((maxDuration * (index + 1)) / shots.length);
        const sceneName = String(shot.sceneName || "").trim();
        const cameraDirection = String(shot.cameraDirection || "").trim();
        const promptText = String(shot.prompt || "").trim();
        const rawDescription = String(shot.rawDescription || "").trim();
        const detailParts = Array.from(
          new Set([promptText, rawDescription].filter(Boolean)),
        );
        let detail = detailParts.join("；");
        if (detail.length < 18) {
          const focus = detail || sceneName || `片段 ${body.segmentLabel || index + 1} 的关键动作`;
          detail = [
            sceneName ? `${sceneName}中，${focus}` : focus,
            cameraDirection ? `镜头以${cameraDirection}继续推进` : "镜头继续推进",
            "人物动作、视线焦点与画面压迫感都在这一拍里持续升级并保留明确落点",
          ].join("，");
        }
        const dialogue = String(shot.dialogue || "").trim();
        return `分镜${index + 1}（${start}-${end}秒）：${detail}${dialogue ? `；${dialogue}` : ""}`;
      })
    : [`分镜1（0-${maxDuration}秒）：${String(body.segmentLabel || "当前片段")}的镜头推进。`];

  return [
    `全局风格：电影感，${maxDuration}秒，压迫感明确。`,
    `视觉锚点：${sceneNames.join("、") || String(body.segmentLabel || "当前片段")}保持一致。`,
    "起始衔接：从上一镜头停点直接接入当前片段。",
    "衔接原则：严格按已拆分镜头顺序推进。",
    "镜头推进：",
    ...beatLines,
    `环境细节：${sceneNames[0] || "当前场景"}的光线、空间和动作延续清晰。`,
    "结尾钩子：最后一镜保留下一个动作悬念。",
    "通用后缀：无字幕、无水印、无屏幕文字",
  ].join("\n");
}

function createRuntime(
  project: PersistedVideoProject,
): StudioRuntimeState {
  return {
    sessionId: "session-video-1",
    currentProjectSnapshot: null,
    currentDramaProject: null,
    currentVideoProject: project,
    currentSetupDraft: null,
    skillDrafts: [],
    maintenanceReports: [],
    recentProjects: [],
    recentMessageSummary: "",
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function installContinuityGridRenderMocks() {
  const originalCreateElement = document.createElement.bind(document);
  const fillText = vi.fn();
  const createElementSpy = vi
    .spyOn(document, "createElement")
    .mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      if (String(tagName).toLowerCase() === "canvas") {
        const ctx = {
          fillStyle: "",
          strokeStyle: "",
          lineWidth: 0,
          font: "",
          save: vi.fn(),
          restore: vi.fn(),
          fillRect: vi.fn(),
          drawImage: vi.fn(),
          strokeRect: vi.fn(),
          fillText,
          beginPath: vi.fn(),
          moveTo: vi.fn(),
          lineTo: vi.fn(),
          stroke: vi.fn(),
          measureText: vi.fn((text: string) => ({ width: String(text || "").length * 16 })),
        };
        return {
          width: 0,
          height: 0,
          getContext: vi.fn(() => ctx),
          toDataURL: vi.fn(() => "data:image/jpeg;base64,SEGMENT_CONTINUITY_GRID_BASE64"),
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tagName, options);
    }) as typeof document.createElement);

  const OriginalImage = globalThis.Image;
  class MockImage {
    onload: ((this: HTMLImageElement, ev: Event) => unknown) | null = null;
    onerror: ((this: HTMLImageElement, ev: Event | string) => unknown) | null = null;
    decoding = "async";
    naturalWidth = 1600;
    naturalHeight = 900;
    width = 1600;
    height = 900;
    private _src = "";

    set src(value: string) {
      this._src = value;
      queueMicrotask(() => {
        this.onload?.call(this as unknown as HTMLImageElement, new Event("load"));
      });
    }

    get src() {
      return this._src;
    }
  }

  globalThis.Image = MockImage as unknown as typeof Image;

  return {
    fillText,
    restore() {
      createElementSpy.mockRestore();
      globalThis.Image = OriginalImage;
    },
  };
}

async function flushMicrotasks(turns = 12) {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}

describe("video-workflow-service execution", () => {
  beforeEach(() => {
    invokeFunction.mockReset();
    createStoredVideoProject.mockReset();
    listStoredVideoProjects.mockReset();
    listStoredVideoProjects.mockResolvedValue([]);
    loadStoredVideoProjectById.mockReset();
    upsertStoredVideoProject.mockClear();
    cacheProjectVideoSource.mockReset();
    cacheProjectVideoSource.mockResolvedValue(null);
    normalizeLocalVideoPath.mockClear();
    dreaminaCliGetStatus.mockReset();
    dreaminaCliGetStatus.mockResolvedValue({
      ok: true,
      installed: true,
      loggedIn: true,
      message: "已登录 Dreamina CLI",
    });
    analyzeSegmentVideoVisualQuality.mockReset();
    analyzeSegmentVideoVisualQuality.mockResolvedValue(null);
    analyzeReferenceImageQuality.mockReset();
    analyzeReferenceImageQuality.mockResolvedValue(null);
    analyzeReferenceVariantDistinctness.mockReset();
    analyzeReferenceVariantDistinctness.mockResolvedValue(null);
    __setVideoWorkflowMediaSubmissionGuardDelayForTests(null);
    window.electronAPI = undefined;
    localStorage.clear();
  });

  it("locks dialogue to audio and explicitly forbids visible subtitle overlays", () => {
    expect(buildExactDialogueLockBlock("女主：别回头")).toContain("只通过对白、口型或旁白音频出现");
    expect(buildExactDialogueLockBlock("女主：别回头")).toContain("不以上屏文字呈现");
    expect(buildExactDialogueLockBlock("")).toContain("画面中不要出现字幕或其他上屏文字");
  });

  it("marks segment dialogue as audio-only in the compact shot-anchor supplement", () => {
    const coverage = buildRequiredSegmentCoverageBlock(
      [
        {
          id: "scene-1",
          sceneNumber: 1,
          sceneName: "雨夜追击",
          description: "女主冲出巷口。",
          characters: ["沈昭"],
          dialogue: "女主：快走",
          cameraDirection: "无字幕、无水印",
          duration: 6,
          storyboardUrl: "",
        },
      ],
      6,
    );

    expect(coverage).toContain("【镜头锚点补充】");
    expect(coverage).toContain("台词音频 女主：快走，只走音频不上屏");
    expect(coverage).not.toContain("【执行底线】");
  });

  it("labels six-grid cells with first, middle, and last frame semantics", () => {
    expect(getSegmentContinuityGridFrameLabel(0, 6)).toBe("首帧");
    expect(getSegmentContinuityGridFrameLabel(1, 6)).toBe("过程1");
    expect(getSegmentContinuityGridFrameLabel(4, 6)).toBe("过程4");
    expect(getSegmentContinuityGridFrameLabel(5, 6)).toBe("尾帧");
  });

  it("sizes six-grid cells from the video frame aspect ratio instead of forcing square crops", () => {
    const landscapeAspectRatio = getSegmentContinuityGridSourceAspectRatio(1920, 1080);
    const portraitAspectRatio = getSegmentContinuityGridSourceAspectRatio(1080, 1920);

    expect(landscapeAspectRatio).toBeCloseTo(16 / 9, 3);
    expect(portraitAspectRatio).toBeCloseTo(9 / 16, 3);

    const landscapeHeight = getSegmentContinuityGridCanvasHeightForAspectRatio(landscapeAspectRatio);
    const portraitHeight = getSegmentContinuityGridCanvasHeightForAspectRatio(portraitAspectRatio);

    expect(landscapeHeight).toBeGreaterThan(224);
    expect(portraitHeight).toBeGreaterThan(landscapeHeight);
  });

  it("promotes bridge-complete projects into the role-and-scene step after script breakdown passes", async () => {
    const runtime = createRuntime(
      createVideoProject({
        currentStep: 1,
        storyboardPlan: "",
        videoPromptBatch: "",
        shotPackets: [],
        characters: [],
        sceneSettings: [],
        scriptBreakdownPassed: true,
        analysisSummary: "脚本拆解已通过。",
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "雨夜追击",
            description: "女主在雨夜回头看见追兵。",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "中景跟拍",
            duration: 6,
            storyboardUrl: "",
          },
        ],
      }),
    );

    const result = await createVideoBridgeArtifactAction(
      {
        projectId: "video-project-1",
      },
      runtime,
    );

    expect(result.data?.videoProject?.currentStep).toBe(2);
    expect(result.projectSnapshot?.derivedStage).toBe("角色与场景");
  });

  it("reuses an existing linked video project when the same script project re-enters video workflow", async () => {
    const linkedVideoProject = createVideoProject({
      id: "video-linked-1",
      sourceProjectId: "script-project-1",
      currentStep: 2,
    });
    listStoredVideoProjects.mockResolvedValue([linkedVideoProject]);
    loadStoredVideoProjectById.mockResolvedValue(null);

    const runtime: StudioRuntimeState = {
      sessionId: "session-video-bridge-1",
      currentProjectSnapshot: {
        projectId: "script-project-1",
        projectKind: "script",
        title: "旧项目",
        currentObjective: "接入视频工作流",
        derivedStage: "剧本",
        agentSummary: "summary",
        recommendedActions: [],
        artifacts: [],
      },
      currentDramaProject: null,
      currentVideoProject: null,
      currentSetupDraft: null,
      skillDrafts: [],
      maintenanceReports: [],
      recentProjects: [],
      recentMessageSummary: "",
    };

    const result = await prepareVideoGenerationAction(
      {
        projectKind: "video",
        projectId: "script-project-1",
      },
      runtime,
    );

    expect(createStoredVideoProject).not.toHaveBeenCalled();
    expect(result.data?.videoProject?.id).toBe("video-linked-1");
    expect(result.data?.videoProject?.sourceProjectId).toBe("script-project-1");
  });

  it("persists requested video prefs when a linked script project re-enters video workflow", async () => {
    const linkedVideoProject = createVideoProject({
      id: "video-linked-1",
      sourceProjectId: "script-project-1",
      currentStep: 2,
      videoGenerationPrefs: normalizeVideoGenerationPrefs({
        modelKey: "doubao-seedance-1-5-pro",
        resolution: "720p",
        mode: "text-to-video",
      }),
    });
    listStoredVideoProjects.mockResolvedValue([linkedVideoProject]);
    loadStoredVideoProjectById.mockResolvedValue(null);

    const runtime: StudioRuntimeState = {
      sessionId: "session-video-bridge-2",
      currentProjectSnapshot: {
        projectId: "script-project-1",
        projectKind: "script",
        title: "旧项目",
        currentObjective: "接入视频工作流",
        derivedStage: "剧本",
        agentSummary: "summary",
        recommendedActions: [],
        artifacts: [],
      },
      currentDramaProject: null,
      currentVideoProject: null,
      currentSetupDraft: null,
      skillDrafts: [],
      maintenanceReports: [],
      recentProjects: [],
      recentMessageSummary: "",
    };

    const result = await prepareVideoGenerationAction(
      {
        projectKind: "video",
        projectId: "script-project-1",
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "480p",
          mode: "text-to-video",
        },
      },
      runtime,
    );

    expect(result.data?.videoProject?.videoGenerationPrefs).toEqual({
      modelKey: "doubao-seedance-1-5-pro",
      resolution: "480p",
      mode: "text-to-video",
    });
  });

  it("persists requested video prefs when full-auto video workflow creates a fresh project", async () => {
    createStoredVideoProject.mockResolvedValue(
      createVideoProject({
        id: "video-new-1",
        sourceProjectId: undefined,
        currentStep: 1,
        videoGenerationPrefs: normalizeVideoGenerationPrefs({
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        }),
      }),
    );

    const runtime: StudioRuntimeState = {
      sessionId: "session-video-fresh-1",
      currentProjectSnapshot: null,
      currentDramaProject: null,
      currentVideoProject: null,
      currentSetupDraft: null,
      skillDrafts: [],
      maintenanceReports: [],
      recentProjects: [],
      recentMessageSummary: "",
    };

    const result = await prepareVideoGenerationAction(
      {
        projectKind: "video",
        title: "Fresh workflow project",
        script: "第一集剧情正文",
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "480p",
          mode: "text-to-video",
        },
      },
      runtime,
    );

    expect(createStoredVideoProject).toHaveBeenCalled();
    expect(result.data?.videoProject?.videoGenerationPrefs).toEqual({
      modelKey: "doubao-seedance-1-5-pro",
      resolution: "480p",
      mode: "text-to-video",
    });
  });

  it("passes an abort signal into reference image generation so homepage stop can interrupt polling", async () => {
    let receivedSignal: AbortSignal | undefined;

    invokeFunction.mockImplementation(
      async (
        name: string,
        _body: Record<string, unknown>,
        options?: { abortSignal?: AbortSignal },
      ) => {
        if (name !== "generate-character") {
          throw new Error(`unexpected function: ${name}`);
        }

        receivedSignal = options?.abortSignal;
        return new Promise((_, reject) => {
          options?.abortSignal?.addEventListener(
            "abort",
            () => reject(new Error("请求已取消")),
            { once: true },
          );
        });
      },
    );

    const runtime = createRuntime(
      createVideoProject({
        characters: [
          {
            id: "char-1",
            name: "沈昭",
            description: "红衣、清冷、警觉",
            imageUrl: "",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        sceneSettings: [],
        currentStep: 2,
      }),
    );

    const pending = generateVideoReferenceAssetsAction({}, runtime);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(false);

    abortVideoWorkflowGeneration();

    await expect(pending).rejects.toThrow("请求已取消");
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("passes an abort signal into segment prompt enhancement and stops without saving aborted output", async () => {
    let receivedSignal: AbortSignal | undefined;

    invokeFunction.mockImplementation(
      async (
        name: string,
        _body: Record<string, unknown>,
        options?: { abortSignal?: AbortSignal },
      ) => {
        if (name !== "enhance-video-prompt") {
          throw new Error(`unexpected function: ${name}`);
        }

        receivedSignal = options?.abortSignal;
        return new Promise((_, reject) => {
          options?.abortSignal?.addEventListener(
            "abort",
            () => reject(new Error("请求已取消")),
            { once: true },
          );
        });
      },
    );

    const controller = new AbortController();
    const onProgress = vi.fn();
    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            description: "Scene 1 description",
            characters: [],
            dialogue: "",
            cameraDirection: "",
            duration: 5,
            segmentLabel: "1-1",
            enhancedVideoPrompt: "Ready prompt",
          },
        ],
        segmentVideoPrompts: {},
      }),
    );

    const pending = prepareSegmentVideoPromptAction(
      { batchMode: "all", abortSignal: controller.signal },
      runtime,
      onProgress,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(false);

    controller.abort();

    await expect(pending).rejects.toThrow("请求已取消");
    expect(upsertStoredVideoProject).not.toHaveBeenCalledWith(
      expect.objectContaining({
        segmentVideoPrompts: expect.objectContaining({
          "1-1": expect.anything(),
        }),
      }),
    );
    expect(onProgress.mock.calls.map((call) => call[0]?.summary)).toEqual(
      expect.arrayContaining([expect.stringContaining("已停止")]),
    );
  });

  it("marks the active video project before image generation so generated assets can be saved to project storage", async () => {
    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "generate-character") {
        throw new Error(`unexpected function: ${name}`);
      }
      expect(localStorage.getItem("storyforge_current_project")).toBe("video-project-1");
      return {
        data: {
          imageUrl:
            "C:\\workspace\\files\\projects\\video-project-1\\images\\generated\\characters\\hero.jpg",
        },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "Main character reference",
            imageUrl: "",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        sceneSettings: [],
        currentStep: 2,
      }),
    );

    await generateVideoReferenceAssetsAction({}, runtime);

    expect(localStorage.getItem("storyforge_current_project")).toBe("video-project-1");
  });

  it("prefers the exported drama document when bridging a script project into video analysis", async () => {
    invokeFunction.mockResolvedValue({
      data: {
        scenes: [
          {
            sceneName: "Scene 1",
            description: "Use exported script content",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "wide shot",
            duration: 5,
          },
        ],
      },
      error: null,
    });

    const runtime: StudioRuntimeState = {
      ...createRuntime(
        createVideoProject({
          script: "",
          scenes: [],
          characters: [],
          sceneSettings: [],
          currentStep: 1,
        }),
      ),
      currentDramaProject: {
        ...createEmptyDramaProject(),
        dramaTitle: "Bridge Source",
        exportDocument: "最终导出稿正文",
        creativePlan: "创意方案正文",
        episodes: [
          {
            number: 1,
            title: "Episode 1",
            content: "分集正文",
            wordCount: 0,
            summary: "",
          },
        ],
      },
    };

    await analyzeScriptForVideoAction({}, runtime);

    expect(invokeFunction).toHaveBeenCalledWith(
      "script-decompose",
      expect.objectContaining({
        script: "最终导出稿正文",
        costumeInfo: expect.any(Array),
        sceneSettingInfo: expect.any(Array),
      }),
      expect.anything(),
    );
  });

  it("passes existing scenes when retrying only missing script episodes", async () => {
    const existingScene = {
      id: "scene-existing",
      sceneNumber: 1,
      sceneName: "Episode 1 Scene",
      description: "Already decomposed.",
      characters: [],
      dialogue: "",
      cameraDirection: "",
      duration: 5,
      segmentLabel: "1-1",
    };
    invokeFunction.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      if (name !== "script-decompose") {
        throw new Error(`unexpected function: ${name}`);
      }
      expect(body.retryMissingEpisodes).toBe(true);
      expect(body.existingScenes).toEqual([existingScene]);
      return {
        data: {
          scenes: [
            existingScene,
            {
              sceneNumber: 2,
              sceneName: "Episode 2 Scene",
              description: "Newly decomposed.",
              characters: [],
              dialogue: "",
              cameraDirection: "",
              duration: 5,
              segmentLabel: "2-1",
            },
          ],
        },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        script: "第1集：开端\n正文\n\n第2集：推进\n正文",
        scenes: [existingScene],
        preferredEpisodeDurationSeconds: 60,
      }),
    );

    const result = await analyzeScriptForVideoAction({ retryMissingEpisodes: true }, runtime);

    expect(result.summary).toContain("已在现有结果基础上继续拆解");
    expect(result.data?.videoProject?.scenes.map((scene) => scene.segmentLabel)).toEqual(["1-1", "2-1"]);
  });

  it("automatically switches to retry-missing mode when saved scenes only cover part of the script", async () => {
    const existingScene = {
      id: "scene-existing",
      sceneNumber: 1,
      sceneName: "Episode 1 Scene",
      description: "Already decomposed.",
      characters: [],
      dialogue: "",
      cameraDirection: "",
      duration: 5,
      segmentLabel: "1-1",
    };
    invokeFunction.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      if (name !== "script-decompose") {
        throw new Error(`unexpected function: ${name}`);
      }
      expect(body.retryMissingEpisodes).toBe(true);
      expect(body.existingScenes).toEqual([existingScene]);
      return {
        data: {
          scenes: [existingScene],
        },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        script: "第1集：开端\n正文\n\n---\n\n第2集：推进\n正文",
        scenes: [existingScene],
        preferredEpisodeDurationSeconds: 60,
        scriptBreakdownPassed: false,
      }),
    );

    await analyzeScriptForVideoAction({}, runtime);
  });

  it("keeps the storyboard breakdown summary in the completion message after script decomposition", async () => {
    invokeFunction.mockResolvedValue({
      data: {
        scenes: [
          {
            sceneNumber: 1,
            sceneName: "Episode 1 Scene",
            description: "Rain chase opening",
            characters: ["Hero"],
            dialogue: "Run.",
            cameraDirection: "wide shot",
            duration: 5,
            segmentLabel: "1-1",
          },
        ],
      },
      error: null,
    });

    const runtime = createRuntime(
      createVideoProject({
        title: "Breakdown Summary Project",
        script: "Episode 1 script body",
        scenes: [],
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "Lead character",
            imageUrl: "",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        sceneSettings: [],
        currentStep: 1,
      }),
    );

    const result = await analyzeScriptForVideoAction({}, runtime);

    expect(result.summary).toContain("已完成《Breakdown Summary Project》的视频镜头拆解，共 1 个镜头。");
    expect(result.summary).toContain("```json");
    expect(result.summary).toContain("\"episodes\"");
    expect(result.summary).toContain("Episode 1 Scene");
  });

  it("reports command-style progress while decomposing script episodes", async () => {
    invokeFunction.mockImplementation(async (_name: string, _body: Record<string, unknown>, options?: {
      onProgress?: (partial: Record<string, unknown>) => void;
    }) => {
      options?.onProgress?.({
        scenes: [],
        chunkIndex: -1,
        totalChunks: 3,
        status: "init",
        failedChunks: [],
      });
      options?.onProgress?.({
        scenes: [],
        chunkIndex: 0,
        totalChunks: 3,
        status: "processing",
        failedChunks: [],
      });
      options?.onProgress?.({
        scenes: [
          {
            sceneNumber: 1,
            sceneName: "Scene 1",
            description: "Done.",
            characters: [],
            dialogue: "",
            cameraDirection: "",
            duration: 5,
            segmentLabel: "1-1",
          },
        ],
        chunkIndex: 0,
        totalChunks: 3,
        status: "done",
        failedChunks: [],
      });
      return {
        data: {
          scenes: [
            {
              sceneNumber: 1,
              sceneName: "Scene 1",
              description: "Done.",
              characters: [],
              dialogue: "",
              cameraDirection: "",
              duration: 5,
              segmentLabel: "1-1",
            },
          ],
        },
        error: null,
      };
    });

    const onProgress = vi.fn();
    const runtime = createRuntime(createVideoProject({ script: "第 1 集\n正文\n\n第 2 集\n正文\n\n第 3 集\n正文" }));

    await analyzeScriptForVideoAction({}, runtime, onProgress);

    const summaries = onProgress.mock.calls.map((call) => call[0]?.summary).filter(Boolean);
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.stringContaining("[...]"),
        expect.stringContaining("[>..]"),
        expect.stringContaining("[#..]"),
      ]),
    );
    const progressVideoProjects = onProgress.mock.calls
      .map((call) => call[0]?.data?.videoProject)
      .filter(Boolean);
    expect(progressVideoProjects.length).toBeGreaterThan(0);
    expect(progressVideoProjects.at(-1)?.scenes.map((scene) => scene.segmentLabel)).toEqual(["1-1"]);
  });

  it("reports command-style progress while generating missing segment prompts", async () => {
    invokeFunction.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      if (name !== "enhance-video-prompt") {
        throw new Error(`unexpected function: ${name}`);
      }
      return {
        data: {
          prompt: buildMockStructuredSegmentPrompt(body),
          duration: 15,
        },
        error: null,
      };
    });

    const onProgress = vi.fn();
    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            description: "Scene 1 description",
            characters: [],
            dialogue: "",
            cameraDirection: "",
            duration: 5,
            segmentLabel: "1-1",
            enhancedVideoPrompt: "Ready prompt",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "Scene 2",
            description: "Scene 2 description",
            characters: [],
            dialogue: "",
            cameraDirection: "",
            duration: 5,
            segmentLabel: "1-2",
            enhancedVideoPrompt: "Ready prompt",
          },
        ],
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "Existing segment prompt",
            duration: 15,
            targetDuration: 15,
            modelKey: "seedance-lite",
            maxDurationForModel: 15,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    await prepareSegmentVideoPromptAction({ batchMode: "remaining" }, runtime, onProgress);

    const summaries = onProgress.mock.calls.map((call) => call[0]?.summary).filter(Boolean);
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.stringContaining("[#.]"),
        expect.stringContaining("[#>]"),
        expect.stringContaining("[##]"),
      ]),
    );
  });

  it("resets command-style progress while regenerating all existing segment prompts", async () => {
    invokeFunction.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      if (name !== "enhance-video-prompt") {
        throw new Error(`unexpected function: ${name}`);
      }
      return {
        data: {
          prompt: buildMockStructuredSegmentPrompt(body),
          duration: 15,
        },
        error: null,
      };
    });

    const onProgress = vi.fn();
    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            description: "Scene 1 description",
            characters: [],
            dialogue: "",
            cameraDirection: "",
            duration: 5,
            segmentLabel: "1-1",
            enhancedVideoPrompt: "Ready prompt",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "Scene 2",
            description: "Scene 2 description",
            characters: [],
            dialogue: "",
            cameraDirection: "",
            duration: 5,
            segmentLabel: "1-2",
            enhancedVideoPrompt: "Ready prompt",
          },
        ],
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "Existing segment prompt 1",
            duration: 15,
            targetDuration: 15,
            modelKey: "seedance-lite",
            maxDurationForModel: 15,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
          "1-2": {
            segmentLabel: "1-2",
            prompt: "Existing segment prompt 2",
            duration: 15,
            targetDuration: 15,
            modelKey: "seedance-lite",
            maxDurationForModel: 15,
            sceneIds: ["scene-2"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    await prepareSegmentVideoPromptAction({ batchMode: "all" }, runtime, onProgress);

    const summaries = onProgress.mock.calls.map((call) => call[0]?.summary).filter(Boolean);
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.stringContaining("[..]"),
        expect.stringContaining("[>.]"),
        expect.stringContaining("[#.]"),
        expect.stringContaining("[#>]"),
        expect.stringContaining("[##]"),
      ]),
    );
  });

  it("reports command-style progress while restarting batch segment prompt refresh from the first segment", async () => {
    invokeFunction.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      if (name !== "enhance-video-prompt") {
        throw new Error(`unexpected function: ${name}`);
      }
      return {
        data: {
          prompt: buildMockStructuredSegmentPrompt(body),
          duration: 15,
        },
        error: null,
      };
    });

    const onProgress = vi.fn();
    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            description: "Scene 1 description",
            characters: [],
            dialogue: "",
            cameraDirection: "",
            duration: 5,
            segmentLabel: "1-1",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "Scene 2",
            description: "Scene 2 description",
            characters: [],
            dialogue: "",
            cameraDirection: "",
            duration: 5,
            segmentLabel: "1-2",
          },
        ],
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "Existing segment prompt 1",
            duration: 15,
            targetDuration: 15,
            modelKey: "seedance-lite",
            maxDurationForModel: 15,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
          "1-2": {
            segmentLabel: "1-2",
            prompt: "Existing segment prompt 2",
            duration: 15,
            targetDuration: 15,
            modelKey: "seedance-lite",
            maxDurationForModel: 15,
            sceneIds: ["scene-2"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    const result = await prepareSegmentVideoPromptAction({ batchMode: "batch-refresh" }, runtime, onProgress);

    const summaries = onProgress.mock.calls.map((call) => call[0]?.summary).filter(Boolean);
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.stringContaining("[..]"),
        expect.stringContaining("[>.]"),
        expect.stringContaining("[#.]"),
      ]),
    );
    const segmentCalls = invokeFunction.mock.calls.filter(([, body]) => body?.mode === "segment");
    expect(segmentCalls).toHaveLength(1);
    expect(segmentCalls[0]?.[1]?.segmentLabel).toBe("1-1");
    expect(result.data?.videoProject?.segmentPromptRefreshCursor).toBe("1-2");
    expect(result.summary).toContain("下次点击“重新分批生成片段”会继续处理片段 1-2");
    expect(result.summary).toContain("本轮重刷进度：1 / 2");
  });

  it("reports command-style progress while generating the next episode shot prompts", async () => {
    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "enhance-video-prompt") {
        throw new Error(`unexpected function: ${name}`);
      }
      return {
        data: {
          enhanced: "Shot prompt",
          duration: 6,
        },
        error: null,
      };
    });

    const scenes = [
      {
        id: "scene-1",
        sceneNumber: 1,
        sceneName: "Scene 1",
        description: "Scene 1 description",
        characters: [],
        dialogue: "",
        cameraDirection: "",
        duration: 5,
        segmentLabel: "1-1",
        enhancedVideoPrompt: "Ready prompt",
      },
      {
        id: "scene-2",
        sceneNumber: 2,
        sceneName: "Scene 2",
        description: "Scene 2 description",
        characters: [],
        dialogue: "",
        cameraDirection: "",
        duration: 5,
        segmentLabel: "2-1",
      },
      {
        id: "scene-3",
        sceneNumber: 3,
        sceneName: "Scene 3",
        description: "Scene 3 description",
        characters: [],
        dialogue: "",
        cameraDirection: "",
        duration: 5,
        segmentLabel: "2-2",
      },
    ] as PersistedVideoProject["scenes"];
    const shotPackets = scenes.map((scene) => ({
      id: `packet-${scene.id}`,
      sceneId: scene.id,
      sceneNumber: scene.sceneNumber,
      title: scene.sceneName,
      durationSec: 5,
      camera: { shotSize: "standard", movement: "static" },
      characterRefs: [],
      sourceAssetIds: [],
      promptSeed: `p${scene.sceneNumber}`,
      forbiddenChanges: [],
      renderMode: "text2video" as const,
      reviewStatus: "pending" as const,
    })) as PersistedVideoProject["shotPackets"];

    const onProgress = vi.fn();
    const runtime = createRuntime(
      createVideoProject({
        scenes,
        shotPackets,
        videoGenerationPrefs: normalizeVideoGenerationPrefs({ mode: "text-to-video" }),
        videoPromptBatch: "",
      }),
    );

    await prepareVideoPromptBatchAction(
      { batchMode: "all", videoGenerationPrefs: { mode: "text-to-video" } },
      runtime,
      onProgress,
    );

    const summaries = onProgress.mock.calls.map((call) => call[0]?.summary).filter(Boolean);
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.stringContaining("[#.]"),
        expect.stringContaining("[#>]"),
        expect.stringContaining("[##]"),
      ]),
    );
  });

  it("reports command-style progress while generating the next segment shot prompts", async () => {
    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "enhance-video-prompt") {
        throw new Error(`unexpected function: ${name}`);
      }
      return {
        data: {
          enhanced: "Shot prompt",
          duration: 6,
        },
        error: null,
      };
    });

    const scenes = [
      {
        id: "scene-1",
        sceneNumber: 1,
        sceneName: "Scene 1",
        description: "Scene 1 description",
        characters: [],
        dialogue: "",
        cameraDirection: "",
        duration: 5,
        segmentLabel: "1-1",
        enhancedVideoPrompt: "Ready prompt",
      },
      {
        id: "scene-2",
        sceneNumber: 2,
        sceneName: "Scene 2",
        description: "Scene 2 description",
        characters: [],
        dialogue: "",
        cameraDirection: "",
        duration: 5,
        segmentLabel: "1-2",
      },
      {
        id: "scene-3",
        sceneNumber: 3,
        sceneName: "Scene 3",
        description: "Scene 3 description",
        characters: [],
        dialogue: "",
        cameraDirection: "",
        duration: 5,
        segmentLabel: "1-2",
      },
      {
        id: "scene-4",
        sceneNumber: 4,
        sceneName: "Scene 4",
        description: "Scene 4 description",
        characters: [],
        dialogue: "",
        cameraDirection: "",
        duration: 5,
        segmentLabel: "1-3",
      },
    ] as PersistedVideoProject["scenes"];
    const shotPackets = scenes.map((scene) => ({
      id: `packet-${scene.id}`,
      sceneId: scene.id,
      sceneNumber: scene.sceneNumber,
      title: scene.sceneName,
      durationSec: 5,
      camera: { shotSize: "standard", movement: "static" },
      characterRefs: [],
      sourceAssetIds: [],
      promptSeed: `p${scene.sceneNumber}`,
      forbiddenChanges: [],
      renderMode: "text2video" as const,
      reviewStatus: "pending" as const,
    })) as PersistedVideoProject["shotPackets"];

    const onProgress = vi.fn();
    const runtime = createRuntime(
      createVideoProject({
        scenes,
        shotPackets,
        videoGenerationPrefs: normalizeVideoGenerationPrefs({ mode: "text-to-video" }),
        videoPromptBatch: "",
      }),
    );

    await prepareVideoPromptBatchAction(
      { batchMode: "batch", videoGenerationPrefs: { mode: "text-to-video" } },
      runtime,
      onProgress,
    );

    const summaries = onProgress.mock.calls.map((call) => call[0]?.summary).filter(Boolean);
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.stringContaining("[#..]"),
        expect.stringContaining("[#>.]"),
        expect.stringContaining("[##.]"),
      ]),
    );
  });

  it("preserves matching entity assets and invalidates stale prompt state after re-extraction", async () => {
    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "extract-characters-scenes") {
        throw new Error(`unexpected function: ${name}`);
      }
      return {
        data: {
          characters: [
            {
              name: "Hero",
              description: "Updated hero description",
              costumes: [{ label: "Battle", description: "Updated battle outfit" }],
            },
          ],
          sceneSettings: [
            {
              name: "Rooftop",
              description: "Updated rooftop description",
              timeVariants: [{ label: "Night", description: "Updated night variant" }],
            },
          ],
        },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Rooftop",
            description: "Hero waits on the rooftop.",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "wide shot",
            duration: 5,
            characterCostumes: { Hero: "costume-1" },
            sceneTimeVariantId: "variant-1",
            enhancedVideoPrompt: "stale enhanced prompt",
            recommendedDuration: 7,
          },
        ],
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "Old hero description",
            imageUrl: "https://example.com/hero.jpg",
            isAIGenerated: true,
            source: "auto",
            costumes: [
              {
                id: "costume-1",
                label: "Battle",
                description: "Old battle outfit",
                imageUrl: "https://example.com/hero-battle.jpg",
                isAIGenerated: true,
              },
            ],
            activeCostumeId: "costume-1",
          },
        ],
        sceneSettings: [
          {
            id: "scene-setting-1",
            name: "Rooftop",
            description: "Old rooftop description",
            imageUrl: "https://example.com/rooftop.jpg",
            isAIGenerated: true,
            source: "auto",
            timeVariants: [
              {
                id: "variant-1",
                label: "Night",
                description: "Old night variant",
                imageUrl: "https://example.com/rooftop-night.jpg",
                isAIGenerated: true,
              },
            ],
            activeTimeVariantId: "variant-1",
          },
        ],
        shotPackets: [{
          id: "packet-1",
          sceneId: "scene-1",
          sceneNumber: 1,
          title: "Rooftop",
          durationSec: 7,
          camera: { shotSize: "wide", movement: "static" },
          characterRefs: [],
          sourceAssetIds: [],
          promptSeed: "stale",
          forbiddenChanges: [],
          renderMode: "img2video",
        }] as PersistedVideoProject["shotPackets"],
        videoPromptBatch: "stale prompt batch",
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "stale segment prompt",
            duration: 15,
            targetDuration: 15,
            modelKey: "seedance-lite",
            maxDurationForModel: 15,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
        reviewQueue: [{
          id: "review-1",
          title: "Old review",
          summary: "Old packet review",
          targetIds: ["packet-1"],
          status: "pending",
          createdAt: "2026-04-03T00:00:00.000Z",
          updatedAt: "2026-04-03T00:00:00.000Z",
        }],
      }),
    );

    const result = await extractVideoEntitiesAction({}, runtime);
    const nextProject = result.data?.videoProject;

    expect(nextProject?.characters[0]).toEqual(
      expect.objectContaining({
        id: "char-1",
        name: "Hero",
        description: "Updated hero description",
        imageUrl: "https://example.com/hero.jpg",
        activeCostumeId: "costume-1",
      }),
    );
    expect(nextProject?.characters[0]?.costumes?.[0]).toEqual(
      expect.objectContaining({
        id: "costume-1",
        label: "Battle",
        description: "Updated battle outfit",
        imageUrl: "https://example.com/hero-battle.jpg",
      }),
    );
    expect(nextProject?.sceneSettings[0]).toEqual(
      expect.objectContaining({
        id: "scene-setting-1",
        name: "Rooftop",
        description: "Updated rooftop description",
        imageUrl: "https://example.com/rooftop.jpg",
        activeTimeVariantId: "variant-1",
      }),
    );
    expect(nextProject?.sceneSettings[0]?.timeVariants?.[0]).toEqual(
      expect.objectContaining({
        id: "variant-1",
        label: "Night",
        description: "Updated night variant",
        imageUrl: "https://example.com/rooftop-night.jpg",
      }),
    );
    expect(nextProject?.scenes[0]?.characterCostumes).toEqual({ Hero: "costume-1" });
    expect(nextProject?.scenes[0]?.sceneTimeVariantId).toBe("variant-1");
    expect(nextProject?.scenes[0]?.enhancedVideoPrompt).toBeUndefined();
    expect(nextProject?.scenes[0]?.recommendedDuration).toBeUndefined();
    expect(nextProject?.shotPackets).toEqual([]);
    expect(nextProject?.videoPromptBatch).toBe("");
    expect(nextProject?.segmentVideoPrompts).toEqual({});
    expect(nextProject?.reviewQueue).toEqual([]);
  });

  it("keeps existing entity variants when re-extraction omits them", async () => {
    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "extract-characters-scenes") {
        throw new Error(`unexpected function: ${name}`);
      }
      return {
        data: {
          characters: [
            {
              name: "Hero",
              description: "Updated hero description",
              costumes: [{ label: "Battle", description: "Updated battle outfit" }],
            },
          ],
          sceneSettings: [
            {
              name: "Rooftop",
              description: "Updated rooftop description",
              timeVariants: [{ label: "Night", description: "Updated night variant" }],
            },
          ],
        },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Rooftop",
            description: "Hero waits on the rooftop.",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "wide shot",
            duration: 5,
            characterCostumes: { Hero: "costume-2" },
            sceneTimeVariantId: "variant-2",
          },
        ],
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "Old hero description",
            imageUrl: "https://example.com/hero.jpg",
            isAIGenerated: true,
            source: "auto",
            costumes: [
              {
                id: "costume-1",
                label: "Battle",
                description: "Old battle outfit",
                imageUrl: "https://example.com/hero-battle.jpg",
                isAIGenerated: true,
              },
              {
                id: "costume-2",
                label: "Gala",
                description: "Existing gala outfit",
                imageUrl: "https://example.com/hero-gala.jpg",
                isAIGenerated: true,
              },
            ],
            activeCostumeId: "costume-2",
          },
          {
            id: "char-2",
            name: "Mentor",
            description: "Existing mentor description",
            imageUrl: "https://example.com/mentor.jpg",
            isAIGenerated: true,
            source: "auto",
          },
        ],
        sceneSettings: [
          {
            id: "scene-setting-1",
            name: "Rooftop",
            description: "Old rooftop description",
            imageUrl: "https://example.com/rooftop.jpg",
            isAIGenerated: true,
            source: "auto",
            timeVariants: [
              {
                id: "variant-1",
                label: "Night",
                description: "Old night variant",
                imageUrl: "https://example.com/rooftop-night.jpg",
                isAIGenerated: true,
              },
              {
                id: "variant-2",
                label: "Rain",
                description: "Existing rain variant",
                imageUrl: "https://example.com/rooftop-rain.jpg",
                isAIGenerated: true,
              },
            ],
            activeTimeVariantId: "variant-2",
          },
          {
            id: "scene-setting-2",
            name: "Lobby",
            description: "Existing lobby description",
            imageUrl: "https://example.com/lobby.jpg",
            isAIGenerated: true,
            source: "auto",
          },
        ],
      }),
    );

    const result = await extractVideoEntitiesAction({}, runtime);
    const nextProject = result.data?.videoProject;

    expect(nextProject?.characters.map((character) => character.name)).toEqual(["Hero", "Mentor"]);
    expect(nextProject?.characters[0]?.costumes?.map((costume) => costume.label)).toEqual(["Battle", "Gala"]);
    expect(nextProject?.characters[0]?.costumes?.[1]).toEqual(
      expect.objectContaining({
        id: "costume-2",
        imageUrl: "https://example.com/hero-gala.jpg",
      }),
    );
    expect(nextProject?.characters[0]?.activeCostumeId).toBe("costume-2");
    expect(nextProject?.sceneSettings.map((sceneSetting) => sceneSetting.name)).toEqual(["Rooftop", "Lobby"]);
    expect(nextProject?.sceneSettings[0]?.timeVariants?.map((variant) => variant.label)).toEqual(["Night", "Rain"]);
    expect(nextProject?.sceneSettings[0]?.timeVariants?.[1]).toEqual(
      expect.objectContaining({
        id: "variant-2",
        imageUrl: "https://example.com/rooftop-rain.jpg",
      }),
    );
    expect(nextProject?.sceneSettings[0]?.activeTimeVariantId).toBe("variant-2");
    expect(nextProject?.scenes[0]?.characterCostumes).toEqual({ Hero: "costume-2" });
    expect(nextProject?.scenes[0]?.sceneTimeVariantId).toBe("variant-2");
    expect(result.summary).toContain("另外识别出 2 个角色变体与 2 个场景变体");
  });

  it("normalizes decomposition-style costume and scene variant labels back to stored asset ids", async () => {
    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "extract-characters-scenes") {
        throw new Error(`unexpected function: ${name}`);
      }
      return {
        data: {
          characters: [
            {
              name: "林霄",
              description: "Updated hero description",
              costumes: [{ label: "战损黑衣", description: "Updated battle outfit" }],
            },
          ],
          sceneSettings: [
            {
              name: "天台",
              description: "Updated rooftop description",
              timeVariants: [{ label: "暴雨夜", description: "Updated night variant" }],
            },
          ],
        },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "天台",
            description: "林霄穿着战损黑衣站在暴雨夜的天台上。",
            characters: ["林霄"],
            dialogue: "",
            cameraDirection: "wide shot",
            duration: 5,
            characterCostumes: { 林霄: "战损黑衣" },
            sceneTimeVariantId: "暴雨夜",
          },
        ],
        characters: [
          {
            id: "char-1",
            name: "林霄",
            description: "Old hero description",
            isAIGenerated: true,
            source: "auto",
            costumes: [
              {
                id: "costume-1",
                label: "战损黑衣",
                description: "Old battle outfit",
                isAIGenerated: true,
              },
            ],
            activeCostumeId: "costume-1",
          },
        ],
        sceneSettings: [
          {
            id: "scene-setting-1",
            name: "天台",
            description: "Old rooftop description",
            isAIGenerated: true,
            source: "auto",
            timeVariants: [
              {
                id: "variant-1",
                label: "暴雨夜",
                description: "Old night variant",
                isAIGenerated: true,
              },
            ],
            activeTimeVariantId: "variant-1",
          },
        ],
      }),
    );

    const result = await extractVideoEntitiesAction({}, runtime);
    const nextProject = result.data?.videoProject;

    expect(nextProject?.scenes[0]?.characterCostumes).toEqual({ 林霄: "costume-1" });
    expect(nextProject?.scenes[0]?.sceneTimeVariantId).toBe("variant-1");
  });

  it("merges equivalent entity variants without endlessly appending AI relabels", async () => {
    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "extract-characters-scenes") {
        throw new Error(`unexpected function: ${name}`);
      }
      return {
        data: {
          characters: [
            {
              name: "苏浅浅",
              description: "Updated lead description",
              costumes: [
                { label: "廉价婚纱", description: "白色婚纱，质感廉价" },
                { label: "暗红色旗袍", description: "暗红色旗袍" },
                { label: "旗袍", description: "重复的旗袍描述" },
                { label: "日常装", description: "居家日常穿搭" },
              ],
            },
          ],
          sceneSettings: [
            {
              name: "苏家客厅",
              description: "Updated living room description",
              timeVariants: [
                { label: "白天", description: "白天自然光" },
                { label: "雷雨夜", description: "雷声与雨夜氛围" },
                { label: "雨夜", description: "重复的雨夜描述" },
              ],
            },
          ],
        },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        characters: [
          {
            id: "char-1",
            name: "苏浅浅",
            description: "Old lead description",
            imageUrl: "https://example.com/su.jpg",
            isAIGenerated: true,
            source: "auto",
            costumes: [
              { id: "cost-1", label: "婚纱", description: "旧婚纱描述", imageUrl: "https://example.com/wedding.jpg", isAIGenerated: true },
              { id: "cost-2", label: "旗袍", description: "旧旗袍描述", imageUrl: "https://example.com/qipao.jpg", isAIGenerated: true },
              { id: "cost-3", label: "日常装", description: "旧日常装描述", isAIGenerated: false },
            ],
          },
        ],
        sceneSettings: [
          {
            id: "scene-setting-1",
            name: "苏家客厅",
            description: "Old living room description",
            imageUrl: "https://example.com/living-room.jpg",
            isAIGenerated: true,
            source: "auto",
            timeVariants: [
              { id: "time-1", label: "日间", description: "旧日间描述", imageUrl: "https://example.com/day.jpg", isAIGenerated: true },
              { id: "time-2", label: "雨夜", description: "旧雨夜描述", imageUrl: "https://example.com/rain-night.jpg", isAIGenerated: true },
            ],
          },
        ],
      }),
    );

    const result = await extractVideoEntitiesAction({}, runtime);
    const nextProject = result.data?.videoProject;

    expect(nextProject?.characters[0]?.costumes?.map((variant) => variant.id)).toEqual(["cost-1", "cost-2", "cost-3"]);
    expect(nextProject?.characters[0]?.costumes?.map((variant) => variant.label)).toEqual(["婚纱", "旗袍", "日常装"]);
    expect(nextProject?.characters[0]?.costumes?.[0]?.description).toBe("白色婚纱，质感廉价");
    expect(nextProject?.characters[0]?.costumes?.[1]?.description).toBe("重复的旗袍描述");
    expect(nextProject?.sceneSettings[0]?.timeVariants?.map((variant) => variant.id)).toEqual(["time-1", "time-2"]);
    expect(nextProject?.sceneSettings[0]?.timeVariants?.map((variant) => variant.label)).toEqual(["日间", "雨夜"]);
    expect(nextProject?.sceneSettings[0]?.timeVariants?.[1]?.description).toBe("雷声与雨夜氛围");
    expect(result.summary).toContain("另外识别出 3 个角色变体与 2 个场景变体");
  });

  it("drops baseline and low-signal variants while collapsing near-duplicate labels", async () => {
    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "extract-characters-scenes") {
        throw new Error(`unexpected function: ${name}`);
      }
      return {
        data: {
          characters: [
            {
              name: "林霄",
              description: "Updated immortal lead description",
              costumes: [
                { label: "常态", description: "默认外观" },
                { label: "神化状态", description: "银白长发，额心神纹浮现，衣袍泛起金光" },
                { label: "新神姿态", description: "神化后的重复命名" },
                { label: "初期杂役", description: "前期身份称呼，没有稳定妆造差异" },
              ],
            },
            {
              name: "顾长风",
              description: "Updated rival description",
              costumes: [
                { label: "华服", description: "暗金刺绣华服" },
                { label: "锦衣华服", description: "更完整的华服描述" },
                { label: "战损", description: "肩甲碎裂，衣摆染血" },
                { label: "战损疲惫态", description: "同一套战损外观的重复命名" },
                { label: "修为尽散", description: "仅剧情状态，没有明确外观锚点" },
              ],
            },
            {
              name: "叶清寒",
              description: "Updated saintess description",
              costumes: [
                { label: "圣女装", description: "银白圣袍与玉冠" },
                { label: "清冷圣女", description: "只是气质描述" },
                { label: "狂热臣服", description: "只是情绪与立场描述" },
              ],
            },
          ],
          sceneSettings: [
            {
              name: "天玄宗广场",
              description: "Updated plaza description",
              timeVariants: [
                { label: "日常", description: "默认广场状态" },
                { label: "战斗后", description: "地砖碎裂、尘烟未散、残旗倒伏" },
                { label: "战后废墟", description: "同一场景损毁状态的重复命名" },
              ],
            },
          ],
        },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        characters: [
          {
            id: "char-1",
            name: "林霄",
            description: "Old immortal lead description",
            isAIGenerated: false,
            source: "auto",
          },
          {
            id: "char-2",
            name: "顾长风",
            description: "Old rival description",
            isAIGenerated: false,
            source: "auto",
          },
          {
            id: "char-3",
            name: "叶清寒",
            description: "Old saintess description",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        sceneSettings: [
          {
            id: "scene-setting-1",
            name: "天玄宗广场",
            description: "Old plaza description",
            isAIGenerated: false,
            source: "auto",
          },
        ],
      }),
    );

    const result = await extractVideoEntitiesAction({}, runtime);
    const nextProject = result.data?.videoProject;

    expect(nextProject?.characters.find((character) => character.name === "林霄")?.costumes?.map((variant) => variant.label))
      .toEqual(["神化状态"]);
    expect(nextProject?.characters.find((character) => character.name === "顾长风")?.costumes?.map((variant) => variant.label))
      .toEqual(["华服", "战损"]);
    expect(nextProject?.characters.find((character) => character.name === "叶清寒")?.costumes?.map((variant) => variant.label))
      .toEqual(["圣女装"]);
    expect(nextProject?.sceneSettings[0]?.timeVariants?.map((variant) => variant.label)).toEqual(["战斗后"]);
    expect(result.summary).toContain("另外识别出 4 个角色变体与 1 个场景变体");
  });

  it("does not collapse bloodied and battle-damaged costume variants into the same extracted key", async () => {
    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "extract-characters-scenes") {
        throw new Error(`unexpected function: ${name}`);
      }
      return {
        data: {
          characters: [
            {
              name: "苏辰",
              description: "重伤但仍在强撑的少年剑修",
              costumes: [
                { label: "战损红衣", description: "衣摆撕裂、肩部破损，露出伤口" },
                { label: "染血红衣", description: "整件红衣被大量鲜血浸透，血迹蔓延到袖口与前襟" },
              ],
            },
          ],
          sceneSettings: [
            {
              name: "演武场",
              description: "尘土飞扬的宗门演武场",
            },
          ],
        },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        characters: [
          {
            id: "char-1",
            name: "苏辰",
            description: "旧角色描述",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        sceneSettings: [
          {
            id: "scene-setting-1",
            name: "演武场",
            description: "旧场景描述",
            isAIGenerated: false,
            source: "auto",
          },
        ],
      }),
    );

    const result = await extractVideoEntitiesAction({}, runtime);
    const nextProject = result.data?.videoProject;

    expect(nextProject?.characters[0]?.costumes?.map((variant) => variant.label)).toEqual([
      "战损红衣",
      "染血红衣",
    ]);
    expect(nextProject?.characters[0]?.costumes?.map((variant) => variant.description)).toEqual([
      "衣摆撕裂、肩部破损，露出伤口",
      "整件红衣被大量鲜血浸透，血迹蔓延到袖口与前襟",
    ]);
  });

  it("dedupes repeated character and scene entities before returning the extracted output", async () => {
    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "extract-characters-scenes") {
        throw new Error(`unexpected function: ${name}`);
      }
      return {
        data: {
          characters: [
            {
              name: "苏浅浅",
              description: "Updated lead description",
              costumes: [
                { label: "婚纱", description: "白色婚纱" },
                { label: "常态", description: "默认形象" },
              ],
            },
            {
              name: "苏浅浅",
              description: "Updated lead description with pearl veil",
              costumes: [
                { label: "廉价婚纱", description: "带珍珠头纱的完整婚纱版本" },
                { label: "初始状态", description: "不应作为变体保留" },
              ],
            },
          ],
          sceneSettings: [
            {
              name: "苏家客厅",
              description: "Updated living room description",
              timeVariants: [
                { label: "雨夜", description: "夜间落雨的客厅" },
                { label: "日常", description: "默认客厅状态" },
              ],
            },
            {
              name: "苏家客厅",
              description: "Updated living room description with shattered window",
              timeVariants: [
                { label: "雷雨夜", description: "窗外电闪雷鸣，碎玻璃反光" },
              ],
            },
          ],
        },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "苏家客厅",
            description: "苏浅浅站在客厅中央。",
            characters: ["苏浅浅"],
            dialogue: "",
            cameraDirection: "wide shot",
            duration: 5,
            characterCostumes: { 苏浅浅: "cost-1" },
            sceneTimeVariantId: "time-1",
          },
        ],
        characters: [
          {
            id: "char-1",
            name: "苏浅浅",
            description: "Old lead description",
            imageUrl: "https://example.com/su.jpg",
            isAIGenerated: true,
            source: "auto",
            costumes: [
              {
                id: "cost-1",
                label: "婚纱",
                description: "旧婚纱描述",
                imageUrl: "https://example.com/wedding.jpg",
                isAIGenerated: true,
              },
            ],
            activeCostumeId: "cost-1",
          },
        ],
        sceneSettings: [
          {
            id: "scene-setting-1",
            name: "苏家客厅",
            description: "Old living room description",
            imageUrl: "https://example.com/living-room.jpg",
            isAIGenerated: true,
            source: "auto",
            timeVariants: [
              {
                id: "time-1",
                label: "雨夜",
                description: "旧雨夜描述",
                imageUrl: "https://example.com/rain-night.jpg",
                isAIGenerated: true,
              },
            ],
            activeTimeVariantId: "time-1",
          },
        ],
      }),
    );

    const result = await extractVideoEntitiesAction({}, runtime);
    const nextProject = result.data?.videoProject;

    expect(nextProject?.characters.map((character) => character.name)).toEqual(["苏浅浅"]);
    expect(nextProject?.characters[0]).toEqual(
      expect.objectContaining({
        id: "char-1",
        description: "Updated lead description with pearl veil",
        imageUrl: "https://example.com/su.jpg",
        activeCostumeId: "cost-1",
      }),
    );
    expect(nextProject?.characters[0]?.costumes).toEqual([
      expect.objectContaining({
        id: "cost-1",
        label: "婚纱",
        description: "带珍珠头纱的完整婚纱版本",
        imageUrl: "https://example.com/wedding.jpg",
      }),
    ]);

    expect(nextProject?.sceneSettings.map((sceneSetting) => sceneSetting.name)).toEqual(["苏家客厅"]);
    expect(nextProject?.sceneSettings[0]).toEqual(
      expect.objectContaining({
        id: "scene-setting-1",
        description: "Updated living room description with shattered window",
        imageUrl: "https://example.com/living-room.jpg",
        activeTimeVariantId: "time-1",
      }),
    );
    expect(nextProject?.sceneSettings[0]?.timeVariants).toEqual([
      expect.objectContaining({
        id: "time-1",
        label: "雨夜",
        description: "窗外电闪雷鸣，碎玻璃反光",
        imageUrl: "https://example.com/rain-night.jpg",
      }),
    ]);
    expect(nextProject?.scenes[0]?.characterCostumes).toEqual({ 苏浅浅: "cost-1" });
    expect(nextProject?.scenes[0]?.sceneTimeVariantId).toBe("time-1");
    expect(result.summary).toContain("已从脚本中提取 1 个角色与 1 个场景设定。");
    expect(result.summary).toContain("另外识别出 1 个角色变体与 1 个场景变体。");
    expect(result.summary).toContain("## 角色清单");
    expect(result.summary).toContain("| 序号 | 角色名 | 描述 | 角色变体 |");
    expect(result.summary).toContain("| 1 | 苏浅浅 |");
    expect(result.summary).toContain("婚纱：带珍珠头纱的完整婚纱版本");
    expect(result.summary).toContain("## 场景清单");
    expect(result.summary).toContain("| 序号 | 场景名 | 描述 | 场景变体 |");
    expect(result.summary).toContain("| 1 | 苏家客厅 |");
    expect(result.summary).toContain("雨夜：窗外电闪雷鸣，碎玻璃反光");
  });

  it("does not merge genuinely different variants from another story", async () => {
    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "extract-characters-scenes") {
        throw new Error(`unexpected function: ${name}`);
      }
      return {
        data: {
          characters: [
            {
              name: "沈砚",
              description: "Updated swordsman description",
              costumes: [
                { label: "红衣", description: "干净红衣" },
                { label: "战损红衣", description: "破损染血红衣" },
                { label: "白衣", description: "白色常服" },
              ],
            },
          ],
          sceneSettings: [
            {
              name: "山门",
              description: "Updated gate description",
              timeVariants: [
                { label: "雨夜", description: "夜间落雨" },
                { label: "雪夜", description: "夜间落雪" },
              ],
            },
          ],
        },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        characters: [
          {
            id: "char-1",
            name: "沈砚",
            description: "Old swordsman description",
            isAIGenerated: false,
            source: "auto",
            costumes: [
              { id: "cost-1", label: "红衣", description: "旧红衣", isAIGenerated: false },
              { id: "cost-2", label: "战损红衣", description: "旧战损红衣", isAIGenerated: false },
            ],
          },
        ],
        sceneSettings: [
          {
            id: "scene-setting-1",
            name: "山门",
            description: "Old gate description",
            isAIGenerated: false,
            source: "auto",
            timeVariants: [
              { id: "time-1", label: "雨夜", description: "旧雨夜", isAIGenerated: false },
            ],
          },
        ],
      }),
    );

    const result = await extractVideoEntitiesAction({}, runtime);
    const nextProject = result.data?.videoProject;

    expect(nextProject?.characters[0]?.costumes?.map((variant) => variant.label)).toEqual(["红衣", "战损红衣", "白衣"]);
    expect(nextProject?.characters[0]?.costumes?.map((variant) => variant.id).slice(0, 2)).toEqual(["cost-1", "cost-2"]);
    expect(nextProject?.sceneSettings[0]?.timeVariants?.map((variant) => variant.label)).toEqual(["雨夜", "雪夜"]);
    expect(nextProject?.sceneSettings[0]?.timeVariants?.[0]?.id).toBe("time-1");
    expect(result.summary).toContain("另外识别出 3 个角色变体与 2 个场景变体");
  });

  it("uses consistency QA to collapse alias variants emitted by the internal review round", async () => {
    let extractionRound = 0;

    invokeFunction.mockImplementation(async (name: string, body?: Record<string, unknown>) => {
      if (name !== "extract-characters-scenes") {
        throw new Error(`unexpected function: ${name}`);
      }

      extractionRound += 1;
      if (extractionRound === 1) {
        return {
          data: {
            characters: [
              {
                name: "苏浅浅",
                description: "Lead bride",
                costumes: [{ label: "婚纱", description: "白色婚纱" }],
              },
            ],
            sceneSettings: [
              {
                name: "苏家客厅",
                description: "客厅里只亮着一盏壁灯",
                timeVariants: [{ label: "雨夜", description: "窗外落雨的夜晚" }],
              },
            ],
          },
          error: null,
        };
      }

      expect(body?.extractionHint).toContain("内部复核");
      return {
        data: {
          characters: [
            {
              name: "苏浅浅",
              description: "Lead bride with pearl veil",
              costumes: [{ label: "少奶奶造型", description: "白色婚纱，带珍珠头纱" }],
            },
          ],
          sceneSettings: [
            {
              name: "苏家客厅",
              description: "玻璃上映着冷色雨光的客厅",
              timeVariants: [{ label: "夜色版", description: "窗外大雨，室内夜间冷色反光" }],
            },
          ],
        },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "苏家客厅",
            description: "苏浅浅站在苏家客厅中央。",
            characters: ["苏浅浅"],
            dialogue: "",
            cameraDirection: "wide shot",
            duration: 5,
          },
        ],
        characters: [],
        sceneSettings: [],
      }),
    );

    const result = await extractVideoEntitiesAction({}, runtime);
    const nextProject = result.data?.videoProject;

    expect(invokeFunction).toHaveBeenCalledTimes(2);
    expect(nextProject?.characters.map((character) => character.name)).toEqual(["苏浅浅"]);
    expect(nextProject?.characters[0]?.description).toBe("Lead bride with pearl veil");
    expect(nextProject?.characters[0]?.costumes).toEqual([
      expect.objectContaining({
        label: "婚纱",
        description: "白色婚纱，带珍珠头纱",
      }),
    ]);
    expect(nextProject?.sceneSettings.map((sceneSetting) => sceneSetting.name)).toEqual(["苏家客厅"]);
    expect(nextProject?.sceneSettings[0]?.description).toBe("玻璃上映着冷色雨光的客厅");
    expect(nextProject?.sceneSettings[0]?.timeVariants).toEqual([
      expect.objectContaining({
        label: "雨夜",
        description: "窗外大雨，室内夜间冷色反光",
      }),
    ]);
    expect(result.summary).toContain("已自动复核 1 轮");
  });

  it("merges decorated entity names from the review round back onto canonical entities", async () => {
    let extractionRound = 0;

    invokeFunction.mockImplementation(async (name: string, body?: Record<string, unknown>) => {
      if (name !== "extract-characters-scenes") {
        throw new Error(`unexpected function: ${name}`);
      }

      extractionRound += 1;
      if (extractionRound === 1) {
        return {
          data: {
            characters: [
              {
                name: "林霄",
                description: "少年剑修",
                costumes: [{ label: "战损黑衣", description: "肩部破损的黑衣" }],
              },
            ],
            sceneSettings: [
              {
                name: "主宅客厅",
                description: "老宅客厅",
                timeVariants: [{ label: "夜间", description: "夜间的客厅" }],
              },
            ],
          },
          error: null,
        };
      }

      expect(body?.extractionHint).toContain("内部复核");
      return {
        data: {
          characters: [
            {
              name: "林霄（战损版）",
              description: "肩部带伤的少年剑修",
              costumes: [{ label: "黑衣作战造型", description: "肩部破损的黑衣，衣摆撕裂" }],
            },
          ],
          sceneSettings: [
            {
              name: "主宅客厅（夜景）",
              description: "熄灯后的客厅只剩窗外夜色",
              timeVariants: [{ label: "夜色客厅", description: "熄灯后的夜间客厅" }],
            },
          ],
        },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "主宅客厅",
            description: "林霄回到主宅客厅。",
            characters: ["林霄"],
            dialogue: "",
            cameraDirection: "wide shot",
            duration: 5,
          },
        ],
        characters: [],
        sceneSettings: [],
      }),
    );

    const result = await extractVideoEntitiesAction({}, runtime);
    const nextProject = result.data?.videoProject;

    expect(nextProject?.characters.map((character) => character.name)).toEqual(["林霄"]);
    expect(nextProject?.characters[0]?.description).toBe("肩部带伤的少年剑修");
    expect(nextProject?.characters[0]?.costumes).toEqual([
      expect.objectContaining({
        label: "战损黑衣",
        description: "肩部破损的黑衣，衣摆撕裂",
      }),
    ]);
    expect(nextProject?.sceneSettings.map((sceneSetting) => sceneSetting.name)).toEqual(["主宅客厅"]);
    expect(nextProject?.sceneSettings[0]?.description).toBe("熄灯后的客厅只剩窗外夜色");
    expect(nextProject?.sceneSettings[0]?.timeVariants).toEqual([
      expect.objectContaining({
        label: "夜间",
        description: "熄灯后的夜间客厅",
      }),
    ]);
    expect(result.summary).toContain("已自动复核 1 轮");
  });

  it("always runs one internal review round even when the first extraction already has full coverage", async () => {
    const extractionHints: string[] = [];

    invokeFunction.mockImplementation(async (name: string, body?: Record<string, unknown>) => {
      if (name !== "extract-characters-scenes") {
        throw new Error(`unexpected function: ${name}`);
      }

      extractionHints.push(typeof body?.extractionHint === "string" ? body.extractionHint : "");
      return {
        data: {
          characters: [
            { name: "Hero", description: "Lead" },
          ],
          sceneSettings: [
            { name: "Rooftop", description: "Night rooftop" },
          ],
        },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Rooftop",
            description: "Hero waits on the rooftop.",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "wide shot",
            duration: 5,
          },
        ],
        characters: [],
        sceneSettings: [],
        currentStep: 2,
      }),
    );

    const result = await extractVideoEntitiesAction({}, runtime);
    const nextProject = result.data?.videoProject;

    expect(invokeFunction).toHaveBeenCalledTimes(2);
    expect(extractionHints[0]).toBe("");
    expect(extractionHints[1]).toContain("内部复核");
    expect(extractionHints[1]).toContain("已经写出的剧本正文内容");
    expect(extractionHints[1]).toContain("过滤旁白/画外音/VO/OS");
    expect(extractionHints[1]).not.toContain("仍缺少的角色");
    expect(nextProject?.characters.map((character) => character.name)).toEqual(["Hero"]);
    expect(nextProject?.sceneSettings.map((sceneSetting) => sceneSetting.name)).toEqual(["Rooftop"]);
    expect(result.summary).toContain("已自动复核 1 轮");
  });

  it("auto-runs one targeted make-up round when scene-derived entities are still missing", async () => {
    invokeFunction.mockImplementation(async (name: string, body?: Record<string, unknown>) => {
      if (name !== "extract-characters-scenes") {
        throw new Error(`unexpected function: ${name}`);
      }

      const extractionHint = typeof body?.extractionHint === "string" ? body.extractionHint : "";
      if (!extractionHint) {
        return {
          data: {
            characters: [
              { name: "Hero", description: "Lead" },
            ],
            sceneSettings: [
              { name: "Rooftop", description: "Night rooftop" },
            ],
          },
          error: null,
        };
      }

      expect(extractionHint).toContain("Mentor");
      expect(extractionHint).toContain("Lobby");
      return {
        data: {
          characters: [
            { name: "Mentor", description: "Guide" },
          ],
          sceneSettings: [
            { name: "Lobby", description: "Hotel lobby" },
          ],
        },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Rooftop",
            description: "Hero waits on the rooftop.",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "wide shot",
            duration: 5,
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "Lobby",
            description: "Mentor arrives in the lobby.",
            characters: ["Mentor"],
            dialogue: "",
            cameraDirection: "medium shot",
            duration: 5,
          },
        ],
        characters: [],
        sceneSettings: [],
        currentStep: 2,
      }),
    );

    const result = await extractVideoEntitiesAction({}, runtime);
    const nextProject = result.data?.videoProject;

    expect(invokeFunction).toHaveBeenCalledTimes(2);
    expect(nextProject?.characters.map((character) => character.name)).toEqual(["Hero", "Mentor"]);
    expect(nextProject?.sceneSettings.map((sceneSetting) => sceneSetting.name)).toEqual(["Rooftop", "Lobby"]);
    expect(result.summary).toContain("已自动补漏 1 轮");
  });

  it("stops early and appends placeholder entities when the make-up round still makes no progress", async () => {
    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "extract-characters-scenes") {
        throw new Error(`unexpected function: ${name}`);
      }

      return {
        data: {
          characters: [
            { name: "Hero", description: "Lead" },
          ],
          sceneSettings: [],
        },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Rooftop",
            description: "Hero waits on the rooftop.",
            characters: ["Hero", "Mentor"],
            dialogue: "",
            cameraDirection: "wide shot",
            duration: 5,
          },
        ],
        characters: [],
        sceneSettings: [],
        currentStep: 2,
      }),
    );

    const result = await extractVideoEntitiesAction({}, runtime);
    const nextProject = result.data?.videoProject;

    expect(invokeFunction).toHaveBeenCalledTimes(2);
    expect(nextProject?.characters.map((character) => character.name)).toEqual(["Hero", "Mentor"]);
    expect(nextProject?.characters[1]).toEqual(
      expect.objectContaining({
        name: "Mentor",
        description: "AI 暂未补充该项描述，请根据剧本继续完善。",
      }),
    );
    expect(nextProject?.sceneSettings[0]).toEqual(
      expect.objectContaining({
        name: "Rooftop",
        description: "AI 暂未补充该项描述，请根据剧本继续完善。",
      }),
    );
    expect(result.summary).toContain("根据镜头草稿自动补入 1 个角色和 1 个场景待完善项");
  });

  it("allows shot-packet compilation once at least one storyboard frame exists and keeps the workflow on step three", async () => {
    const runtime = createRuntime(
      createVideoProject({
        currentStep: 3,
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "image-to-video",
        },
        storyboardPlan: "镜头 1：雨夜追击\n镜头 2：追兵逼近",
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            description: "Lead runs through the alley.",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "tracking shot",
            duration: 5,
            storyboardUrl: "https://media.storyforge.test/storyboard-1.jpg",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "Scene 2",
            description: "Pursuers appear at the end of the alley.",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "wide shot",
            duration: 5,
            storyboardUrl: "",
          },
        ],
      }),
    );

    const result = await compileVideoShotPacketsAction({}, runtime);
    expect(result.summary).toContain("已收口 2 个镜头指令包，覆盖镜头 1-2。");
    expect(result.summary).toContain("Scene 1、Scene 2：镜头 1-2，共 2 个");
    expect(result.summary).not.toContain("| 镜头 |");

    expect(result.data?.videoProject?.currentStep).toBe(3);
    expect(result.projectSnapshot?.derivedStage).toBe("分镜图生成");
    expect(result.projectSnapshot?.memory?.shotPackets?.length).toBe(2);
    /*
    expect(result.projectSnapshot?.derivedStage).toBe("视频生成");
    expect(result.projectSnapshot?.memory?.shotPackets?.length).toBe(2);
    expect(result.summary).toContain("## 镜头指令包摘要（2）");
    expect(result.summary).toContain("| 镜头 | 标题 | 时长 | 模式 | 角色 | 场景 |");
    expect(result.summary).toContain("Scene 1");
    */
  });

  it("clears stale shot packets and prompt batches after storyboard refresh so later recompiles use the latest frame", async () => {
    invokeFunction.mockResolvedValue({
      data: { imageUrl: "https://example.com/storyboard-new.jpg" },
      error: null,
    });

    const runtime = createRuntime(
      createVideoProject({
        currentStep: 4,
        storyboardPlan: "镜头 1：雨夜追击",
        videoPromptBatch: "旧提示词批次",
        shotPackets: [{ id: "packet-1" }] as PersistedVideoProject["shotPackets"],
        reviewQueue: [{ id: "review-1", title: "review", summary: "summary", targetIds: ["packet-1"], status: "pending", createdAt: "2026-04-03T00:00:00.000Z", updatedAt: "2026-04-03T00:00:00.000Z" }] as PersistedVideoProject["reviewQueue"],
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            description: "Lead runs through the alley.",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "tracking shot",
            duration: 5,
            storyboardUrl: "https://example.com/storyboard-old.jpg",
          },
        ],
      }),
    );

    const result = await generateStoryboardFramesAction(
      { targetIds: ["scene-1"], forceRegenerate: true },
      runtime,
    );

    expect(result.data?.videoProject?.shotPackets).toEqual([]);
    expect(result.data?.videoProject?.videoPromptBatch).toBe("");
    expect(result.data?.videoProject?.scenes[0]?.storyboardUrl).toBe("https://example.com/storyboard-new.jpg");
  });

  it("shows a minimal markdown table after preparing the video prompt batch without exposing prompt body text", async () => {
    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "enhance-video-prompt") {
        throw new Error(`unexpected function: ${name}`);
      }
      return {
        data: {
          enhanced: "这里是很长的提示词正文，不应该直接展示在聊天摘要里。",
          duration: 6,
          durationReason: "按镜头复杂度估算",
        },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        currentStep: 4,
        shotPackets: [{
          id: "packet-1",
          sceneId: "scene-1",
          sceneNumber: 1,
          title: "雨夜追击",
          durationSec: 5,
          camera: {
            shotSize: "标准镜头",
            movement: "中景跟拍",
          },
          characterRefs: [],
          sourceAssetIds: [],
          promptSeed: "old prompt",
          forbiddenChanges: [],
          renderMode: "img2video",
          reviewStatus: "pending",
        }] as PersistedVideoProject["shotPackets"],
      }),
    );

    const result = await prepareVideoPromptBatchAction({}, runtime);

    expect(result.summary).toContain("已收口 1 个镜头的视频提示词批次，覆盖镜头 1-1。");
    expect(result.summary).toContain("雨夜追击（已覆盖 1 / 待生成 0 / 总数 1）");
    expect(result.summary).toContain("雨夜追击");
    expect(result.summary).not.toContain("这里是很长的提示词正文");
    expect(result.data?.videoProject?.videoPromptBatch).toContain("这里是很长的提示词正文");
  });

  it("groups prompt-batch summary tables by episode heading when segment labels carry episode numbers", async () => {
    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "enhance-video-prompt") {
        throw new Error(`unexpected function: ${name}`);
      }
      return {
        data: {
          enhanced: "full prompt body",
          duration: 6,
        },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        currentStep: 4,
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "仙界·断魂崖",
            description: "scene 1",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "中景",
            duration: 5,
            segmentLabel: "1-1",
            storyboardUrl: "https://media.storyforge.test/storyboard-1.jpg",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "仙界·断魂崖",
            description: "scene 2",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "近景",
            duration: 5,
            segmentLabel: "1-2",
            storyboardUrl: "https://example.com/storyboard-2.jpg",
          },
        ],
        shotPackets: [{
          id: "packet-1",
          sceneId: "scene-1",
          sceneNumber: 1,
          title: "仙界·断魂崖",
          durationSec: 5,
          camera: { shotSize: "标准镜头", movement: "中景" },
          characterRefs: [],
          sourceAssetIds: [],
          promptSeed: "p1",
          forbiddenChanges: [],
          renderMode: "img2video",
          reviewStatus: "pending",
        }, {
          id: "packet-2",
          sceneId: "scene-2",
          sceneNumber: 2,
          title: "仙界·断魂崖",
          durationSec: 5,
          camera: { shotSize: "标准镜头", movement: "近景" },
          characterRefs: [],
          sourceAssetIds: [],
          promptSeed: "p2",
          forbiddenChanges: [],
          renderMode: "img2video",
          reviewStatus: "pending",
        }] as PersistedVideoProject["shotPackets"],
      }),
    );

    const result = await prepareVideoPromptBatchAction({}, runtime);

    expect(result.summary).toContain("已收口 2 个镜头的视频提示词批次，覆盖镜头 1-2。");
    expect(result.summary).toContain("## 第 1 集");
    expect(result.summary).toContain("**片段 1-1（6s）｜仙界·断魂崖");
    expect(result.summary).toContain("**片段 1-2（6s）｜仙界·断魂崖");
  });

  it("uses the full shot-packet set by default when preparing prompt batches manually", async () => {
    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "enhance-video-prompt") {
        throw new Error(`unexpected function: ${name}`);
      }
      return {
        data: {
          enhanced: "full prompt body",
          duration: 6,
        },
        error: null,
      };
    });

    const scenes = Array.from({ length: 5 }, (_, index) => ({
      id: `scene-${index + 1}`,
      sceneNumber: index + 1,
      sceneName: `Scene ${index + 1}`,
      description: `scene ${index + 1}`,
      characters: ["沈昭"],
      dialogue: "",
      cameraDirection: "中景",
      duration: 5,
      storyboardUrl: `https://example.com/storyboard-${index + 1}.jpg`,
    })) as PersistedVideoProject["scenes"];
    const shotPackets = scenes.map((scene) => ({
      id: `packet-${scene.id}`,
      sceneId: scene.id,
      sceneNumber: scene.sceneNumber,
      title: scene.sceneName,
      durationSec: 5,
      camera: { shotSize: "标准镜头", movement: "中景" },
      characterRefs: [],
      sourceAssetIds: [],
      promptSeed: `p${scene.sceneNumber}`,
      forbiddenChanges: [],
      renderMode: "img2video" as const,
      reviewStatus: "pending" as const,
    })) as PersistedVideoProject["shotPackets"];

    const runtime = createRuntime(
      createVideoProject({
        currentStep: 4,
        scenes,
        shotPackets,
      }),
    );

    const result = await prepareVideoPromptBatchAction({}, runtime);

    expect(result.summary).toContain("已生成镜头 1-5 的视频提示词批次。");
    expect(result.summary).toContain("已收口 5 个镜头的视频提示词批次，覆盖镜头 1-5。");
    expect(invokeFunction.mock.calls.filter(([name]) => name === "enhance-video-prompt")).toHaveLength(5);
  });

  it("advances single prompt batches by the next uncovered segment and accumulates covered shots", async () => {
    invokeFunction.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      if (name !== "enhance-video-prompt") {
        throw new Error(`unexpected function: ${name}`);
      }
      return {
        data: {
          enhanced: `enhanced ${body.description}`,
          duration: 6,
        },
        error: null,
      };
    });

    const scenes = Array.from({ length: 5 }, (_, index) => {
      const sceneNumber = index + 1;
      const segmentLabel = sceneNumber <= 2 ? "1-1" : sceneNumber <= 4 ? "1-2" : "1-3";
      return {
        id: `scene-${sceneNumber}`,
        sceneNumber,
        sceneName: `Scene ${sceneNumber}`,
        description: `scene ${sceneNumber}`,
        characters: [],
        dialogue: "",
        cameraDirection: "medium shot",
        duration: 5,
        segmentLabel,
        ...(sceneNumber <= 2
          ? {
              enhancedVideoPrompt: `existing prompt ${sceneNumber}`,
              recommendedDuration: 5,
            }
          : {}),
      };
    }) as PersistedVideoProject["scenes"];
    const shotPackets = scenes.map((scene) => ({
      id: `packet-${scene.id}`,
      sceneId: scene.id,
      sceneNumber: scene.sceneNumber,
      title: scene.sceneName,
      durationSec: 5,
      camera: { shotSize: "standard", movement: "static" },
      characterRefs: [],
      sourceAssetIds: [],
      promptSeed: `p${scene.sceneNumber}`,
      forbiddenChanges: [],
      renderMode: "text2video" as const,
      reviewStatus: "pending" as const,
    })) as PersistedVideoProject["shotPackets"];

    const result = await prepareVideoPromptBatchAction(
      { batchMode: "batch", videoGenerationPrefs: { mode: "text-to-video" } },
      createRuntime(createVideoProject({ scenes, shotPackets, videoPromptBatch: "existing prompt batch" })),
    );

    const nextScenes = result.data?.videoProject?.scenes ?? [];
    expect(invokeFunction.mock.calls.filter(([name]) => name === "enhance-video-prompt")).toHaveLength(2);
    expect(nextScenes.find((scene) => scene.id === "scene-3")?.enhancedVideoPrompt).toContain("enhanced scene 3");
    expect(nextScenes.find((scene) => scene.id === "scene-4")?.enhancedVideoPrompt).toContain("enhanced scene 4");
    expect(nextScenes.find((scene) => scene.id === "scene-5")?.enhancedVideoPrompt).toBeUndefined();
    expect(result.data?.videoProject?.videoPromptBatch).toContain("existing prompt 1");
    expect(result.data?.videoProject?.videoPromptBatch).toContain("enhanced scene 3");
    expect(result.summary).toContain("本次处理片段 1-2");
    expect(result.summary).toContain("累计已覆盖 4 / 5 个镜头");
    expect(result.summary).toContain("下次点击“单批生成”会继续处理片段 1-3");
    expect(result.summary).toContain("已收口 4 个镜头的视频提示词批次");
    expect(result.summary).toContain("片段 1-1");
    expect(result.summary).toContain("片段 1-2");
    expect(result.summary).toContain("Scene 1");
    expect(result.summary).toContain("Scene 2");
    expect(result.summary).toContain("Scene 3");
    expect(result.summary).toContain("Scene 4");
    expect(result.summary).toContain("当前批次资产状态");
  });

  it("reports completion without generating prompts when single prompt batches are fully covered", async () => {
    const scenes = Array.from({ length: 2 }, (_, index) => {
      const sceneNumber = index + 1;
      return {
        id: `scene-${sceneNumber}`,
        sceneNumber,
        sceneName: `Scene ${sceneNumber}`,
        description: `scene ${sceneNumber}`,
        characters: [],
        dialogue: "",
        cameraDirection: "medium shot",
        duration: 5,
        segmentLabel: "1-1",
        enhancedVideoPrompt: `existing prompt ${sceneNumber}`,
      };
    }) as PersistedVideoProject["scenes"];
    const shotPackets = scenes.map((scene) => ({
      id: `packet-${scene.id}`,
      sceneId: scene.id,
      sceneNumber: scene.sceneNumber,
      title: scene.sceneName,
      durationSec: 5,
      camera: { shotSize: "standard", movement: "static" },
      characterRefs: [],
      sourceAssetIds: [],
      promptSeed: `p${scene.sceneNumber}`,
      forbiddenChanges: [],
      renderMode: "text2video" as const,
      reviewStatus: "pending" as const,
    })) as PersistedVideoProject["shotPackets"];

    const result = await prepareVideoPromptBatchAction(
      { batchMode: "batch", videoGenerationPrefs: { mode: "text-to-video" } },
      createRuntime(createVideoProject({ scenes, shotPackets })),
    );

    expect(invokeFunction).not.toHaveBeenCalled();
    expect(result.summary).toContain("当前没有未覆盖的片段镜头");
    expect(result.summary).toContain("已覆盖 2 / 2 个镜头");
    expect(result.summary).toContain("已收口 2 个镜头的视频提示词批次");
    expect(result.summary).toContain("片段 1-1");
    expect(result.summary).toContain("Scene 1");
    expect(result.summary).toContain("Scene 2");
    expect(result.summary).toContain("当前批次资产状态");
    expect(result.data?.videoProject?.videoPromptBatch).toContain("existing prompt 1");
  });

  it("shows the segment prompt list with real summed shot duration after preparing segment prompts", async () => {
    invokeFunction.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      if (name !== "enhance-video-prompt") {
        throw new Error(`unexpected function: ${name}`);
      }
      if (body.mode !== "segment") {
        return {
          data: {
            enhanced: `enhanced ${body.description}`,
            duration: 6,
          },
          error: null,
        };
      }
      return {
        data: {
          prompt: buildMockStructuredSegmentPrompt(body),
          duration: 12,
        },
        error: null,
      };
    });

    const scenes = [
      {
        id: "scene-1",
        sceneNumber: 1,
        sceneName: "Scene 1",
        description: "scene 1",
        characters: [],
        dialogue: "",
        cameraDirection: "wide",
        duration: 5,
        segmentLabel: "1-2",
        enhancedVideoPrompt: "existing enhanced scene 1",
      },
      {
        id: "scene-2",
        sceneNumber: 2,
        sceneName: "Scene 2",
        description: "scene 2",
        characters: [],
        dialogue: "",
        cameraDirection: "close",
        duration: 7,
        segmentLabel: "1-2",
      },
    ] as PersistedVideoProject["scenes"];

    const result = await prepareSegmentVideoPromptAction(
      {
        batchMode: "single",
        targetSegmentLabel: "1-2",
        videoGenerationPrefs: { mode: "text-to-video", modelKey: "doubao-seedance-1-5-pro" },
      },
      createRuntime(createVideoProject({ scenes })),
    );

    expect(result.summary).toContain("已生成 1 个片段的合并视频提示词");
    expect(result.summary).toContain("片段列表：1-2");
    expect(result.summary).toContain("已收口 2 个镜头的视频提示词批次");
    expect(result.summary).toContain("片段 1-2（12s）");
    expect(result.summary).toContain("Scene 1");
    expect(result.summary).toContain("Scene 2");
    expect(result.summary).toContain("当前批次资产状态");
    expect(result.summary).toContain("最终提示词稳定性：");
    expect(result.summary).toContain("最终提示词日志：");
    expect(result.summary).toContain("### 片段 1-2 最终提示词");
    expect(invokeFunction.mock.calls.filter(([name]) => name === "enhance-video-prompt")).toHaveLength(1);
    const segmentCall = invokeFunction.mock.calls.find(([, body]) => body?.mode === "segment");
    expect(segmentCall?.[1]).toEqual(expect.objectContaining({ segmentLabel: "1-2" }));
    const segmentShots = (segmentCall?.[1]?.shots ?? []) as Array<{
      prompt?: string;
      rawDescription?: string;
      promptSource?: string;
    }>;
    expect(segmentShots[0]?.prompt).toContain("existing enhanced scene 1");
    expect(segmentShots[0]?.rawDescription).toContain("scene 1");
    expect(segmentShots[0]?.promptSource).toBe("enhanced");
    expect(segmentShots[1]?.prompt).toContain("scene 2");
    expect(segmentShots[1]?.rawDescription).toContain("scene 2");
    expect(segmentShots[1]?.promptSource).toBe("raw");
    const nextProject = result.data?.videoProject;
    expect(nextProject?.scenes[0]?.enhancedVideoPrompt).toContain("existing enhanced scene 1");
    expect(nextProject?.scenes[1]?.enhancedVideoPrompt).toBeUndefined();
    const segmentPrompt = nextProject?.segmentVideoPrompts?.["1-2"]?.prompt ?? "";
    expect(segmentPrompt).toContain("全局风格：");
    expect(segmentPrompt).toContain("scene 1");
    expect(segmentPrompt).toContain("scene 2");
    expect(segmentPrompt).not.toContain("镜头推进：");
    expect(segmentPrompt).not.toContain("【执行底线】");
    expect(nextProject?.segmentVideoPrompts?.["1-2"]?.debug).toEqual(
      expect.objectContaining({
        source: "model",
        shotCount: 2,
        shotCoverageComplete: true,
      }),
    );
  });

  it("fills only missing segment prompts in order and passes adjacent continuity context", async () => {
    invokeFunction.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      if (name !== "enhance-video-prompt") {
        throw new Error(`unexpected function: ${name}`);
      }
      if (body.mode !== "segment") {
        return {
          data: {
            enhanced: `enhanced ${body.description}`,
            duration: 5,
          },
          error: null,
        };
      }
      return {
        data: {
          prompt: buildMockStructuredSegmentPrompt(body),
          duration: 15,
        },
        error: null,
      };
    });

    const scenes = [1, 2, 3].map((sceneNumber) => ({
      id: `scene-${sceneNumber}`,
      sceneNumber,
      sceneName: `Scene ${sceneNumber}`,
      description: `scene ${sceneNumber}`,
      characters: [],
      dialogue: "",
      cameraDirection: "wide",
      duration: 5,
      segmentLabel: `1-${sceneNumber}`,
      ...(sceneNumber === 1 ? { enhancedVideoPrompt: "existing enhanced scene 1" } : {}),
    })) as PersistedVideoProject["scenes"];
    const shotPackets = scenes.map((scene) => ({
      id: `packet-${scene.id}`,
      sceneId: scene.id,
      sceneNumber: scene.sceneNumber,
      title: scene.sceneName,
      durationSec: scene.duration || 5,
      camera: { shotSize: "standard", movement: scene.cameraDirection || "wide" },
      characterRefs: [],
      sourceAssetIds: [],
      promptSeed: scene.description,
      forbiddenChanges: [],
      renderMode: "text2video" as const,
      startState: `${scene.sceneName} start state`,
      endState: `${scene.sceneName} end state`,
      previousAnchor: `anchor before ${scene.sceneName}`,
      nextAnchor: `anchor after ${scene.sceneName}`,
      reviewStatus: "pending" as const,
    })) as PersistedVideoProject["shotPackets"];

    const result = await prepareSegmentVideoPromptAction(
      {
        batchMode: "remaining",
        videoGenerationPrefs: { mode: "text-to-video", modelKey: "doubao-seedance-1-5-pro" },
      },
      createRuntime(createVideoProject({
        script: "第1集：试探\nscene 1\nscene 2\nscene 3",
        scenes,
        shotPackets,
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "existing 1-1 structured segment prompt",
            duration: 15,
            targetDuration: 15,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 15,
            sceneIds: ["scene-1"],
            generatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        segmentContinuityGridImages: {
          "1-1": {
            imageUrl: "data:image/jpeg;base64,c2VnbWVudC0xLTEtc2l4LWdyaWQ=",
            recapText: "前情提要：上一段从试探推进到正面对峙。",
            frameUrls: [
              "data:image/jpeg;base64,c2VnbWVudC0xLTEtZnJhbWUtMQ==",
              "data:image/jpeg;base64,c2VnbWVudC0xLTEtZnJhbWUtMg==",
              "data:image/jpeg;base64,c2VnbWVudC0xLTEtZnJhbWUtMw==",
              "data:image/jpeg;base64,c2VnbWVudC0xLTEtZnJhbWUtNA==",
              "data:image/jpeg;base64,c2VnbWVudC0xLTEtZnJhbWUtNQ==",
              "data:image/jpeg;base64,c2VnbWVudC0xLTEtZnJhbWUtNg==",
            ],
          },
        },
      })),
    );

    const segmentCalls = invokeFunction.mock.calls.filter(([, body]) => body?.mode === "segment");
    expect(segmentCalls).toHaveLength(2);
    expect(segmentCalls.map(([, body]) => body?.segmentLabel)).toEqual(["1-2", "1-3"]);
    expect(segmentCalls[0]?.[1]).toEqual(expect.objectContaining({
      videoMode: "text-to-video",
      previousSegmentPrompt: expect.stringContaining("existing 1-1 structured segment prompt"),
      previousSegmentSummary: expect.stringContaining("片段 1-1"),
      nextSegmentSummary: expect.stringContaining("片段 1-3"),
      currentSegmentScriptSource: expect.stringContaining("scene 2"),
    }));
    expect(segmentCalls[0]?.[1]?.continuityReferenceImageUrl).toBeUndefined();
    expect(String(segmentCalls[0]?.[1]?.currentSegmentShotRelayPlan || "")).toContain("分镜1｜开场：");
    expect(segmentCalls[0]?.[1]?.shots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sceneName: "Scene 2",
        startState: expect.any(String),
        endState: expect.any(String),
        previousAnchor: expect.any(String),
        nextAnchor: expect.any(String),
      }),
    ]));
    expect(segmentCalls[1]?.[1]).toEqual(expect.objectContaining({
      previousSegmentPrompt: expect.stringContaining("scene 2"),
    }));

    const nextProject = result.data?.videoProject;
    expect(nextProject?.segmentVideoPrompts?.["1-1"]?.prompt).toContain("existing 1-1 structured segment prompt");
    expect(nextProject?.segmentVideoPrompts?.["1-2"]?.prompt).toContain("scene 2");
    expect(nextProject?.segmentVideoPrompts?.["1-3"]?.prompt).toContain("scene 3");
    expect(result.summary).toContain("已按顺序补齐 2 个剩余片段");
    expect(result.summary).toContain("片段覆盖进度：3 / 3");
  });

  it("rejects incomplete multi-shot segment prompts when required canonical sections are missing", async () => {
    invokeFunction.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      if (name !== "enhance-video-prompt") {
        throw new Error(`unexpected function: ${name}`);
      }
      if (body.mode !== "segment") {
        return {
          data: {
            enhanced: `enhanced ${body.description}`,
            duration: 5,
          },
          error: null,
        };
      }
      return {
        data: {
          prompt: "电影级古风武侠质感，15秒。分镜1（0-5秒）：林野在宗门擂台上与秦傲天对峙。",
          duration: 15,
        },
        error: null,
      };
    });

    const scenes = [
      {
        id: "scene-1",
        sceneNumber: 1,
        sceneName: "宗门擂台",
        description: "大远景，林野与秦傲天在擂台两端对峙。",
        characters: ["林野", "秦傲天"],
        dialogue: "",
        cameraDirection: "横移全景",
        duration: 5,
        segmentLabel: "1-1",
      },
      {
        id: "scene-2",
        sceneNumber: 2,
        sceneName: "宗门擂台",
        description: "中近景，林野手指微微蜷缩，视线锁向秦傲天。",
        characters: ["林野", "秦傲天"],
        dialogue: "秦傲天：你今日必死。",
        cameraDirection: "中景推进",
        duration: 5,
        segmentLabel: "1-1",
      },
      {
        id: "scene-3",
        sceneNumber: 3,
        sceneName: "宗门擂台",
        description: "特写，林野脚下碎石轻震，剑势将起未起。",
        characters: ["林野"],
        dialogue: "",
        cameraDirection: "特写压近",
        duration: 5,
        segmentLabel: "1-1",
      },
    ] as PersistedVideoProject["scenes"];

    await expect(
      prepareSegmentVideoPromptAction(
        {
          batchMode: "all",
          videoGenerationPrefs: { mode: "text-to-video", modelKey: "doubao-seedance-1-5-pro" },
        },
        createRuntime(createVideoProject({
          script: "第1集：宗门死战\n林野与秦傲天在宗门擂台对峙。秦傲天逼迫林野低头，林野在屈辱中蓄势反击。",
          scenes,
        })),
      ),
    ).rejects.toThrow("segment prompt missing required sections");
  });

  it("rejects segment prompts whose standard sections are present but still too terse", async () => {
    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "enhance-video-prompt") {
        throw new Error(`unexpected function: ${name}`);
      }
      return {
        data: {
          prompt: [
            "全局风格：压迫感。",
            "视觉锚点：刑台。",
            "起始衔接：接上。",
            "衔接原则：顺拍。",
            "镜头推进：",
            "分镜1（0-5秒）：陆沉抬头。",
            "分镜2（5-10秒）：刀逼近。",
            "环境细节：有风。",
            "结尾钩子：他抬眼。",
            "通用后缀：无字幕、无水印、无屏幕文字",
          ].join("\n"),
          duration: 10,
        },
        error: null,
      };
    });

    await expect(
      prepareSegmentVideoPromptAction(
        {
          batchMode: "all",
          videoGenerationPrefs: { mode: "text-to-video", modelKey: "doubao-seedance-1-5-pro" },
        },
        createRuntime(createVideoProject({
          script: "第1集：刑台对峙\n陆沉被钉在刑台上，蒋家执事持刀逼近。",
          scenes: [
            {
              id: "scene-1",
              sceneNumber: 1,
              sceneName: "刑台",
              description: "陆沉被锁链钉在铜柱上艰难抬头。",
              characters: ["陆沉"],
              dialogue: "",
              cameraDirection: "close-up",
              duration: 5,
              segmentLabel: "1-1",
            },
            {
              id: "scene-2",
              sceneNumber: 2,
              sceneName: "刑台",
              description: "蒋家执事持刀逼近陆沉胸前伤口。",
              characters: ["蒋家执事", "陆沉"],
              dialogue: "",
              cameraDirection: "medium shot",
              duration: 5,
              segmentLabel: "1-1",
            },
          ],
        })),
      ),
    ).rejects.toThrow("segment prompt sections too terse");
  });

  it("normalizes segment beat openings onto explicit camera and motion language before storing the prompt", async () => {
    let enhanceAttempt = 0;
    invokeFunction.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      if (name !== "enhance-video-prompt") {
        throw new Error(`unexpected function: ${name}`);
      }
      enhanceAttempt += 1;
      if (enhanceAttempt === 1) {
        return {
          data: {
            prompt: [
              "全局风格：电影化短剧质感，15秒，烈日压场，冷硬高反差光影，写实材质。",
              "镜头推进：",
              "分镜1（0-5秒）：镜头从低角度缓慢推近刑台中央的陆沉，青石反光与玄铁锁链的冷芒一起压向画面。",
              "分镜2（5-10秒）：蒋家执事逼近陆沉胸前伤口，脸上挂着扭曲又兴奋的笑意。",
              "环境细节：浮尘翻卷，锁链轻颤，远处围观弟子低声嘲笑。",
              "结尾钩子：画面停在刀锋贴近陆沉胸口的瞬间，保留下一镜反扑前的窒息压迫感。",
              "通用后缀：无字幕、无水印、无屏幕文字",
            ].join("\n"),
            duration: 10,
          },
          error: null,
        };
      }
      return {
        data: {
          prompt: [
            "全局风格：电影化短剧质感，15秒，烈日压场，冷硬高反差光影，写实材质。",
            "镜头推进：",
            "分镜1（0-5秒）：镜头从低角度缓慢推近刑台中央的陆沉，青石反光与玄铁锁链的冷芒一起压向画面。",
            "分镜2（5-10秒）：中近景切至蒋家执事正面，他带着扭曲又兴奋的笑意一步步逼近陆沉胸前伤口，刀锋随着镜头压近继续向前顶入画面。",
            "环境细节：浮尘翻卷，锁链轻颤，远处围观弟子低声嘲笑。",
            "结尾钩子：画面停在刀锋贴近陆沉胸口的瞬间，保留下一镜反扑前的窒息压迫感。",
            "通用后缀：无字幕、无水印、无屏幕文字",
          ].join("\n"),
          duration: 10,
        },
        error: null,
      };
    });

    const result = await prepareSegmentVideoPromptAction(
      {
        batchMode: "all",
        videoGenerationPrefs: { mode: "text-to-video", modelKey: "doubao-seedance-1-5-pro" },
      },
      createRuntime(createVideoProject({
        script: "第1集：刑台逼杀\n陆沉被钉在刑台上，蒋家执事持刀逼近。",
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "刑台",
            description: "陆沉被锁链钉在铜柱上艰难抬头。",
            characters: ["陆沉"],
            dialogue: "",
            cameraDirection: "低角度缓慢推近",
            duration: 5,
            segmentLabel: "1-1",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "刑台",
            description: "蒋家执事持刀逼近陆沉胸前伤口。",
            characters: ["蒋家执事", "陆沉"],
            dialogue: "",
            cameraDirection: "中近景切至正面并继续压近",
            duration: 5,
            segmentLabel: "1-1",
          },
        ],
      })),
    );

    const enhanceCalls = invokeFunction.mock.calls.filter(([name]) => name === "enhance-video-prompt");
    expect(enhanceCalls).toHaveLength(1);
    expect(String(enhanceCalls[0]?.[1]?.retryFeedback || "")).toBe("");
    expect(result.data?.videoProject?.segmentVideoPrompts?.["1-1"]?.prompt).toContain("分镜1（0-5秒）：镜头从低角度缓慢推近");
    expect(result.data?.videoProject?.segmentVideoPrompts?.["1-1"]?.prompt).toContain("分镜2（5-10秒）：近景切至，蒋家执事逼近陆沉胸前伤口");
  });

  it("includes neighboring script context when building the script supplement reference for a segment", async () => {
    invokeFunction.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      if (name !== "enhance-video-prompt") {
        throw new Error(`unexpected function: ${name}`);
      }
      if (body.mode !== "segment") {
        return {
          data: {
            enhanced: `enhanced ${body.description}`,
            duration: 5,
          },
          error: null,
        };
      }
      return {
        data: {
          prompt: buildMockStructuredSegmentPrompt(body),
          duration: 15,
        },
        error: null,
      };
    });

    const scenes = [
      {
        id: "scene-1",
        sceneNumber: 1,
        sceneName: "断崖外沿",
        description: "林慕踩着碎石后退，视线还锁着洞口方向。",
        characters: ["林慕"],
        dialogue: "",
        cameraDirection: "wide",
        duration: 5,
        segmentLabel: "1-1",
      },
      {
        id: "scene-2",
        sceneNumber: 2,
        sceneName: "断崖入口",
        description: "黑雾顺着洞口翻出，林慕被压向碎石地面。",
        characters: ["林慕", "赵峰"],
        dialogue: "",
        cameraDirection: "wide",
        duration: 5,
        segmentLabel: "1-2",
      },
      {
        id: "scene-3",
        sceneNumber: 3,
        sceneName: "断崖入口",
        description: "赵峰俯冲压近，黑雾化刃逼向林慕喉前。",
        characters: ["林慕", "赵峰"],
        dialogue: "赵峰：跪下认命。",
        cameraDirection: "medium",
        duration: 5,
        segmentLabel: "1-2",
      },
      {
        id: "scene-4",
        sceneNumber: 4,
        sceneName: "断崖入口",
        description: "林慕眼底杀意翻起，指尖微微蜷缩。",
        characters: ["林慕"],
        dialogue: "",
        cameraDirection: "close-up",
        duration: 5,
        segmentLabel: "1-3",
      },
    ] as PersistedVideoProject["scenes"];

    await prepareSegmentVideoPromptAction(
      {
        batchMode: "remaining",
        videoGenerationPrefs: { mode: "text-to-video", modelKey: "doubao-seedance-1-5-pro" },
      },
      createRuntime(createVideoProject({
        script: [
          "第1集：断崖逼压",
          "林慕踩着碎石一路后退，死死盯着断崖深处的洞口。",
          "黑雾先从洞口缝隙翻出来，像潮水一样沿地面扑向林慕脚边。",
          "林慕刚要侧身避开，就被骤然压下的黑雾巨力按进碎石地面，肩背与额角同时擦裂。",
          "赵峰从断崖上方俯冲而下，黑雾在他掌前凝成锋刃，直逼林慕喉前。",
          "赵峰冷声吐出一句：跪下认命。",
          "林慕没有立刻抬头，只是指尖一点点蜷紧，眼底的杀意开始往上翻。 ",
        ].join("\n"),
        scenes,
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "existing 1-1 structured segment prompt",
            duration: 15,
            targetDuration: 15,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 15,
            sceneIds: ["scene-1"],
            generatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      })),
    );

    const segmentCalls = invokeFunction.mock.calls.filter(([, body]) => body?.mode === "segment");
    const segmentBody = segmentCalls.find(([, body]) => body?.segmentLabel === "1-2")?.[1] as Record<string, unknown>;
    const scriptSource = String(segmentBody?.currentSegmentScriptSource || "");
    expect(scriptSource).toContain("分镜补全指向：");
    expect(scriptSource).toContain("关键补全句：");
    expect(scriptSource).toContain("上下文参考：");
    expect(scriptSource).toContain("黑雾先从洞口缝隙翻出来");
    expect(scriptSource).toContain("被骤然压下的黑雾巨力按进碎石地面");
    expect(scriptSource).toContain("赵峰从断崖上方俯冲而下");
    expect(scriptSource).toContain("赵峰冷声吐出一句：跪下认命。");
    expect(scriptSource).toContain("眼底的杀意开始往上翻");
  });

  it("deduplicates repeated dialogue lines across storyboard blocks in the final submitted prompt", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", status: "submitted", provider: "jimeng" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const repeatedLine = "赵峰：跪下认命。";
    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "断崖入口",
            description: "赵峰俯冲压近，黑雾化刃逼向林慕喉前。",
            characters: ["林慕", "赵峰"],
            dialogue: repeatedLine,
            cameraDirection: "medium shot",
            duration: 5,
            segmentLabel: "1-2",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "断崖入口",
            description: "林慕眼底杀意翻起，仍死死盯住赵峰。",
            characters: ["林慕", "赵峰"],
            dialogue: repeatedLine,
            cameraDirection: "close-up",
            duration: 5,
            segmentLabel: "1-2",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
        segmentVideoPrompts: {
          "1-2": {
            segmentLabel: "1-2",
            prompt: [
              "全局风格：电影化实拍质感，10秒，压迫感强烈。",
              "视觉锚点：断崖入口黑雾翻涌，赵峰压迫林慕保持一致。",
              "起始衔接：从断崖入口上一镜头的对峙停点直接切入。",
              "衔接原则：严格按已拆分镜头顺序推进，保持断崖入口的空间、视线和动作接力连续。",
              `镜头推进：0-5秒：中景，赵峰俯冲压近，黑雾化刃逼向林慕喉前。；5-10秒：近景，林慕眼底杀意翻起，仍死死盯住赵峰。；${repeatedLine}；${repeatedLine}`,
              `台词：\n${repeatedLine}\n${repeatedLine}`,
              "环境细节：断崖入口黑雾翻涌，风声与碎石摩擦持续。",
              "结尾钩子：最后一镜停在林慕眼底杀意翻起的瞬间。",
              "通用后缀：无字幕、无水印、无屏幕文字",
            ].join("\n"),
            duration: 10,
            targetDuration: 10,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-1", "scene-2"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    await generateSegmentVideoAction({ segmentLabel: "1-2" }, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    const prompt = String(generateArgs?.prompt || "");
    expect(prompt.match(/赵峰：跪下认命。/g)?.length).toBe(1);
    expect(prompt.match(/赵峰：跪下认命/g)?.length).toBe(1);
  });

  it("keeps the final submitted segment prompt on the canonical dialogue-anchored layout", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", status: "submitted", provider: "jimeng" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const dialogueA = "蒋家执事：陆沉，今天你这废柴就彻底消失吧！";
    const dialogueB = "陆沉：想杀我？先问过我的剑。";
    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "刑台",
            description: "烈日白火压着刑台青石反光，镜头从低角度缓慢推近陆沉胸前交错的锁链与伤口。",
            characters: ["陆沉", "蒋家执事"],
            dialogue: "",
            cameraDirection: "low-angle push-in",
            duration: 3,
            segmentLabel: "1-2",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "刑台",
            description: "蒋家执事半步踏上刑台，剔骨尖刀带着寒光逼近陆沉喉前，刀锋映出他扭曲却兴奋的笑意。",
            characters: ["陆沉", "蒋家执事"],
            dialogue: dialogueA,
            cameraDirection: "medium shot",
            duration: 3,
            segmentLabel: "1-2",
          },
          {
            id: "scene-3",
            sceneNumber: 3,
            sceneName: "刑台",
            description: "镜头压到极近特写，陆沉强撑抬眼直视对方，眼神里闪出一丝反扑前的寒芒。",
            characters: ["陆沉", "蒋家执事"],
            dialogue: dialogueB,
            cameraDirection: "extreme close-up",
            duration: 3,
            segmentLabel: "1-2",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
        segmentVideoPrompts: {
          "1-2": {
            segmentLabel: "1-2",
            prompt: [
              "全局风格：电影级古装玄幻短剧质感，9秒，烈日灼烧下的压抑肃杀氛围与冷调高反差并存。",
              "视觉锚点：陆沉满身血迹被粗重玄铁锁链贯穿钉在刑台铜柱上，蒋家执事持剔骨尖刀逼近，青石刑台与粗粝石壁保持一致。",
              "起始衔接：从上一片段刑台死寂的停点直接接入，镜头一落地就锁住陆沉垂头喘息后的再度抬眼。",
              "衔接原则：全段沿同一条长片时间线推进，按已拆解分镜顺序逐镜接力，保持人物朝向、镜头轴线、主光方向和刑台空间关系连续。",
              "镜头推进：",
              "分镜1（0-3秒）：烈日白火压着刑台青石反光，镜头从低角度缓慢推近陆沉胸前交错的锁链与伤口，血迹顺着锁链纹理往下滑落。",
              "分镜2（3-6秒）：蒋家执事半步踏上刑台，剔骨尖刀带着寒光逼近陆沉喉前，刀锋映出他扭曲却兴奋的笑意，低沉威胁：“陆沉，今天你这废柴就彻底消失吧！”",
              "分镜3（6-9秒）：镜头压到极近特写，陆沉强撑抬眼直视对方，眼神里闪出一丝反扑前的寒芒，低沉回应：“想杀我？先问过我的剑。”",
              `台词：\n${dialogueB}\n${dialogueA}`,
              "环境细节：烈日热浪压得空气轻微扭曲，青石地面蒸腾白光，锁链金属摩擦与远处低笑混在一起持续回响。",
              "结尾钩子：最后一镜停在刀尖逼近伤口而陆沉忽然抬眼的瞬间，让下一片段直接接上他的反扑起势。",
              "通用后缀：无字幕、无水印、无屏幕文字",
            ].join("\n"),
            duration: 9,
            targetDuration: 9,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-1", "scene-2", "scene-3"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    await generateSegmentVideoAction({ segmentLabel: "1-2" }, runtime);

    const { formatDetailedSegmentPrompt } = await import("@/lib/invoke-with-key");
    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    const prompt = String(generateArgs?.prompt || "");
    const logPrompt = String(generateArgs?.logPrompt || "");
    const shot2Index = prompt.indexOf("分镜2（3-6秒）：");
    const shot3Index = prompt.indexOf("分镜3（6-9秒）：");
    const dialogueAIndex = prompt.indexOf(`\n${dialogueA}`);
    const dialogueBIndex = prompt.indexOf(`\n${dialogueB}`);

    expect(logPrompt).toBe(prompt);
    expect(prompt).not.toContain("镜头推进：");
    expect(prompt).not.toContain("台词：");
    expect(formatDetailedSegmentPrompt(prompt)).toBe(prompt);
    expect(dialogueAIndex).toBeGreaterThan(shot2Index);
    expect(dialogueAIndex).toBeLessThan(shot3Index);
    expect(dialogueBIndex).toBeGreaterThan(shot3Index);
    expect(prompt).not.toContain("低沉威胁：“陆沉，今天你这废柴就彻底消失吧！”");
    expect(prompt).not.toContain("低沉回应：“想杀我？先问过我的剑。”");
    expect(prompt.match(new RegExp(dialogueA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(1);
    expect(prompt.match(new RegExp(dialogueB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(1);
  });

  it("keeps 2k RunningHub segment prompt preparation on strict text-to-video continuity semantics", async () => {
    saveApiConfig({
      runninghubKey: "test-runninghub-key",
      runninghubEndpoint: "https://www.runninghub.cn",
    });

    invokeFunction.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      if (name !== "enhance-video-prompt") {
        throw new Error(`unexpected function: ${name}`);
      }
      if (body.mode !== "segment") {
        return {
          data: {
            enhanced: `enhanced ${body.description}`,
            duration: 5,
          },
          error: null,
        };
      }
      return {
        data: {
          prompt: buildMockStructuredSegmentPrompt(body),
          duration: 15,
        },
        error: null,
      };
    });

    const result = await prepareSegmentVideoPromptAction(
      {
        batchMode: "remaining",
        videoGenerationPrefs: {
          mode: "text-to-video",
          modelKey: "doubao-seedance-2-0-260128",
          resolution: "2k",
        },
      },
      createRuntime(createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            description: "scene 1",
            characters: [],
            dialogue: "",
            cameraDirection: "wide",
            duration: 5,
            segmentLabel: "1-1",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "Scene 2",
            description: "scene 2",
            characters: [],
            dialogue: "",
            cameraDirection: "wide",
            duration: 5,
            segmentLabel: "1-2",
          },
        ],
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "existing 1-1 structured segment prompt",
            duration: 15,
            targetDuration: 15,
            modelKey: "doubao-seedance-2-0-260128",
            maxDurationForModel: 15,
            sceneIds: ["scene-1"],
            generatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        segmentContinuityGridImages: {
          "1-1": {
            imageUrl: "data:image/jpeg;base64,c2VnbWVudC0xLTEtcnVubmluZ2h1Yi1jb250aW51aXR5LWdyaWQ=",
            recapText: "前情提要：上一段从压制转入反击前夜。",
            frameUrls: [
              "data:image/jpeg;base64,c2VnbWVudC0xLTEta2YtMQ==",
              "data:image/jpeg;base64,c2VnbWVudC0xLTEta2YtMg==",
              "data:image/jpeg;base64,c2VnbWVudC0xLTEta2YtMw==",
              "data:image/jpeg;base64,c2VnbWVudC0xLTEta2YtNA==",
              "data:image/jpeg;base64,c2VnbWVudC0xLTEta2YtNQ==",
              "data:image/jpeg;base64,c2VnbWVudC0xLTEta2YtNg==",
            ],
          },
        },
      })),
    );

    const segmentCall = invokeFunction.mock.calls.find(([, body]) => body?.mode === "segment");
    expect(segmentCall?.[1]).toEqual(expect.objectContaining({
      segmentLabel: "1-2",
      videoMode: "text-to-video",
      continuityReferenceImageUrl:
        "data:image/jpeg;base64,c2VnbWVudC0xLTEtcnVubmluZ2h1Yi1jb250aW51aXR5LWdyaWQ=",
    }));
    expect(String(segmentCall?.[1]?.continuityReferenceUsageText || "")).toContain("图片 1：上传的六宫格图片为上一段视频的连续时间参考。");
    expect(String(segmentCall?.[1]?.continuityReferenceUsageText || "")).toContain(
      "并把上一段“从压制转入反击前夜”所形成的剧情余势、人物压迫关系与情绪方向直接接到本段首镜",
    );
    expect(result.data?.videoProject.segmentVideoPrompts?.["1-2"]?.prompt).toContain("Scene 2");
    expect(result.data?.videoProject.segmentVideoPrompts?.["1-2"]?.prompt).toContain("通用后缀");
  });

  it("omits the six-grid continuity tail when the previous segment recap has no usable cue", async () => {
    saveApiConfig({
      geminiKey: "test-gemini-key",
      geminiEndpoint: "https://api.tu-zi.com",
      runninghubApiKey: "test-runninghub-key",
      runninghubApiSecret: "test-runninghub-secret",
      runninghubEndpoint: "https://www.runninghub.cn",
    });

    invokeFunction.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      if (name !== "enhance-video-prompt") {
        throw new Error(`unexpected function: ${name}`);
      }
      if (body.mode !== "segment") {
        return {
          data: {
            enhanced: `enhanced ${body.description}`,
            duration: 5,
          },
          error: null,
        };
      }
      return {
        data: {
          prompt: buildMockStructuredSegmentPrompt(body),
          duration: 15,
        },
        error: null,
      };
    });

    await prepareSegmentVideoPromptAction(
      {
        batchMode: "remaining",
        videoGenerationPrefs: {
          mode: "text-to-video",
          modelKey: "doubao-seedance-2-0-260128",
          resolution: "2k",
        },
      },
      createRuntime(createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            description: "scene 1",
            characters: [],
            dialogue: "",
            cameraDirection: "wide",
            duration: 5,
            segmentLabel: "1-1",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "Scene 2",
            description: "scene 2",
            characters: [],
            dialogue: "",
            cameraDirection: "wide",
            duration: 5,
            segmentLabel: "1-2",
          },
        ],
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "existing 1-1 structured segment prompt",
            duration: 15,
            targetDuration: 15,
            modelKey: "doubao-seedance-2-0-260128",
            maxDurationForModel: 15,
            sceneIds: ["scene-1"],
            generatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        segmentContinuityGridImages: {
          "1-1": {
            imageUrl: "data:image/jpeg;base64,c2VnbWVudC0xLTEtcnVubmluZ2h1Yi1jb250aW51aXR5LWdyaWQ=",
            recapText: "前情提要：",
            frameUrls: [
              "data:image/jpeg;base64,c2VnbWVudC0xLTEta2YtMQ==",
              "data:image/jpeg;base64,c2VnbWVudC0xLTEta2YtMg==",
              "data:image/jpeg;base64,c2VnbWVudC0xLTEta2YtMw==",
              "data:image/jpeg;base64,c2VnbWVudC0xLTEta2YtNA==",
              "data:image/jpeg;base64,c2VnbWVudC0xLTEta2YtNQ==",
              "data:image/jpeg;base64,c2VnbWVudC0xLTEta2YtNg==",
            ],
          },
        },
      })),
    );

    const segmentCall = invokeFunction.mock.calls.find(([, body]) => body?.mode === "segment");
    const usageText = String(segmentCall?.[1]?.continuityReferenceUsageText || "");
    expect(usageText).toContain("本段视频必须从六宫格最后一格尾帧画面状态直接开始。");
    expect(usageText).not.toContain("保持完全一致的人物状态");
    expect(usageText).not.toContain("剧情余势");
  });

  it("generates only the next missing segment in segment batch mode", async () => {
    invokeFunction.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      if (name !== "enhance-video-prompt") {
        throw new Error(`unexpected function: ${name}`);
      }
      if (body.mode !== "segment") {
        return {
          data: {
            enhanced: `enhanced ${body.description}`,
            duration: 5,
          },
          error: null,
        };
      }
      return {
        data: {
          prompt: buildMockStructuredSegmentPrompt(body),
          duration: 15,
        },
        error: null,
      };
    });

    const scenes = [1, 2, 3].map((sceneNumber) => ({
      id: `scene-${sceneNumber}`,
      sceneNumber,
      sceneName: `Scene ${sceneNumber}`,
      description: `scene ${sceneNumber}`,
      characters: [],
      dialogue: "",
      cameraDirection: "wide",
      duration: 5,
      segmentLabel: `1-${sceneNumber}`,
    })) as PersistedVideoProject["scenes"];

    const result = await prepareSegmentVideoPromptAction(
      {
        batchMode: "batch",
        videoGenerationPrefs: { mode: "text-to-video", modelKey: "doubao-seedance-1-5-pro" },
      },
      createRuntime(createVideoProject({ scenes })),
    );

    const segmentCalls = invokeFunction.mock.calls.filter(([, body]) => body?.mode === "segment");
    expect(segmentCalls).toHaveLength(1);
    expect(segmentCalls[0]?.[1]?.segmentLabel).toBe("1-1");
    expect(result.data?.videoProject?.segmentVideoPrompts?.["1-1"]?.prompt).toContain("Scene 1");
    expect(result.data?.videoProject?.segmentVideoPrompts?.["1-1"]?.prompt).toContain("分镜1（0-12秒）：");
    expect(result.data?.videoProject?.segmentVideoPrompts?.["1-2"]).toBeUndefined();
    expect(result.summary).toContain("已分批生成 1 个片段");
    expect(result.summary).toContain("下次点击“分批生成片段”会继续处理片段 1-2");
  });

  it("continues refresh batching from the persisted segment cursor and resets after the last segment", async () => {
    invokeFunction.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      if (name !== "enhance-video-prompt") {
        throw new Error(`unexpected function: ${name}`);
      }
      if (body.mode !== "segment") {
        return {
          data: {
            enhanced: `enhanced ${body.description}`,
            duration: 5,
          },
          error: null,
        };
      }
      return {
        data: {
          prompt: buildMockStructuredSegmentPrompt(body),
          duration: 15,
        },
        error: null,
      };
    });

    const scenes = [1, 2].map((sceneNumber) => ({
      id: `scene-${sceneNumber}`,
      sceneNumber,
      sceneName: `Scene ${sceneNumber}`,
      description: `scene ${sceneNumber}`,
      characters: [],
      dialogue: "",
      cameraDirection: "wide",
      duration: 5,
      segmentLabel: `1-${sceneNumber}`,
    })) as PersistedVideoProject["scenes"];

    const result = await prepareSegmentVideoPromptAction(
      {
        batchMode: "batch-refresh",
        videoGenerationPrefs: { mode: "text-to-video", modelKey: "doubao-seedance-1-5-pro" },
      },
      createRuntime(createVideoProject({
        scenes,
        segmentPromptRefreshCursor: "1-2",
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "existing 1-1 structured segment prompt",
            duration: 15,
            targetDuration: 15,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 15,
            sceneIds: ["scene-1"],
            generatedAt: "2026-01-01T00:00:00.000Z",
          },
          "1-2": {
            segmentLabel: "1-2",
            prompt: "existing 1-2 segment prompt",
            duration: 15,
            targetDuration: 15,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 15,
            sceneIds: ["scene-2"],
            generatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      })),
    );

    const segmentCalls = invokeFunction.mock.calls.filter(([, body]) => body?.mode === "segment");
    expect(segmentCalls).toHaveLength(1);
    expect(segmentCalls[0]?.[1]?.segmentLabel).toBe("1-2");
    expect(result.data?.videoProject?.segmentPromptRefreshCursor).toBeNull();
    expect(result.data?.videoProject?.segmentVideoPrompts?.["1-2"]?.prompt).toContain("Scene 2");
    expect(result.data?.videoProject?.segmentVideoPrompts?.["1-2"]?.prompt).toContain("分镜1（0-12秒）：");
    expect(result.summary).toContain("本轮重新分批已完成，下次点击“重新分批生成片段”会从片段 1-1 重新开始。");
    expect(result.summary).toContain("本轮重刷进度：2 / 2");
  });

  it("keeps reference asset generation scoped to image-stage fields and preserves character-scene separation", async () => {
    invokeFunction.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      if (name === "generate-character") {
        expect(body).toEqual(
          expect.objectContaining({
            name: "Hero",
            description: "Main character reference",
            style: "live-action",
            modelFamily: "doubao-seedream-3-0",
            selectedImageModelFamily: "doubao-seedream-3-0",
            imageGenerationPrefs: expect.objectContaining({
              familyKey: "doubao-seedream-3-0",
              aspectRatio: "9:16",
            }),
            aspectRatio: "9:16",
            resolution: "4k",
          }),
        );
        expect(body).not.toHaveProperty("referenceImageUrl");
        expect(body).not.toHaveProperty("videoGenerationPrefs");
        expect(body).not.toHaveProperty("selectedVideoModelKey");
        return {
          data: { imageUrl: "https://media.storyforge.test/generated-character.jpg" },
          error: null,
        };
      }

      if (name === "generate-scene") {
        expect(body).toEqual(
          expect.objectContaining({
            name: "Warehouse",
            description: "Rainy alley environment",
            style: "live-action",
            modelFamily: "doubao-seedream-3-0",
            selectedImageModelFamily: "doubao-seedream-3-0",
            imageGenerationPrefs: expect.objectContaining({
              familyKey: "doubao-seedream-3-0",
              aspectRatio: "9:16",
            }),
            aspectRatio: "9:16",
            resolution: "4k",
          }),
        );
        expect(body).not.toHaveProperty("referenceImageUrl");
        expect(body).not.toHaveProperty("videoGenerationPrefs");
        expect(body).not.toHaveProperty("selectedVideoModelKey");
        return {
          data: { imageUrl: "https://media.storyforge.test/generated-scene.jpg" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "Main character reference",
            imageUrl: "",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        sceneSettings: [
          {
            id: "setting-1",
            name: "Warehouse",
            description: "Rainy alley environment",
            imageUrl: "",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        currentStep: 2,
      }),
    );

    const result = await generateVideoReferenceAssetsAction(
      {
        selectedImageModelFamily: "doubao-seedream-3-0",
        imageGenerationPrefs: {
          familyKey: "doubao-seedream-3-0",
          resolution: "4k",
          aspectRatio: "9:16",
          styleCategory: "custom",
          stylePreset: "none",
          customStylePrompt: "",
        },
        aspectRatio: "9:16",
        resolution: "4k",
        referenceImageUrl: "https://media.storyforge.test/shared-reference.jpg",
        selectedVideoModelKey: "veo-3",
        videoGenerationPrefs: {
          modelKey: "veo-3",
          resolution: "1080p",
          mode: "image-to-video",
        },
      },
      runtime,
    );

    expect(invokeFunction.mock.calls.map(([name]) => name)).toEqual([
      "generate-character",
      "generate-scene",
    ]);
    expect(result.imageUrls).toEqual([
      "https://media.storyforge.test/generated-character.jpg",
      "https://media.storyforge.test/generated-scene.jpg",
    ]);
  });

  it("caps smart reference asset batches to the active image model limit", async () => {
    invokeFunction.mockImplementation(async (name: string, body: Record<string, unknown>) => ({
      data: {
        imageUrl: `https://media.storyforge.test/${name}-${String(body.assetFileNameStem || body.name).replace(/\W+/g, "-")}.jpg`,
      },
      error: null,
    }));

    const runtime = createRuntime(
      createVideoProject({
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "Main character reference",
            imageUrl: "",
            isAIGenerated: false,
            source: "auto",
            costumes: [
              { id: "cost-1", label: "校服", description: "蓝白校服", isAIGenerated: false },
              { id: "cost-2", label: "战损", description: "衣摆破损", isAIGenerated: false },
              { id: "cost-3", label: "礼服", description: "黑色礼服", isAIGenerated: false },
              { id: "cost-4", label: "雨衣", description: "透明雨衣", isAIGenerated: false },
            ],
          },
        ],
        sceneSettings: [
          {
            id: "setting-1",
            name: "Warehouse",
            description: "Rainy alley environment",
            imageUrl: "",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        currentStep: 2,
      }),
    );

    const result = await generateVideoReferenceAssetsAction(
      {
        smartBatch: true,
        imageGenerationPrefs: { familyKey: "gpt-image-2", resolution: "default", aspectRatio: "16:9" },
        targetIds: [
          "reference-character:char-1",
          "reference-character-variant:char-1:cost-1",
          "reference-character-variant:char-1:cost-2",
          "reference-character-variant:char-1:cost-3",
          "reference-character-variant:char-1:cost-4",
          "reference-scene:setting-1",
        ],
      },
      runtime,
    );

    expect(invokeFunction).toHaveBeenCalledTimes(6);
    expect(invokeFunction.mock.calls.map(([name]) => name).sort()).toEqual([
      "generate-character",
      "generate-character",
      "generate-character",
      "generate-character",
      "generate-character",
      "generate-scene",
    ]);
    expect(result.summary).toContain("6/6");
    expect(result.remainingTargetIds).toEqual([]);
    expect(result.data?.videoProject?.characters?.[0]?.costumes?.[2]?.imageUrl).toBeTruthy();
    expect(result.data?.videoProject?.characters?.[0]?.costumes?.[3]?.imageUrl).toBeTruthy();
    expect(result.data?.videoProject?.sceneSettings?.[0]?.imageUrl).toBeTruthy();
  });

  it("uses the project's current image-model limit for smart reference batches when input omits image prefs", async () => {
    invokeFunction.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      expect(body).toEqual(expect.objectContaining({
        modelFamily: "gpt-image-2",
        selectedImageModelFamily: "gpt-image-2",
        resolution: "4k",
        aspectRatio: "16:9",
        imageGenerationPrefs: expect.objectContaining({
          familyKey: "gpt-image-2",
          resolution: "4k",
          aspectRatio: "16:9",
        }),
      }));
      return {
        data: {
          imageUrl: `https://media.storyforge.test/${name}-${String(body.assetFileNameStem || body.name).replace(/\W+/g, "-")}.jpg`,
        },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        characters: [
          { id: "char-1", name: "Hero 1", description: "desc", imageUrl: "", isAIGenerated: false, source: "auto" },
          { id: "char-2", name: "Hero 2", description: "desc", imageUrl: "", isAIGenerated: false, source: "auto" },
          { id: "char-3", name: "Hero 3", description: "desc", imageUrl: "", isAIGenerated: false, source: "auto" },
          { id: "char-4", name: "Hero 4", description: "desc", imageUrl: "", isAIGenerated: false, source: "auto" },
        ] as PersistedVideoProject["characters"],
        sceneSettings: [],
        imageGenerationPrefs: {
          familyKey: "gpt-image-2",
          resolution: "4k",
          aspectRatio: "16:9",
          styleCategory: "realistic",
          stylePreset: "live-action",
          viewMode: "three",
        },
        currentStep: 2,
      }),
    );

    const result = await generateVideoReferenceAssetsAction(
      {
        smartBatch: true,
        targetIds: [
          "reference-character:char-1",
          "reference-character:char-2",
          "reference-character:char-3",
          "reference-character:char-4",
        ],
      },
      runtime,
    );

    expect(invokeFunction).toHaveBeenCalledTimes(2);
    expect(result.summary).toContain("2/4");
  });

  it("keeps smart reference batches retryable when a primary reference fails before variants", async () => {
    invokeFunction.mockResolvedValue({
      data: null,
      error: new Error("provider timeout"),
    });

    const runtime = createRuntime(
      createVideoProject({
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "Main character reference",
            imageUrl: "",
            isAIGenerated: false,
            source: "auto",
            costumes: [{ id: "cost-1", label: "校服", description: "蓝白校服", isAIGenerated: false }],
          },
        ],
        sceneSettings: [],
        currentStep: 2,
      }),
    );

    const result = await generateVideoReferenceAssetsAction(
      {
        smartBatch: true,
        targetIds: [
          "reference-character:char-1",
          "reference-character-variant:char-1:cost-1",
        ],
      },
      runtime,
    );

    expect(invokeFunction).toHaveBeenCalledTimes(3);
    expect(result.summary).toContain("自动重试了 2 次");
    expect(result.summary).toContain("1 个生成失败");
    expect(result.summary).toContain("1 个变体因主参考图缺失已跳过");
    expect(result.remainingTargetIds).toEqual([]);
    expect(result.data?.videoProject?.characters?.[0]?.imageUrl).toBe("");
    expect(result.data?.videoProject?.characters?.[0]?.costumes?.[0]?.imageUrl).toBeUndefined();
    expect(result.data?.videoProject?.automationState?.referenceTargets).toEqual(
      expect.objectContaining({
        "reference-character:char-1": expect.objectContaining({
          status: "exhausted",
          attemptCount: 3,
          retryBudget: 3,
        }),
        "reference-character-variant:char-1:cost-1": expect.objectContaining({
          status: "blocked",
          dependencyTargetIds: ["reference-character:char-1"],
        }),
      }),
    );
    expect(result.data?.videoProject?.reviewQueue).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "review:reference-character:char-1",
          targetIds: ["reference-character:char-1"],
          status: "pending",
        }),
      ]),
    );
  });

  it("keeps earlier generated reference assets in later onProgress snapshots", async () => {
    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-character") {
        return {
          data: { imageUrl: "https://media.storyforge.test/generated-character.jpg" },
          error: null,
        };
      }
      if (name === "generate-scene") {
        return {
          data: { imageUrl: "https://media.storyforge.test/generated-scene.jpg" },
          error: null,
        };
      }
      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "Main character reference",
            imageUrl: "",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        sceneSettings: [
          {
            id: "setting-1",
            name: "Warehouse",
            description: "Rainy alley environment",
            imageUrl: "",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        currentStep: 2,
      }),
    );
    const onProgress = vi.fn();

    await generateVideoReferenceAssetsAction({}, runtime, onProgress);

    const progressProjects = onProgress.mock.calls
      .map((call) => call[0]?.data?.videoProject)
      .filter(Boolean);
    expect(progressProjects).toHaveLength(2);
    const finalProgressProject = progressProjects.at(-1);
    expect(finalProgressProject?.characters?.[0]?.imageUrl).toBe("https://media.storyforge.test/generated-character.jpg");
    expect(finalProgressProject?.sceneSettings?.[0]?.imageUrl).toBe("https://media.storyforge.test/generated-scene.jpg");
    expect(upsertStoredVideoProject).toHaveBeenCalledTimes(1);
  });

  it("injects explicit visual-difference rules when generating character and scene variants", async () => {
    const capturedCalls: Array<{ name: string; body: Record<string, unknown> }> = [];

    invokeFunction.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      if (name !== "generate-character" && name !== "generate-scene") {
        throw new Error(`unexpected function: ${name}`);
      }
      capturedCalls.push({ name, body });
      return {
        data: {
          imageUrl: `https://media.storyforge.test/${name}-${capturedCalls.length}.jpg`,
        },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "黑色长风衣、短发、冷峻面部锚点",
            imageUrl: "https://media.storyforge.test/hero-primary.jpg",
            isAIGenerated: true,
            source: "auto",
            costumes: [
              {
                id: "cost-1",
                label: "染血战损版",
                description: "胸口和袖口被鲜血浸透，风衣下摆撕裂破损",
                isAIGenerated: false,
              },
            ],
          },
        ],
        sceneSettings: [
          {
            id: "scene-setting-1",
            name: "Warehouse",
            description: "冷色工业仓库，铁架、反光水泥地、入口卷帘门",
            imageUrl: "https://media.storyforge.test/warehouse-primary.jpg",
            isAIGenerated: true,
            source: "auto",
            timeVariants: [
              {
                id: "variant-1",
                label: "雷雨夜",
                description: "外部闪电频繁照亮仓库入口，地面积水反射冷蓝色光",
                isAIGenerated: false,
              },
            ],
          },
        ],
        currentStep: 2,
      }),
    );

    await generateVideoReferenceAssetsAction(
      {
        smartBatch: true,
        targetIds: [
          "reference-character-variant:char-1:cost-1",
          "reference-scene-variant:scene-setting-1:variant-1",
        ],
      },
      runtime,
    );

    const characterVariantCall = capturedCalls.find(
      (entry) => entry.name === "generate-character" && String(entry.body.referenceImageUrl || "").includes("hero-primary"),
    );
    const sceneVariantCall = capturedCalls.find(
      (entry) => entry.name === "generate-scene" && String(entry.body.referenceImageUrl || "").includes("warehouse-primary"),
    );

    expect(characterVariantCall?.body.description).toContain("本次只生成角色「染血战损版」这一套变体");
    expect(characterVariantCall?.body.description).toContain("必须让这张图与主参考图明显不同");
    expect(characterVariantCall?.body.description).toContain("不要回退成主参考图的默认版本");
    expect(sceneVariantCall?.body.description).toContain("本次只生成场景「雷雨夜」这一套变体");
    expect(sceneVariantCall?.body.description).toContain("必须让这张图与主参考图明显不同");
    expect(sceneVariantCall?.body.description).toContain("不要回退成主参考图的默认场景版本");
  });

  it("retries a character variant when distinctness QA says it duplicates a sibling variant", async () => {
    let generatedCount = 0;
    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "generate-character") {
        throw new Error(`unexpected function: ${name}`);
      }
      generatedCount += 1;
      return {
        data: {
          imageUrl: `https://media.storyforge.test/generated-character-variant-${generatedCount}.jpg`,
        },
        error: null,
      };
    });
    analyzeReferenceImageQuality.mockResolvedValue({
      inspected: true,
      summary: "角色质量合格，可作为变体参考图。",
      overallScore: 90,
      identityScore: 91,
      visualScore: 89,
      consistencyScore: 90,
      textPollutionVisible: false,
      watermarkVisible: false,
      deliverableReady: true,
      issues: [],
      qualityTier: "usable",
      strengths: ["主体完整"],
      goldenSignals: ["角色主体完整入镜"],
      fixPriorities: [],
    });
    analyzeReferenceVariantDistinctness
      .mockResolvedValueOnce({
        inspected: true,
        summary: "与兄弟变体“夜行版”差异过弱，容易复用成同一张参考图。",
        distinctEnough: false,
        similarityTier: "duplicate",
        comparedSiblingLabels: ["夜行版"],
        duplicateSiblingLabels: ["夜行版"],
        issues: ["与兄弟变体“夜行版”区分度不足"],
        fixPriorities: ["强化服装破损和血迹分布差异"],
      })
      .mockResolvedValueOnce({
        inspected: true,
        summary: "和兄弟变体区分明确，可以单独保留。",
        distinctEnough: true,
        similarityTier: "distinct",
        comparedSiblingLabels: ["夜行版"],
        duplicateSiblingLabels: [],
        issues: [],
        fixPriorities: [],
      });

    const runtime = createRuntime(
      createVideoProject({
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "黑色长风衣、短发、冷峻面部锚点",
            imageUrl: "https://media.storyforge.test/hero-primary.jpg",
            isAIGenerated: true,
            source: "auto",
            costumes: [
              {
                id: "cost-existing",
                label: "夜行版",
                description: "深色潜行风衣，干净无血迹",
                imageUrl: "https://media.storyforge.test/hero-night.jpg",
                isAIGenerated: true,
              },
              {
                id: "cost-target",
                label: "染血战损版",
                description: "胸口和袖口被鲜血浸透，风衣下摆撕裂破损",
                isAIGenerated: false,
              },
            ],
          },
        ],
        sceneSettings: [],
        currentStep: 2,
      }),
    );

    const result = await generateVideoReferenceAssetsAction(
      {
        smartBatch: true,
        targetIds: ["reference-character-variant:char-1:cost-target"],
      },
      runtime,
    );

    expect(invokeFunction).toHaveBeenCalledTimes(2);
    expect(analyzeReferenceVariantDistinctness).toHaveBeenCalledTimes(2);
    expect(analyzeReferenceVariantDistinctness).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        variantLabel: "染血战损版",
        siblingVariants: [
          expect.objectContaining({
            label: "夜行版",
            imageUrl: "https://media.storyforge.test/hero-night.jpg",
          }),
        ],
      }),
    );
    expect(result.summary).toContain("参考图 QA");
    expect(result.summary).toContain("拦截并重试 1 张候选图");
    expect(result.summary).toContain("与兄弟变体“夜行版”区分度不足");
    expect(result.data?.videoProject?.characters?.[0]?.costumes?.[1]?.imageUrl).toBe(
      "https://media.storyforge.test/generated-character-variant-2.jpg",
    );
    expect(
      result.data?.videoProject?.automationState?.referenceTargets?.["reference-character-variant:char-1:cost-target"],
    ).toEqual(
      expect.objectContaining({
        status: "ready",
        attemptCount: 2,
        lastQaPassed: true,
      }),
    );
  });

  it("escalates a scene variant into review when distinctness QA keeps rejecting duplicate-looking candidates", async () => {
    invokeFunction.mockResolvedValue({
      data: {
        imageUrl: "https://media.storyforge.test/generated-scene-variant.jpg",
      },
      error: null,
    });
    analyzeReferenceImageQuality.mockResolvedValue({
      inspected: true,
      summary: "场景质量合格，可作为时间变体参考图。",
      overallScore: 91,
      identityScore: 90,
      visualScore: 90,
      consistencyScore: 90,
      textPollutionVisible: false,
      watermarkVisible: false,
      deliverableReady: true,
      issues: [],
      qualityTier: "usable",
      strengths: ["空间结构稳定"],
      goldenSignals: ["空间锚点清楚"],
      fixPriorities: [],
    });
    analyzeReferenceVariantDistinctness.mockResolvedValue({
      inspected: true,
      summary: "和兄弟变体“暴雨夜”几乎是同一张图，无法支撑独立时间版本。",
      distinctEnough: false,
      similarityTier: "duplicate",
      comparedSiblingLabels: ["暴雨夜"],
      duplicateSiblingLabels: ["暴雨夜"],
      issues: ["与兄弟变体“暴雨夜”区分度不足"],
      fixPriorities: ["强化晨雾与天光方向差异"],
    });

    const runtime = createRuntime(
      createVideoProject({
        characters: [],
        sceneSettings: [
          {
            id: "scene-setting-1",
            name: "Warehouse",
            description: "冷色工业仓库，铁架、反光水泥地、入口卷帘门",
            imageUrl: "https://media.storyforge.test/warehouse-primary.jpg",
            isAIGenerated: true,
            source: "auto",
            timeVariants: [
              {
                id: "variant-existing",
                label: "暴雨夜",
                description: "入口闪电照亮积水地面",
                imageUrl: "https://media.storyforge.test/warehouse-storm-night.jpg",
                isAIGenerated: true,
              },
              {
                id: "variant-target",
                label: "清晨薄雾",
                description: "卷帘门外透入偏冷晨光，仓库内部漂浮薄雾",
                isAIGenerated: false,
              },
            ],
          },
        ],
        currentStep: 2,
      }),
    );

    const result = await generateVideoReferenceAssetsAction(
      {
        smartBatch: true,
        targetIds: ["reference-scene-variant:scene-setting-1:variant-target"],
      },
      runtime,
    );

    expect(invokeFunction).toHaveBeenCalledTimes(2);
    expect(analyzeReferenceVariantDistinctness).toHaveBeenCalledTimes(2);
    expect(result.summary).toContain("参考图 QA");
    expect(result.summary).toContain("转入 review");
    expect(result.summary).toContain("与兄弟变体“暴雨夜”区分度不足");
    expect(result.data?.videoProject?.reviewQueue).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetIds: ["reference-scene-variant:scene-setting-1:variant-target"],
          status: "pending",
        }),
      ]),
    );
    expect(
      result.data?.videoProject?.automationState?.referenceTargets?.[
        "reference-scene-variant:scene-setting-1:variant-target"
      ],
    ).toEqual(
      expect.objectContaining({
        status: "exhausted",
        attemptCount: 2,
        lastQaPassed: false,
        lastQaIssues: expect.arrayContaining(["与兄弟变体“暴雨夜”区分度不足"]),
        lastQaFixPriorities: expect.arrayContaining(["强化晨雾与天光方向差异"]),
      }),
    );
  });

  it("compares later variants against sibling images generated earlier in the same batch", async () => {
    let generatedCount = 0;
    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "generate-character") {
        throw new Error(`unexpected function: ${name}`);
      }
      generatedCount += 1;
      return {
        data: {
          imageUrl: `https://media.storyforge.test/generated-character-batch-${generatedCount}.jpg`,
        },
        error: null,
      };
    });
    analyzeReferenceImageQuality.mockResolvedValue({
      inspected: true,
      summary: "角色质量合格，可作为变体参考图。",
      overallScore: 90,
      identityScore: 91,
      visualScore: 89,
      consistencyScore: 90,
      textPollutionVisible: false,
      watermarkVisible: false,
      deliverableReady: true,
      issues: [],
      qualityTier: "usable",
      strengths: ["主体完整"],
      goldenSignals: ["角色主体完整入镜"],
      fixPriorities: [],
    });
    analyzeReferenceVariantDistinctness.mockImplementation(async (params) => ({
      inspected: true,
      summary: "区分度检查完成。",
      distinctEnough: true,
      similarityTier: "distinct",
      comparedSiblingLabels: params.siblingVariants?.map((item) => item.label) || [],
      duplicateSiblingLabels: [],
      issues: [],
      fixPriorities: [],
    }));

    const runtime = createRuntime(
      createVideoProject({
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "黑色长风衣、短发、冷峻面部锚点",
            imageUrl: "https://media.storyforge.test/hero-primary.jpg",
            isAIGenerated: true,
            source: "auto",
            costumes: [
              {
                id: "cost-1",
                label: "战损版",
                description: "左肩破损，前襟血迹明显",
                isAIGenerated: false,
              },
              {
                id: "cost-2",
                label: "潜行版",
                description: "衣摆收紧，去掉明显血迹，增加潜行装备",
                isAIGenerated: false,
              },
            ],
          },
        ],
        sceneSettings: [],
        currentStep: 2,
      }),
    );

    await generateVideoReferenceAssetsAction(
      {
        smartBatch: true,
        targetIds: [
          "reference-character-variant:char-1:cost-1",
          "reference-character-variant:char-1:cost-2",
        ],
      },
      runtime,
    );

    expect(analyzeReferenceVariantDistinctness).toHaveBeenCalledTimes(2);
    expect(analyzeReferenceVariantDistinctness).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        variantLabel: "战损版",
        siblingVariants: [],
      }),
    );
    expect(analyzeReferenceVariantDistinctness).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        variantLabel: "潜行版",
        siblingVariants: [
          expect.objectContaining({
            label: "战损版",
            imageUrl: "https://media.storyforge.test/generated-character-batch-1.jpg",
          }),
        ],
      }),
    );
  });

  it("runs independent reference asset generations concurrently", async () => {
    const firstGate = createDeferred<void>();
    const secondGate = createDeferred<void>();
    let inFlight = 0;
    let maxInFlight = 0;
    let callIndex = 0;

    setTimeout(() => firstGate.resolve(), 20);
    setTimeout(() => secondGate.resolve(), 20);

    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "generate-character" && name !== "generate-scene") {
        throw new Error(`unexpected function: ${name}`);
      }

      const currentCall = callIndex;
      callIndex += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await (currentCall === 0 ? firstGate.promise : secondGate.promise);
      inFlight -= 1;

      return {
        data: {
          imageUrl: currentCall === 0
            ? "https://media.storyforge.test/generated-character.jpg"
            : "https://media.storyforge.test/generated-scene.jpg",
        },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "Main character reference",
            imageUrl: "",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        sceneSettings: [
          {
            id: "setting-1",
            name: "Warehouse",
            description: "Rainy alley environment",
            imageUrl: "",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        currentStep: 2,
      }),
    );

    await generateVideoReferenceAssetsAction(
      {
        imageGenerationPrefs: {
          familyKey: "gpt-image-2",
          resolution: "1k",
          aspectRatio: "16:9",
          styleCategory: "realistic",
          stylePreset: "live-action",
          viewMode: "three",
        },
      },
      runtime,
    );

    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("does not treat a generated local file path as success when the file cannot be read back", async () => {
    window.electronAPI = {
      storage: {
        getDefaultPath: vi.fn(async () => ({ files: "D:/StoryForgeFiles", db: "D:/StoryForgeDb" })),
        readBase64: vi.fn(async () => ({ ok: true, exists: false, base64: "" })),
      },
    } as unknown as typeof window.electronAPI;

    invokeFunction.mockResolvedValue({
      data: { imageUrl: "D:/StoryForgeFiles/projects/video-project-1/images/generated/characters/missing-generated.jpg" },
      error: null,
    });

    const runtime = createRuntime(
      createVideoProject({
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "Main character reference",
            imageUrl: "",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        sceneSettings: [],
        currentStep: 2,
      }),
    );

    const result = await generateVideoReferenceAssetsAction({ smartBatch: true }, runtime);

    expect(result.summary).toContain("1 个生成失败");
    expect(result.remainingTargetIds).toEqual([]);
    expect(result.data?.videoProject?.characters?.[0]?.imageUrl).toBe("");
  });

  it("retries a reference asset when image QA rejects the first candidate and reports QA in the summary", async () => {
    let generatedCount = 0;
    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "generate-character") {
        throw new Error(`unexpected function: ${name}`);
      }
      generatedCount += 1;
      return {
        data: { imageUrl: `https://media.storyforge.test/generated-character-${generatedCount}.jpg` },
        error: null,
      };
    });
    analyzeReferenceImageQuality
      .mockResolvedValueOnce({
        inspected: true,
        summary: "角色主体裁切过紧，脸部识别不稳定。",
        overallScore: 61,
        identityScore: 58,
        visualScore: 63,
        consistencyScore: 60,
        textPollutionVisible: false,
        watermarkVisible: false,
        deliverableReady: false,
        issues: ["主体不完整", "脸部识别不稳定"],
      })
      .mockResolvedValueOnce({
        inspected: true,
        summary: "角色身份稳定，可直接复用为后续参考图。",
        overallScore: 89,
        identityScore: 91,
        visualScore: 88,
        consistencyScore: 87,
        textPollutionVisible: false,
        watermarkVisible: false,
        deliverableReady: true,
        issues: [],
      });

    const runtime = createRuntime(
      createVideoProject({
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "Main character reference",
            imageUrl: "",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        sceneSettings: [],
        currentStep: 2,
      }),
    );

    const result = await generateVideoReferenceAssetsAction({ smartBatch: true }, runtime);

    expect(invokeFunction).toHaveBeenCalledTimes(2);
    expect(result.summary).toContain("参考图 QA");
    expect(result.summary).toContain("拦截并重试 1 张候选图");
    expect(result.data?.videoProject?.characters?.[0]?.imageUrl).toBe(
      "https://media.storyforge.test/generated-character-2.jpg",
    );
    expect(result.data?.videoProject?.automationState?.referenceTargets?.["reference-character:char-1"]).toEqual(
      expect.objectContaining({
        status: "ready",
        attemptCount: 2,
        lastQaPassed: true,
        lastQaScore: 89,
      }),
    );
  });

  it("retries a reference asset when image QA flags identical-looking people in a multi-person reference", async () => {
    let generatedCount = 0;
    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "generate-character") {
        throw new Error(`unexpected function: ${name}`);
      }
      generatedCount += 1;
      return {
        data: { imageUrl: `https://media.storyforge.test/generated-duo-${generatedCount}.jpg` },
        error: null,
      };
    });
    analyzeReferenceImageQuality
      .mockResolvedValueOnce({
        inspected: true,
        summary: "双人跟班被画成了同脸同装的复制体，不适合作为双人角色参考图。",
        overallScore: 90,
        identityScore: 89,
        visualScore: 88,
        consistencyScore: 87,
        unintendedDuplicatePeopleVisible: true,
        textPollutionVisible: false,
        watermarkVisible: false,
        deliverableReady: true,
        qualityTier: "fail",
        strengths: ["主体完整", "构图清楚"],
        goldenSignals: ["主体完整入镜"],
        fixPriorities: ["把两个人的脸部锚点和服装细节区分开"],
        issues: ["两个人物看起来像同一个人被复制，缺少可区分的人物差异"],
      })
      .mockResolvedValueOnce({
        inspected: true,
        summary: "双人角色区分明确，可以作为后续双人参考图。",
        overallScore: 89,
        identityScore: 90,
        visualScore: 87,
        consistencyScore: 88,
        unintendedDuplicatePeopleVisible: false,
        textPollutionVisible: false,
        watermarkVisible: false,
        deliverableReady: true,
        qualityTier: "usable",
        strengths: ["两个人物面部锚点清楚", "服装层次明确"],
        goldenSignals: ["角色主体完整入镜"],
        fixPriorities: [],
        issues: [],
      });

    const runtime = createRuntime(
      createVideoProject({
        characters: [
          {
            id: "char-1",
            name: "执法双人组",
            description: "双人角色设定，同框站立，两个跟班都要清楚可区分，不能像复制人。",
            imageUrl: "",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        sceneSettings: [],
        currentStep: 2,
      }),
    );

    const result = await generateVideoReferenceAssetsAction({ smartBatch: true }, runtime);

    expect(invokeFunction).toHaveBeenCalledTimes(2);
    expect(result.summary).toContain("参考图 QA");
    expect(result.summary).toContain("拦截并重试 1 张候选图");
    expect(result.summary).toContain("同一个人被复制");
    expect(result.data?.videoProject?.characters?.[0]?.imageUrl).toBe(
      "https://media.storyforge.test/generated-duo-2.jpg",
    );
    expect(result.data?.videoProject?.automationState?.referenceTargets?.["reference-character:char-1"]).toEqual(
      expect.objectContaining({
        status: "ready",
        attemptCount: 2,
        lastQaPassed: true,
        lastQaScore: 89,
      }),
    );
  });

  it("does not retry a reference asset just because image QA sees text or watermark pollution", async () => {
    invokeFunction.mockResolvedValue({
      data: { imageUrl: "https://media.storyforge.test/generated-character-with-overlay.jpg" },
      error: null,
    });
    analyzeReferenceImageQuality.mockResolvedValue({
      inspected: true,
      summary: "角色锚点稳定，仅检测到上屏文字和水印，可作为当前参考图使用。",
      overallScore: 88,
      identityScore: 90,
      visualScore: 86,
      consistencyScore: 87,
      textPollutionVisible: true,
      watermarkVisible: true,
      deliverableReady: false,
      issues: ["检测到上屏文字覆盖", "右下角存在轻微水印"],
      qualityTier: "usable",
      strengths: ["角色身份稳定", "服装轮廓清楚"],
      goldenSignals: ["角色主体完整入镜"],
      fixPriorities: ["后续如有时间可清理右下角水印"],
    });

    const runtime = createRuntime(
      createVideoProject({
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "Main character reference",
            imageUrl: "",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        sceneSettings: [],
        currentStep: 2,
      }),
    );

    const result = await generateVideoReferenceAssetsAction({ smartBatch: true }, runtime);

    expect(invokeFunction).toHaveBeenCalledTimes(1);
    expect(result.summary).toContain("拦截并重试 0 张候选图");
    expect(result.summary).not.toContain("转入 review");
    expect(result.data?.videoProject?.characters?.[0]?.imageUrl).toBe(
      "https://media.storyforge.test/generated-character-with-overlay.jpg",
    );
    expect(result.data?.videoProject?.automationState?.referenceTargets?.["reference-character:char-1"]).toEqual(
      expect.objectContaining({
        status: "ready",
        attemptCount: 1,
        lastQaPassed: true,
        lastQaScore: 88,
      }),
    );
  });

  it("retries a character variant when image QA says the candidate style drifts away from the current project style", async () => {
    let generatedCount = 0;
    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "generate-character") {
        throw new Error(`unexpected function: ${name}`);
      }
      generatedCount += 1;
      return {
        data: {
          imageUrl: `https://media.storyforge.test/generated-character-style-${generatedCount}.jpg`,
        },
        error: null,
      };
    });
    analyzeReferenceImageQuality
      .mockResolvedValueOnce({
        inspected: true,
        summary: "项目要求现代都市写实，但候选图呈现古风插画人物造型，风格不统一。",
        overallScore: 91,
        identityScore: 90,
        visualScore: 92,
        consistencyScore: 89,
        styleMismatchVisible: true,
        textPollutionVisible: false,
        watermarkVisible: false,
        deliverableReady: true,
        issues: ["项目是现代都市写实，但候选图偏古风插画人物造型"],
        qualityTier: "borderline",
        strengths: ["主体完整", "画面清晰"],
        goldenSignals: ["主体完整入镜"],
        fixPriorities: ["改回现代都市写实服装和渲染方式"],
      })
      .mockResolvedValueOnce({
        inspected: true,
        summary: "角色风格与项目一致，可作为变体参考图。",
        overallScore: 90,
        identityScore: 90,
        visualScore: 89,
        consistencyScore: 90,
        styleMismatchVisible: false,
        textPollutionVisible: false,
        watermarkVisible: false,
        deliverableReady: true,
        issues: [],
        qualityTier: "usable",
        strengths: ["现代写实角色锚点稳定"],
        goldenSignals: ["角色主体完整入镜"],
        fixPriorities: [],
      });

    const runtime = createRuntime(
      createVideoProject({
        artStyle: "live-action",
        styleLock: {
          genre: ["现代都市", "现实向悬疑"],
          tone: "冷峻压迫",
          visualStyle: "现代都市夜景写实，避免古风和插画感",
          colorMood: "冷蓝霓虹",
          cinematography: "贴身跟拍",
        },
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "黑色长风衣、现代都市调查员",
            imageUrl: "https://media.storyforge.test/hero-primary.jpg",
            isAIGenerated: true,
            source: "auto",
            costumes: [
              {
                id: "cost-target",
                label: "雨夜潜行版",
                description: "同一位现代调查员，在雨夜里加深冷蓝霓虹反光",
                isAIGenerated: false,
              },
            ],
          },
        ],
        sceneSettings: [],
        currentStep: 2,
      }),
    );

    const result = await generateVideoReferenceAssetsAction(
      {
        smartBatch: true,
        targetIds: ["reference-character-variant:char-1:cost-target"],
      },
      runtime,
    );

    expect(invokeFunction).toHaveBeenCalledTimes(2);
    expect(analyzeReferenceImageQuality).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        mode: "character",
        name: "Hero",
        projectStyleContext: expect.stringContaining("Selected render preset: live-action."),
      }),
    );
    expect(analyzeReferenceImageQuality).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        projectStyleContext: expect.stringContaining("Generation style token: live-action."),
      }),
    );
    expect(result.summary).toContain("参考图 QA");
    expect(result.summary).toContain("拦截并重试 1 张候选图");
    expect(result.summary).toContain("古风");
    expect(result.data?.videoProject?.characters?.[0]?.costumes?.[0]?.imageUrl).toBe(
      "https://media.storyforge.test/generated-character-style-2.jpg",
    );
    expect(
      result.data?.videoProject?.automationState?.referenceTargets?.["reference-character-variant:char-1:cost-target"],
    ).toEqual(
      expect.objectContaining({
        status: "ready",
        attemptCount: 2,
        lastQaPassed: true,
      }),
    );
  });

  it("escalates a reference asset into review when image QA keeps rejecting all retry attempts", async () => {
    invokeFunction.mockResolvedValue({
      data: { imageUrl: "https://media.storyforge.test/generated-character-rejected.jpg" },
      error: null,
    });
    analyzeReferenceImageQuality.mockResolvedValue({
      inspected: true,
      summary: "角色脸部和服装都不够稳定，不能作为长期参考图。",
      overallScore: 54,
      identityScore: 50,
      visualScore: 58,
      consistencyScore: 53,
      textPollutionVisible: false,
      watermarkVisible: false,
      deliverableReady: false,
      issues: ["脸部识别不稳定", "服装轮廓漂移"],
    });

    const runtime = createRuntime(
      createVideoProject({
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "Main character reference",
            imageUrl: "",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        sceneSettings: [],
        currentStep: 2,
      }),
    );

    const result = await generateVideoReferenceAssetsAction({ smartBatch: true }, runtime);

    expect(invokeFunction).toHaveBeenCalledTimes(3);
    expect(result.summary).toContain("参考图 QA");
    expect(result.summary).toContain("转入 review");
    expect(result.data?.videoProject?.reviewQueue).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetIds: ["reference-character:char-1"],
          status: "pending",
        }),
      ]),
    );
    expect(result.data?.videoProject?.automationState?.referenceTargets?.["reference-character:char-1"]).toEqual(
      expect.objectContaining({
        status: "exhausted",
        lastQaPassed: false,
      }),
    );
  });

  it("recomputes smart reference targets from broken local paths when the full-auto step resumes without explicit targetIds", async () => {
    window.electronAPI = {
      storage: {
        getDefaultPath: vi.fn(async () => ({ files: "D:/StoryForgeFiles", db: "D:/StoryForgeDb" })),
        readBase64: vi.fn(async (filePath: string) => ({
          ok: true,
          exists: filePath.includes("hero-fixed"),
          base64: filePath.includes("hero-fixed") ? "IMAGE_BASE64" : "",
          mimeType: "image/jpeg",
        })),
      },
    } as unknown as typeof window.electronAPI;

    invokeFunction.mockResolvedValue({
      data: { imageUrl: "D:/StoryForgeFiles/projects/video-project-1/images/generated/characters/hero-fixed.jpg" },
      error: null,
    });

    const runtime = createRuntime(
      createVideoProject({
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "Main character reference",
            imageUrl: "D:/OldFiles/projects/video-project-1/images/generated/characters/hero-old.jpg",
            isAIGenerated: true,
            source: "auto",
          },
        ],
        sceneSettings: [],
        currentStep: 2,
      }),
    );

    const result = await generateVideoReferenceAssetsAction({ smartBatch: true }, runtime);

    expect(invokeFunction).toHaveBeenCalledTimes(1);
    expect(result.data?.videoProject?.characters?.[0]?.imageUrl).toBe(
      "D:/StoryForgeFiles/projects/video-project-1/images/generated/characters/hero-fixed.jpg",
    );
  });

  it("passes only image-stage settings into storyboard generation", async () => {
    invokeFunction.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      if (name !== "generate-storyboard") {
        throw new Error(`unexpected function: ${name}`);
      }

      expect(body).toEqual(
        expect.objectContaining({
          description: "女主在雨夜回头看见追兵。",
          sceneName: "雨夜追击",
          style: "live-action",
          modelFamily: "doubao-seedream-3-0",
          selectedImageModelFamily: "doubao-seedream-3-0",
          imageGenerationPrefs: expect.objectContaining({
            familyKey: "doubao-seedream-3-0",
            aspectRatio: "16:9",
          }),
          aspectRatio: "16:9",
          resolution: "2k",
        }),
      );
      expect(body).not.toHaveProperty("referenceImageUrl");
      expect(body).not.toHaveProperty("selectedVideoModelKey");
      expect(body).not.toHaveProperty("videoGenerationPrefs");
      return {
        data: { imageUrl: "https://media.storyforge.test/generated-storyboard.jpg" },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "雨夜追击",
            description: "女主在雨夜回头看见追兵。",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "中景跟拍",
            duration: 5,
            storyboardUrl: "",
          },
        ],
        currentStep: 3,
      }),
    );

    const result = await generateStoryboardFramesAction(
      {
        selectedImageModelFamily: "doubao-seedream-3-0",
        imageGenerationPrefs: {
          familyKey: "doubao-seedream-3-0",
          resolution: "2k",
          aspectRatio: "16:9",
          styleCategory: "custom",
          stylePreset: "none",
          customStylePrompt: "",
        },
        aspectRatio: "16:9",
        resolution: "2k",
        referenceImageUrl: "https://media.storyforge.test/shared-reference.jpg",
        selectedVideoModelKey: "veo-3",
        videoGenerationPrefs: {
          modelKey: "veo-3",
          resolution: "1080p",
          mode: "image-to-video",
        },
      },
      runtime,
    );

    expect(invokeFunction).toHaveBeenCalledTimes(1);
    expect(result.imageUrls).toEqual(["https://media.storyforge.test/generated-storyboard.jpg"]);
  });

  it("limits storyboard smart fill to the current image-model batch size", async () => {
    let generatedIndex = 0;
    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "generate-storyboard") {
        throw new Error(`unexpected function: ${name}`);
      }

      generatedIndex += 1;
      return {
        data: { imageUrl: `https://media.storyforge.test/generated-storyboard-${generatedIndex}.jpg` },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: Array.from({ length: 4 }, (_, index) => ({
          id: `scene-${index + 1}`,
          sceneNumber: index + 1,
          sceneName: `Scene ${index + 1}`,
          description: `scene ${index + 1}`,
          characters: ["Hero"],
          dialogue: "",
          cameraDirection: "中景",
          duration: 5,
          storyboardUrl: "",
        })) as PersistedVideoProject["scenes"],
        characters: [{ id: "char-1", name: "Hero", description: "desc", imageUrl: "hero.png" }] as PersistedVideoProject["characters"],
        sceneSettings: Array.from({ length: 4 }, (_, index) => ({
          id: `setting-${index + 1}`,
          name: `Scene ${index + 1}`,
          description: "desc",
          imageUrl: `scene-${index + 1}.png`,
        })) as PersistedVideoProject["sceneSettings"],
        currentStep: 3,
      }),
    );

    const result = await generateStoryboardFramesAction(
      {
        smartBatch: true,
        imageGenerationPrefs: {
          familyKey: "gpt-image-2",
          resolution: "4k",
          aspectRatio: "16:9",
          styleCategory: "realistic",
          stylePreset: "live-action",
          viewMode: "three",
        },
        targetIds: ["scene-1", "scene-2", "scene-3", "scene-4"],
      },
      runtime,
    );

    expect(invokeFunction).toHaveBeenCalledTimes(2);
    expect(result.summary).toContain("本轮按当前生图模型上限处理 2/4 张分镜图。");
    expect(result.summary).toContain("还剩 2 张，继续点击同一个按钮会补下一批。");
    expect(result.data?.videoProject?.scenes.filter((scene) => Boolean(scene.storyboardUrl)).map((scene) => scene.id)).toEqual([
      "scene-1",
      "scene-2",
    ]);
  });

  it("uses the project's current image-model limit for storyboard smart fill when input omits image prefs", async () => {
    let generatedIndex = 0;
    invokeFunction.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      if (name !== "generate-storyboard") {
        throw new Error(`unexpected function: ${name}`);
      }

      expect(body).toEqual(expect.objectContaining({
        modelFamily: "gpt-image-2",
        selectedImageModelFamily: "gpt-image-2",
        resolution: "4k",
        aspectRatio: "16:9",
        imageGenerationPrefs: expect.objectContaining({
          familyKey: "gpt-image-2",
          resolution: "4k",
          aspectRatio: "16:9",
        }),
      }));

      generatedIndex += 1;
      return {
        data: { imageUrl: `https://media.storyforge.test/generated-storyboard-${generatedIndex}.jpg` },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: Array.from({ length: 4 }, (_, index) => ({
          id: `scene-${index + 1}`,
          sceneNumber: index + 1,
          sceneName: `Scene ${index + 1}`,
          description: `scene ${index + 1}`,
          characters: ["Hero"],
          dialogue: "",
          cameraDirection: "中景",
          duration: 5,
          storyboardUrl: "",
        })) as PersistedVideoProject["scenes"],
        characters: [{ id: "char-1", name: "Hero", description: "desc", imageUrl: "hero.png" }] as PersistedVideoProject["characters"],
        sceneSettings: Array.from({ length: 4 }, (_, index) => ({
          id: `setting-${index + 1}`,
          name: `Scene ${index + 1}`,
          description: "desc",
          imageUrl: `scene-${index + 1}.png`,
        })) as PersistedVideoProject["sceneSettings"],
        imageGenerationPrefs: {
          familyKey: "gpt-image-2",
          resolution: "4k",
          aspectRatio: "16:9",
          styleCategory: "realistic",
          stylePreset: "live-action",
          viewMode: "three",
        },
        currentStep: 3,
      }),
    );

    const result = await generateStoryboardFramesAction(
      {
        smartBatch: true,
        targetIds: ["scene-1", "scene-2", "scene-3", "scene-4"],
      },
      runtime,
    );

    expect(invokeFunction).toHaveBeenCalledTimes(2);
    expect(result.summary).toContain("2/4");
  });

  it("keeps storyboard onProgress snapshots in memory until the final save", async () => {
    let generatedIndex = 0;
    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "generate-storyboard") {
        throw new Error(`unexpected function: ${name}`);
      }

      generatedIndex += 1;
      return {
        data: { imageUrl: `https://media.storyforge.test/generated-storyboard-${generatedIndex}.jpg` },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            description: "scene 1",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "中景",
            duration: 5,
            storyboardUrl: "",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "Scene 2",
            description: "scene 2",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "中景",
            duration: 5,
            storyboardUrl: "",
          },
        ] as PersistedVideoProject["scenes"],
        characters: [{ id: "char-1", name: "Hero", description: "desc", imageUrl: "hero.png" }] as PersistedVideoProject["characters"],
        sceneSettings: [
          { id: "setting-1", name: "Scene 1", description: "desc", imageUrl: "scene-1.png" },
          { id: "setting-2", name: "Scene 2", description: "desc", imageUrl: "scene-2.png" },
        ] as PersistedVideoProject["sceneSettings"],
        currentStep: 3,
      }),
    );
    const onProgress = vi.fn();

    await generateStoryboardFramesAction({}, runtime, onProgress);

    expect(onProgress.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(upsertStoredVideoProject).toHaveBeenCalledTimes(1);
  });

  it("runs storyboard generation concurrently for multiple scenes", async () => {
    const firstGate = createDeferred<void>();
    const secondGate = createDeferred<void>();
    let inFlight = 0;
    let maxInFlight = 0;
    let callIndex = 0;

    setTimeout(() => firstGate.resolve(), 20);
    setTimeout(() => secondGate.resolve(), 20);

    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "generate-storyboard") {
        throw new Error(`unexpected function: ${name}`);
      }

      const currentCall = callIndex;
      callIndex += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await (currentCall === 0 ? firstGate.promise : secondGate.promise);
      inFlight -= 1;

      return {
        data: { imageUrl: `https://media.storyforge.test/generated-storyboard-${currentCall + 1}.jpg` },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            description: "scene 1",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "中景",
            duration: 5,
            storyboardUrl: "",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "Scene 2",
            description: "scene 2",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "中景",
            duration: 5,
            storyboardUrl: "",
          },
        ] as PersistedVideoProject["scenes"],
        characters: [{ id: "char-1", name: "Hero", description: "desc", imageUrl: "hero.png" }] as PersistedVideoProject["characters"],
        sceneSettings: [
          { id: "setting-1", name: "Scene 1", description: "desc", imageUrl: "scene-1.png" },
          { id: "setting-2", name: "Scene 2", description: "desc", imageUrl: "scene-2.png" },
        ] as PersistedVideoProject["sceneSettings"],
        currentStep: 3,
      }),
    );

    await generateStoryboardFramesAction(
      {
        imageGenerationPrefs: {
          familyKey: "gpt-image-2",
          resolution: "1k",
          aspectRatio: "16:9",
          styleCategory: "realistic",
          stylePreset: "live-action",
          viewMode: "three",
        },
      },
      runtime,
    );

    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("shows the storyboard summary only when preparing a storyboard batch", async () => {
    const runtime = createRuntime(
      createVideoProject({
        currentStep: 2,
        storyboardPlan: "",
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            segmentLabel: "1-1",
            sceneName: "雨夜追击",
            description: "女主在雨夜回头看见追兵。",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "中景跟拍",
            duration: 5,
            storyboardUrl: "",
          },
        ],
      }),
    );

    const result = await prepareStoryboardBatchAction({ projectId: "video-project-1" }, runtime);

    expect(result.summary).toContain("已更新分镜摘要。");
    expect(result.summary).toContain("镜头总数：1");
    expect(result.summary).toContain("已生成分镜图：0 / 1");
    expect(result.summary).toContain("当前可生成分镜图：0 / 1");
    expect(result.summary).toContain("缺素材镜头：1 / 1");
    expect(result.summary).toContain("## 片段 1-1｜雨夜追击（已生成 0 / 可生成 0 / 缺素材 1）");
    expect(result.summary).toContain("| 镜头编号 | 名称 | 分镜图状态 | 角色参考 | 场景参考 |");
    expect(result.summary).toContain("| 镜头 1 | 雨夜追击 | 缺场景参考 | 沈昭 | 待匹配 |");
  });

  it("updates storyboard data after generation without surfacing the batch summary in chat", async () => {
    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "generate-storyboard") {
        throw new Error(`unexpected function: ${name}`);
      }

      return {
        data: { imageUrl: "https://example.com/generated-storyboard.jpg" },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "雨夜追击",
            description: "女主在雨夜回头看见追兵。",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "中景跟拍",
            duration: 5,
            storyboardUrl: "",
          },
        ],
        currentStep: 3,
      }),
    );

    const result = await generateStoryboardFramesAction({}, runtime);

    expect(result.imageUrls).toEqual(["https://example.com/generated-storyboard.jpg"]);
    expect(result.summary).toBe("已生成 1 张分镜图。");
    expect(result.summary).not.toContain("镜头总数");
    expect(result.data?.videoProject?.storyboardPlan).toContain(
      "## 片段 未分组｜雨夜追击（已生成 1 / 可生成 0 / 缺素材 0）",
    );
    expect(result.data?.videoProject?.storyboardPlan).toContain(
      "| 镜头编号 | 名称 | 分镜图状态 | 角色参考 | 场景参考 |",
    );
  });

  it("infers character single-image requests instead of defaulting them to scene generation", async () => {
    invokeFunction.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      expect(name).toBe("generate-character");
      expect(body).toEqual(
        expect.objectContaining({
          name: "video-project-1",
          description: "帮我画一张女主角半身像",
          style: "live-action",
        }),
      );
      return {
        data: { imageUrl: "https://example.com/generated-portrait.jpg" },
        error: null,
      };
    });

    const result = await generateProjectImageAction(
      {
        imagePrompt: "帮我画一张女主角半身像",
      },
      createRuntime(createVideoProject({ title: "video-project-1" })),
    );

    expect(result.imageUrls).toEqual(["https://example.com/generated-portrait.jpg"]);
  });

  it("logs the image prompt before the 3-second submission guard and only submits afterwards", async () => {
    vi.useFakeTimers();
    __setVideoWorkflowMediaSubmissionGuardDelayForTests(3000);
    invokeFunction.mockResolvedValue({
      data: { imageUrl: "https://example.com/generated-portrait.jpg" },
      error: null,
    });

    const onProgress = vi.fn();
    const pending = generateProjectImageAction(
      {
        imagePrompt: "帮我画一张女主角半身像",
      },
      createRuntime(createVideoProject({ title: "video-project-1" })),
      onProgress,
    );

    await Promise.resolve();
    expect(onProgress.mock.calls[0]?.[0]?.summary).toContain("提交内容：");
    expect(onProgress.mock.calls[0]?.[0]?.summary).toContain("帮我画一张女主角半身像");
    expect(onProgress.mock.calls[0]?.[0]?.summary).toContain("3 秒防误触保护");
    const result = await pending;

    expect(invokeFunction).toHaveBeenCalledTimes(1);
    expect(result.imageUrls).toEqual(["https://example.com/generated-portrait.jpg"]);

    vi.useRealTimers();
  });

  it("prefers the latest imageGenerationPrefs style over a stale project artStyle for project image generation", async () => {
    invokeFunction.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      expect(name).toBe("generate-character");
      expect(body).toEqual(
        expect.objectContaining({
          style: "anime-3d",
          imageGenerationPrefs: expect.objectContaining({
            styleCategory: "animation-3d",
            stylePreset: "anime-3d",
          }),
        }),
      );
      return {
        data: { imageUrl: "https://example.com/generated-anime-portrait.jpg" },
        error: null,
      };
    });

    const result = await generateProjectImageAction(
      {
        imagePrompt: "帮我画一张女主角半身像",
        imageGenerationPrefs: {
          familyKey: "gpt-image-2",
          resolution: "default",
          aspectRatio: "16:9",
          styleCategory: "animation-3d",
          stylePreset: "anime-3d",
          viewMode: "three",
        },
      },
      createRuntime(createVideoProject({ title: "video-project-1", artStyle: "live-action" })),
    );

    expect(result.imageUrls).toEqual(["https://example.com/generated-anime-portrait.jpg"]);
  });

  it("auto-corrects single-view character generation away from unsupported 16:9 before submit", async () => {
    invokeFunction.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      expect(name).toBe("generate-character");
      expect(body).toEqual(
        expect.objectContaining({
          aspectRatio: "9:16",
          viewMode: "single",
          imageGenerationPrefs: expect.objectContaining({
            aspectRatio: "9:16",
            viewMode: "single",
          }),
        }),
      );
      return {
        data: { imageUrl: "https://example.com/generated-single-character.jpg" },
        error: null,
      };
    });

    const result = await generateProjectImageAction(
      {
        imagePrompt: "给我一张女主正面单图角色卡",
        imageGenerationPrefs: {
          familyKey: "gpt-image-2",
          resolution: "default",
          aspectRatio: "16:9",
          styleCategory: "realistic",
          stylePreset: "live-action",
          viewMode: "single",
        },
      },
      createRuntime(createVideoProject({ title: "video-project-1", artStyle: "live-action" })),
    );

    expect(result.imageUrls).toEqual(["https://example.com/generated-single-character.jpg"]);
  });

  it("logs the video submission summary before the 3-second guard and only submits afterwards", async () => {
    vi.useFakeTimers();
    __setVideoWorkflowMediaSubmissionGuardDelayForTests(3000);
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });
    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "enhance-video-prompt") {
        return {
          data: { enhanced: "增强后的视频提示词", duration: 6 },
          error: null,
        };
      }

      if (name === "generate-video") {
        return {
          data: { task_id: "task-seedance-1", status: "completed", provider: "jimeng" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const onProgress = vi.fn();
    const pending = generateVideoAssetsAction(
      {},
      createRuntime(
        createVideoProject({
          videoGenerationPrefs: {
            modelKey: "doubao-seedance-1-5-pro",
            resolution: "720p",
            mode: "image-to-video",
          },
        }),
      ),
      onProgress,
    );

    await Promise.resolve();
    expect(onProgress.mock.calls[0]?.[0]?.summary).toContain("已整理 1 条镜头视频生成任务");
    expect(onProgress.mock.calls[0]?.[0]?.summary).toContain("女主在雨夜回头看见追兵");
    expect(onProgress.mock.calls[0]?.[0]?.summary).toContain("3 秒防误触保护");
    const result = await pending;

    const summaries = onProgress.mock.calls.map((call) => String(call[0]?.summary || ""));
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.stringContaining("已提交到 Seedance / Ark"),
      ]),
    );
    expect(invokeFunction).toHaveBeenCalled();
    expect(result.summary).toContain("已提交 1 条镜头出片任务");

    vi.useRealTimers();
  });

  it("submits homepage video generation through the default low-cost Seedance 720p API model", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "enhance-video-prompt") {
        return {
          data: { enhanced: "增强后的视频提示词", duration: 6 },
          error: null,
        };
      }

      if (name === "generate-video") {
        return {
          data: { task_id: "task-seedance-1", status: "completed", provider: "jimeng" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(createVideoProject({
      videoGenerationPrefs: {
        modelKey: "doubao-seedance-1-5-pro",
        resolution: "720p",
        mode: "image-to-video",
      },
    }));
    const result = await generateVideoAssetsAction({}, runtime);
    const scene = result.data?.videoProject?.scenes[0];
    const enhanceArgs = invokeFunction.mock.calls.find(([name]) => name === "enhance-video-prompt")?.[1];
    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];

    expect(enhanceArgs).toEqual(
      expect.objectContaining({
        referenceImageUrl: "https://media.storyforge.test/storyboard-1.jpg",
      }),
    );
    expect(generateArgs).toEqual(
      expect.objectContaining({
        provider: "jimeng",
        model: "doubao-seedance-1-5-pro_720p",
        resolution: "720p",
        duration: 6,
      }),
    );
    expect(generateArgs).toHaveProperty("imageUrl", "https://media.storyforge.test/storyboard-1.jpg");
    expect(scene?.videoTaskId).toBe("task-seedance-1");
    expect(scene?.videoProvider).toBe("jimeng");
    expect(scene?.videoStatus).toBe("completed");
    expect(result.data?.videoProject?.videoGenerationPrefs).toEqual({
      modelKey: "doubao-seedance-1-5-pro",
      resolution: "720p",
      mode: "image-to-video",
    });
    expect(result.summary).toContain("已提交 1 条镜头出片任务");
  });

  it("submits Seedance 2.0 Fast through the same workflow panel and normalizes unsupported 1080p down to 720p", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "enhance-video-prompt") {
        return {
          data: { enhanced: "enhanced seedance 2.0 fast prompt", duration: 6 },
          error: null,
        };
      }

      if (name === "generate-video") {
        return {
          data: { task_id: "task-seedance-2-fast", status: "completed", provider: "jimeng" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(createVideoProject({
      videoGenerationPrefs: {
        modelKey: "doubao-seedance-2-0-fast-260128",
        resolution: "1080p",
        mode: "image-to-video",
      },
    }));
    const result = await generateVideoAssetsAction({}, runtime);
    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];

    expect(generateArgs).toEqual(
      expect.objectContaining({
        provider: "jimeng",
        model: "doubao-seedance-2-0-fast-260128",
        resolution: "720p",
        duration: 6,
        imageUrl: "https://media.storyforge.test/storyboard-1.jpg",
      }),
    );
    expect(result.data?.videoProject?.videoGenerationPrefs).toEqual({
      modelKey: "doubao-seedance-2-0-fast-260128",
      resolution: "720p",
      mode: "image-to-video",
    });
  });

  it("routes Seedance 2.0 2K homepage generation through the RunningHub transport without adding new panel params", async () => {
    saveApiConfig({
      jimengExecutionMode: "api",
      jimengKey: "test-jimeng-key",
      runninghubKey: "test-runninghub-key",
      runninghubEndpoint: "https://www.runninghub.cn",
    });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "enhance-video-prompt") {
        return {
          data: { enhanced: "enhanced seedance 2.0 2k prompt", duration: 6 },
          error: null,
        };
      }

      if (name === "generate-video") {
        return {
          data: { task_id: "task-seedance-2k", status: "completed", provider: "runninghub-seedance" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(createVideoProject({
      videoGenerationPrefs: {
        modelKey: "doubao-seedance-2-0-260128",
        resolution: "2k",
        mode: "image-to-video",
      },
    }));
    const result = await generateVideoAssetsAction({}, runtime);
    const scene = result.data?.videoProject?.scenes[0];
    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];

    expect(generateArgs).toEqual(
      expect.objectContaining({
        provider: "runninghub-seedance",
        model: "doubao-seedance-2-0-260128",
        resolution: "2k",
        duration: 6,
        imageUrl: "https://media.storyforge.test/storyboard-1.jpg",
      }),
    );
    expect(result.data?.videoProject?.videoGenerationPrefs).toEqual({
      modelKey: "doubao-seedance-2-0-260128",
      resolution: "2k",
      mode: "image-to-video",
    });
    expect(scene?.videoTaskId).toBe("task-seedance-2k");
    expect(scene?.videoProvider).toBe("runninghub-seedance");
    expect(scene?.videoStatus).toBe("completed");
  });

  it("does not expose exact script dialogue in the prompt submitted to the video model", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "enhance-video-prompt") {
        return {
          data: { enhanced: "女主停步回头，slow push-in，no subtitles，no watermark。", duration: 6 },
          error: null,
        };
      }

      if (name === "generate-video") {
        return {
          data: { task_id: "task-dialogue-lock", status: "completed", provider: "jimeng" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const exactDialogue = "Hero: Keep this line exactly.";
    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Dialogue lock scene",
            description: "Hero faces the camera.",
            characters: ["Hero"],
            dialogue: exactDialogue,
            cameraDirection: "close-up",
            duration: 5,
            storyboardUrl: "https://media.storyforge.test/storyboard-1.jpg",
          },
        ],
      }),
    );

    await generateVideoAssetsAction({}, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    expect(generateArgs?.prompt).toContain("缓慢推进");
    expect(generateArgs?.prompt).toContain("无字幕");
    expect(generateArgs?.prompt).toContain("无水印");
    expect(generateArgs?.prompt).toContain("女主停步回头，6秒，缓慢推进。");
    expect(generateArgs?.prompt).toContain("\n\n通用后缀： 无字幕、无水印、无屏幕文字");
    expect(generateArgs?.prompt?.match(/无字幕/g)?.length).toBe(1);
    expect(generateArgs?.prompt?.match(/无水印/g)?.length).toBe(1);
    expect(generateArgs?.prompt).not.toContain(exactDialogue);
    expect(generateArgs?.prompt).not.toContain("台词（仅音频/口型，不以上屏文字呈现）");
    expect(generateArgs?.prompt).not.toContain("台词：无台词。");
    expect(generateArgs?.prompt).not.toContain("瑙嗚閿氱偣锛?");
    expect(generateArgs?.prompt).not.toContain("闀滃ご鎺ㄨ繘锛?");
    expect(generateArgs?.prompt).not.toContain("slow push-in");
    expect(generateArgs?.prompt).not.toContain("no subtitles");
    expect(generateArgs?.prompt).not.toContain("【精确台词锁定】");
    expect(generateArgs?.prompt).not.toContain("【无台词锁定】");
  });

  it("submits storyboard reference images when image-to-video mode is selected", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "enhance-video-prompt") {
        return {
          data: { enhanced: "enhanced image to video prompt", duration: 6 },
          error: null,
        };
      }

      if (name === "generate-video") {
        return {
          data: { task_id: "task-seedance-i2v-1", status: "completed", provider: "jimeng" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "image-to-video",
        },
      }),
    );
    const result = await generateVideoAssetsAction({}, runtime);
    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];

    expect(generateArgs).toEqual(
      expect.objectContaining({
        provider: "jimeng",
        model: "doubao-seedance-1-5-pro_720p",
        resolution: "720p",
        duration: 6,
        imageUrl: "https://media.storyforge.test/storyboard-1.jpg",
      }),
    );
    expect(result.data?.videoProject?.videoGenerationPrefs).toEqual({
      modelKey: "doubao-seedance-1-5-pro",
      resolution: "720p",
      mode: "image-to-video",
    });
  });

  it("submits aggregated multi-reference images for Seedance 2.0 text-to-video when multiple references are available", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "enhance-video-prompt") {
        return {
          data: { enhanced: "enhanced seedance 2.0 text prompt", duration: 6 },
          error: null,
        };
      }

      if (name === "generate-video") {
        return {
          data: { task_id: "task-seedance-2-0-t2v-multi-ref", status: "completed", provider: "jimeng" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-2-0-260128",
          resolution: "720p",
          mode: "text-to-video",
        },
        sceneSettings: [
          {
            id: "setting-1",
            name: "雨夜追击",
            description: "冷色夜雨中的长街",
            imageUrl: "https://media.storyforge.test/scene-1.jpg",
            isAIGenerated: false,
            source: "auto",
          },
        ],
      }),
    );

    await generateVideoAssetsAction({}, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    expect(generateArgs).toEqual(
      expect.objectContaining({
        model: "doubao-seedance-2-0-260128",
        resolution: "720p",
        duration: 6,
        imageUrl: "https://media.storyforge.test/scene-1.jpg",
        videoMode: "text-to-video",
      }),
    );
    expect(generateArgs?.referenceImageUrls).toEqual([
      "https://media.storyforge.test/scene-1.jpg",
      "https://media.storyforge.test/char-1.jpg",
    ]);
  });

  it("passes character audio references through the scene video submission payload", async () => {
    saveApiConfig({
      jimengExecutionMode: "api",
      jimengKey: "test-jimeng-key",
      runninghubKey: "test-runninghub-key",
      runninghubEndpoint: "https://www.runninghub.cn",
    });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "enhance-video-prompt") {
        return {
          data: { enhanced: "enhanced prompt with audio reference", duration: 6 },
          error: null,
        };
      }

      if (name === "generate-video") {
        return {
          data: { task_id: "task-seedance-audio-1", status: "completed", provider: "runninghub-seedance" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-2-0-260128",
          resolution: "2k",
          mode: "image-to-video",
        },
        characters: [
          {
            id: "char-1",
            name: "沈昭",
            description: "红衣、清冷、警觉",
            imageUrl: "https://media.storyforge.test/char-1.jpg",
            audioUrl: "E:\\audio\\shen-zhao-reference.wav",
            audioFileName: "shen-zhao-reference.wav",
            isAIGenerated: false,
            source: "auto",
          },
        ] as PersistedVideoProject["characters"],
      }),
    );

    await generateVideoAssetsAction({}, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    expect(generateArgs).toEqual(
      expect.objectContaining({
        provider: "runninghub-seedance",
        audioUrls: ["E:\\audio\\shen-zhao-reference.wav"],
      }),
    );
  });

  it("passes one visible HappyHorse model plus aggregated reference images into the RunningHub HappyHorse transport", async () => {
    saveApiConfig({
      aliyunKey: "test-aliyun-key",
      aliyunEndpoint: "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
      runninghubKey: "test-runninghub-key",
      runninghubEndpoint: "https://www.runninghub.cn",
    });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "enhance-video-prompt") {
        return {
          data: { enhanced: "enhanced happyhorse prompt", duration: 6 },
          error: null,
        };
      }

      if (name === "generate-video") {
        return {
          data: { task_id: "task-happyhorse-1", status: "completed", provider: "runninghub-happyhorse" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        videoGenerationPrefs: {
          modelKey: "happyhorse-1.0",
          resolution: "1080p",
          mode: "image-to-video",
        },
      }),
    );

    await generateVideoAssetsAction({}, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    expect(generateArgs).toEqual(
      expect.objectContaining({
        provider: "runninghub-happyhorse",
        model: "happyhorse-1.0",
        resolution: "1080p",
        imageUrl: "https://media.storyforge.test/storyboard-1.jpg",
        videoMode: "image-to-video",
      }),
    );
    expect(generateArgs?.referenceImageUrls).toEqual([
      "https://media.storyforge.test/storyboard-1.jpg",
      "https://media.storyforge.test/char-1.jpg",
    ]);
  });

  it("allows targeted single-scene image-to-video generation when unrelated scenes still miss storyboard frames", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "enhance-video-prompt") {
        return {
          data: { enhanced: "single scene enhanced prompt", duration: 6 },
          error: null,
        };
      }

      if (name === "generate-video") {
        return {
          data: { task_id: "task-single-scene-1", status: "completed", provider: "jimeng" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        storyboardPlan: "镜头 1\n镜头 2",
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "image-to-video",
        },
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Ready Shot",
            description: "ready scene",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "中景",
            duration: 6,
            storyboardUrl: "https://media.storyforge.test/storyboard-1.jpg",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "Missing Shot",
            description: "missing storyboard scene",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "特写",
            duration: 6,
          },
        ],
      }),
    );

    const result = await generateVideoAssetsAction({ targetIds: ["scene-1"] }, runtime);
    const scene = result.data?.videoProject?.scenes.find((item) => item.id === "scene-1");

    expect(scene?.videoTaskId).toBe("task-single-scene-1");
    expect(scene?.videoStatus).toBe("completed");
    expect(result.summary).toContain("已提交 1 条镜头出片任务");
  });

  it("persists each completed scene video immediately and returns remaining scene ids for the next batch", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });
    let submitCount = 0;
    cacheProjectVideoSource.mockImplementation(async (remoteUrl: string) => ({
      localPath: remoteUrl.replace("https://example.com/", "E:/videos/"),
    }));
    invokeFunction.mockImplementation(async (name: string, payload: Record<string, unknown>) => {
      if (name !== "generate-video") {
        throw new Error(`unexpected function: ${name}`);
      }

      if (payload.action === "status") {
        const taskId = String(payload.taskId || "");
        return {
          data: { status: "completed", video_url: `https://example.com/${taskId}.mp4` },
          error: null,
        };
      }

      submitCount += 1;
      return {
        data: { task_id: `task-${submitCount}`, status: "queued", provider: "jimeng" },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
        characters: [],
        sceneSettings: [],
        scenes: Array.from({ length: 5 }, (_, index) => ({
          id: `scene-${index + 1}`,
          sceneNumber: index + 1,
          sceneName: `Scene ${index + 1}`,
          description: `Description ${index + 1}`,
          characters: [],
          dialogue: "",
          cameraDirection: "",
          duration: 6,
          enhancedVideoPrompt: `prompt scene-${index + 1}`,
        })) as PersistedVideoProject["scenes"],
      }),
    );
    const onProgress = vi.fn();

    vi.useFakeTimers();
    try {
      const resultPromise = generateVideoAssetsAction({ batchSize: 3 }, runtime, onProgress);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      const progressProjects = onProgress.mock.calls
        .map((call) => call[0]?.data?.videoProject)
        .filter(Boolean);
      expect(progressProjects).toHaveLength(3);
      expect(
        progressProjects
          .at(-1)
          ?.scenes.slice(0, 3)
          .every((scene: PersistedVideoProject["scenes"][number]) => !!scene.videoUrl),
      ).toBe(true);
      expect(result.remainingTargetIds).toEqual(["scene-4", "scene-5"]);
      expect(result.data?.videoProject?.scenes.slice(0, 3).map((scene) => scene.videoUrl)).toEqual([
        "E:/videos/task-1.mp4",
        "E:/videos/task-2.mp4",
        "E:/videos/task-3.mp4",
      ]);
      expect(upsertStoredVideoProject.mock.calls.length).toBeGreaterThanOrEqual(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("submits batched scene videos concurrently up to the active video model limit", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });

    const submitGate = createDeferred<void>();
    let inFlightSubmits = 0;
    let maxInFlightSubmits = 0;
    let submitCount = 0;

    cacheProjectVideoSource.mockImplementation(async (remoteUrl: string) => ({
      localPath: remoteUrl.replace("https://example.com/", "E:/videos/"),
    }));
    invokeFunction.mockImplementation(async (name: string, payload?: Record<string, unknown>) => {
      if (name === "generate-video" && payload?.action === "status") {
        const taskId = String(payload.taskId || "");
        return {
          data: { status: "completed", video_url: `https://example.com/${taskId}.mp4` },
          error: null,
        };
      }

      if (name === "generate-video") {
        submitCount += 1;
        inFlightSubmits += 1;
        maxInFlightSubmits = Math.max(maxInFlightSubmits, inFlightSubmits);
        await submitGate.promise;
        inFlightSubmits -= 1;
        return {
          data: { task_id: `task-concurrent-${submitCount}`, status: "queued", provider: "jimeng" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
        characters: [],
        sceneSettings: [],
        scenes: Array.from({ length: 3 }, (_, index) => ({
          id: `scene-${index + 1}`,
          sceneNumber: index + 1,
          sceneName: `Scene ${index + 1}`,
          description: `Description ${index + 1}`,
          characters: [],
          dialogue: "",
          cameraDirection: "",
          duration: 6,
          enhancedVideoPrompt: `prompt scene-${index + 1}`,
        })) as PersistedVideoProject["scenes"],
      }),
    );

    vi.useFakeTimers();
    try {
      const resultPromise = generateVideoAssetsAction({ batchSize: 3 }, runtime);
      await flushMicrotasks();

      expect(maxInFlightSubmits).toBeGreaterThan(1);

      submitGate.resolve();
      await vi.runAllTimersAsync();
      await resultPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not submit a scene reference image as first frame for text-to-video segment generation", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", status: "submitted", provider: "jimeng" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Warehouse",
            description: "Hero enters the warehouse.",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "wide tracking shot",
            duration: 6,
            segmentLabel: "1-1",
          },
        ],
        sceneSettings: [
          {
            id: "setting-warehouse",
            name: "Warehouse",
            description: "Cold industrial warehouse.",
            imageUrl: "https://example.com/warehouse-ref.jpg",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: [
              "全局风格：雨夜写实追击，6秒，slow push-in，no subtitles，no watermark。",
              "视觉锚点：冷色工业仓库，Hero 深色外套，潮湿反光地面。",
              "镜头推进：镜头1 0-3秒：Hero 冲入仓库后猛地回头搜寻；镜头2 3-6秒：跟拍横移，他贴墙转身继续前压。",
              "环境动态：门口雨水顺着铁门滴落，地面反光随着脚步轻晃。",
              "声音氛围：急促脚步回响，金属门轴轻响。",
              "台词：无台词。",
              "【镜头锚点补充】",
              "总时长 6秒，按顺序覆盖全部 2 个镜头。",
              "镜头1：Warehouse，Hero 冲入仓库后猛地回头搜寻，wide tracking shot，无台词。",
              "镜头2：Warehouse，跟拍横移，他贴墙转身继续前压，wide tracking shot，无台词。",
            ].join("；"),
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    await generateSegmentVideoAction({ segmentLabel: "1-1" }, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    expect(generateArgs).toEqual(
      expect.objectContaining({
        provider: "jimeng",
        model: "doubao-seedance-1-5-pro_720p",
        resolution: "720p",
        duration: 6,
      }),
    );
    expect(generateArgs?.prompt).toContain("缓慢推进");
    expect(generateArgs?.prompt).toContain("无字幕");
    expect(generateArgs?.prompt).toContain("无水印");
    expect(generateArgs?.prompt).toContain("雨夜写实追击，6秒，缓慢推进。");
    expect(generateArgs?.prompt).toContain("\n\n冷色工业仓库，Hero 深色外套，潮湿反光地面。");
    expect(generateArgs?.prompt).toContain("\n\n分镜1（0-3秒）：\nHero 冲入仓库后猛地回头搜寻。");
    expect(generateArgs?.prompt).toContain("\n\n分镜2（3-6秒）：\n跟拍横移，他贴墙转身继续前压。");
    expect(generateArgs?.prompt).not.toContain("\n\n起始衔接：\n");
    expect(generateArgs?.prompt).toContain("\n\n衔接原则：\n");
    expect(generateArgs?.prompt).toContain("\n\n环境细节：\n门口雨水顺着铁门滴落，地面反光随着脚步轻晃；急促脚步回响，金属门轴轻响。");
    expect(generateArgs?.prompt).toContain("\n\n通用后缀： 无字幕、无水印、无屏幕文字");
    expect(generateArgs?.prompt).not.toContain("【镜头锚点补充】");
    expect(generateArgs?.prompt).not.toContain("总时长 6秒，按顺序覆盖全部 2 个镜头");
    expect(generateArgs?.prompt).not.toContain("台词：无台词。");
    expect(generateArgs?.prompt).not.toContain("台词（仅音频/口型，不以上屏文字呈现）");
    expect(generateArgs?.prompt?.match(/无字幕/g)?.length).toBe(1);
    expect(generateArgs?.prompt?.match(/无水印/g)?.length).toBe(1);
    expect(generateArgs?.prompt).not.toContain("slow push-in");
    expect(generateArgs?.prompt).not.toContain("no subtitles");
    expect(generateArgs?.prompt).not.toContain("【无台词锁定】");
    expect(generateArgs).not.toHaveProperty("imageUrl");
  });

  it("lays out segment dialogue under the matching storyboard block", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", status: "submitted", provider: "jimeng" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Arena Intro",
            description: "苏辰虚弱倒在深坑里。",
            characters: ["苏辰", "叶昊"],
            dialogue: "",
            cameraDirection: "wide push-in",
            duration: 5,
            segmentLabel: "1-1",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "Arena Taunt",
            description: "叶昊俯视苏辰，冷笑嘲讽。",
            characters: ["苏辰", "叶昊"],
            dialogue: "叶昊：苏辰！没了这天生剑骨，你连给我擦鞋都不配！",
            cameraDirection: "close-up",
            duration: 5,
            segmentLabel: "1-1",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: [
              "全局风格：电影级真人武侠奇幻风格，10秒，氛围压抑粗粝。",
              "视觉锚点：烈日笼罩下的青云宗演武场，苏辰血脸破碎黑袍，叶昊白袍金色灵剑。",
              "镜头推进：0-5秒：电影感广角镜头缓缓推进，苏辰虚弱地躺在巨大深坑中。；5-10秒：超近景特写，苏辰染血右手死死攥住裂纹木剑，镜头缓缓转焦至叶昊冷漠轻蔑的面容。",
              "环境动态：尘土翻卷，碎石轻微震动。",
              "声音氛围：沉重喘息，远处弟子嘲笑。",
            ].join("；"),
            duration: 10,
            targetDuration: 10,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-1", "scene-2"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    await generateSegmentVideoAction({ segmentLabel: "1-1" }, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    expect(generateArgs?.prompt).toContain("\n\n分镜1（0-5秒）：\n电影感广角镜头缓缓推进，苏辰虚弱地躺在巨大深坑中。");
    expect(generateArgs?.prompt).toContain("\n\n分镜2（5-10秒）：\n苏辰染血右手死死攥住裂纹木剑，镜头缓缓转焦至叶昊冷漠轻蔑的面容。\n叶昊：苏辰！没了这天生剑骨，你连给我擦鞋都不配！");
    expect(generateArgs?.prompt).not.toContain("\n\n台词：");
    expect(generateArgs?.prompt).not.toContain("\n\n台词（仅音频/口型，不以上屏文字呈现）：");
    expect(generateArgs?.prompt).not.toContain("瑙嗚閿氱偣锛?");
    expect(generateArgs?.prompt).not.toContain("闀滃ご鎺ㄨ繘锛?");
  });

  it("keeps leaked prompt dialogue from jumping ahead of the script-mapped storyboard block", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", status: "submitted", provider: "jimeng" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "副本压制",
            description: "黑雾如巨兽吐息般翻涌，确立压抑死寂的地理空间。",
            characters: ["林萧", "赵峰"],
            dialogue: "",
            cameraDirection: "wide push-in",
            duration: 3,
            segmentLabel: "1-1",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "赵峰俯视",
            description: "赵峰低头俯视着地上的林萧，脸上露出狂妄且病态的笑容。",
            characters: ["林萧", "赵峰"],
            dialogue: "赵峰：林萧，外门弟子的命比草还贱，死在秘境里，没人会为你收尸",
            cameraDirection: "downward close framing",
            duration: 3,
            segmentLabel: "1-1",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: [
              "全局风格：古风仙侠电影质感，6秒，阴森压抑，冷色调暗光。",
              "视觉锚点：宗门断崖巨兽之口入口，灰衣林萧与华服赵峰，碎石地面。",
              "镜头推进：赵峰：林萧，外门弟子的命比草还贱，死在秘境里，没人会为你收尸；0-3秒：黑雾如巨兽吐息般翻涌，确立压抑死寂的地理空间。；3-6秒：赵峰低头俯视着地上的林萧，脸上露出狂妄且病态的笑容。",
              "结尾钩子：最后一帧定格在赵峰居高临下的病态笑容。",
            ].join("\n"),
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-1", "scene-2"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    await generateSegmentVideoAction({ segmentLabel: "1-1" }, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    const prompt = String(generateArgs?.prompt || "");
    expect(prompt).toContain("\n\n分镜1（0-3秒）：\n黑雾如巨兽吐息般翻涌，确立压抑死寂的地理空间。");
    expect(prompt).toContain("\n\n分镜2（3-6秒）：\n赵峰低头俯视着地上的林萧，脸上露出狂妄且病态的笑容。\n赵峰：林萧，外门弟子的命比草还贱，死在秘境里，没人会为你收尸");
    expect(prompt).not.toContain("\n\n分镜1（0-3秒）：\n黑雾如巨兽吐息般翻涌，确立压抑死寂的地理空间。\n赵峰：林萧，外门弟子的命比草还贱，死在秘境里，没人会为你收尸");
  });

  it("injects the actual segment duration into the opening paragraph when the prompt body omits it", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", status: "submitted", provider: "jimeng" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "杂役房对峙",
            description: "秦傲天在阴暗杂役房内压制林野。",
            characters: ["林野", "秦傲天"],
            dialogue: "",
            cameraDirection: "low angle close-up",
            duration: 5,
            segmentLabel: "1-1",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: [
              "电影质感，古风仙侠基调，暗黑压抑氛围。",
              "场景为昏暗潮湿的杂役房，林野身着朴素暗色长袍，面容清冷锐利；秦傲天身着华贵金锦袍，手持鎏金折扇。",
              "镜头1：低机位跟拍，秦傲天华贵的锦靴猛力碾碎地上的筑基丹，丹药瞬间化为齑粉，尘屑在昏黄灯光下飞扬。",
              "镜头2：特写林野双眼，眼神由冷寂瞬间转为寒芒，瞳孔深处金光爆燃。",
              "结尾钩子：秦傲天讥笑着抬扇挑起林野下巴，逼近对视，眉眼间尽是傲慢与戏谑的压迫感。",
            ].join("\n\n"),
            duration: 15,
            targetDuration: 15,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 15,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    await generateSegmentVideoAction({ segmentLabel: "1-1" }, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    expect(generateArgs?.duration).toBe(12);
    expect(generateArgs?.prompt).toContain("电影质感，12秒，古风仙侠基调，暗黑压抑氛围。");
    expect(generateArgs?.prompt).toContain("\n\n通用后缀： 无字幕、无水印、无屏幕文字");
  });

  it("compresses overly long first-segment submission prompts while preserving core beats for non-RunningHub providers", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", status: "submitted", provider: "jimeng" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "雨夜长街",
            description: "主角在暴雨长街中奔跑后急停抬眼。",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "tracking shot",
            duration: 6,
            segmentLabel: "1-1",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: [
              `全局风格：电影级现实悬疑风格，6秒，冷色压迫感与凌厉运动镜头。`,
              `视觉锚点：${"暴雨长街、积水反光、冷色霓虹、湿透风衣、压低肩线、警惕抬眼、远处车灯与雨幕切片感；".repeat(14)}`,
              `镜头推进：0-3秒：${"主角沿着长街贴地疾冲，鞋底激起连串水花，肩线低压，视线不断切向街尾阴影；".repeat(8)}；3-6秒：${"他急停半转身，胸口起伏剧烈，雨珠从睫毛与下颌连续坠落，镜头从侧后快速推到近景锁住他的眼神变化；".repeat(8)}`,
              `环境细节：${"风压卷起路边塑料布与纸屑，远处轮胎碾水回声、霓虹闪烁电流声、雨打铁皮与急促呼吸交错出现；".repeat(10)}`,
              `结尾钩子：${"最后一帧停在主角抬眼锁定前方危险源的瞬间，保留下一段可以直接接上的逼停感和即将反扑的身体势能；".repeat(6)}`,
            ].join("\n\n"),
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    await generateSegmentVideoAction({ segmentLabel: "1-1" }, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    expect(typeof generateArgs?.prompt).toBe("string");
    expect(generateArgs?.prompt?.length).toBeLessThanOrEqual(1160);
    expect(generateArgs?.prompt?.length).toBeGreaterThan(300);
    expect(generateArgs?.prompt).toContain("\n\n通用后缀： 无字幕、无水印、无屏幕文字");
    expect(generateArgs?.prompt).not.toContain("\n\n起始衔接：\n");
    expect(generateArgs?.prompt).toContain("\n\n分镜1（0-3秒）：\n");
    expect(generateArgs?.prompt).toContain("\n\n分镜2（3-6秒）：\n");
    expect(generateArgs?.prompt).toContain("主角沿着长街贴地疾冲");
    expect(generateArgs?.prompt).toContain("他急停半转身");
  });

  it("strips inline audio prefixes and avoids duplicating matching dialogue lines", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", status: "submitted", provider: "jimeng" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Guardian Warning",
            description: "苏辰在神殿禁地前极速闪避。",
            characters: ["苏辰", "大长老"],
            dialogue: "大长老：苏辰快走，这是大长老化身。",
            cameraDirection: "handheld tracking shot",
            duration: 5,
            segmentLabel: "1-1",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "Su Chen Defiance",
            description: "苏辰顶住神威压迫，咬牙抬眼。",
            characters: ["苏辰"],
            dialogue: "苏辰：本体又如何？我迟早找了它！",
            cameraDirection: "tight close-up",
            duration: 5,
            segmentLabel: "1-1",
          },
          {
            id: "scene-3",
            sceneNumber: 3,
            sceneName: "Narration Reveal",
            description: "苏辰纵身跃入裂渊深处，剑光拖尾。",
            characters: ["苏辰"],
            dialogue: "旁白：屠神之路，刚刚拉开序幕。",
            cameraDirection: "aerial pull-back",
            duration: 5,
            segmentLabel: "1-1",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: [
              "全局风格：电影级CG质感，15秒，极速转场与爆发式动作作画。",
              "视觉锚点：黑衣剑修苏辰、神殿禁地、水晶囚笼与幽暗石殿。",
              "起始衔接：从神殿禁地上一镜头的爆裂停点直接切入。",
              "衔接原则：严格按已拆分镜头顺序推进，保持神殿刑台空间、光向与人物动作接力连续。",
              [
                "镜头推进：",
                "镜头1：镜头手持快速取拍，苏辰身影化作黑色残影瞬移至水晶囚笼前，手中木剑裹挟暗金剑气，如闪电般劈断囚笼锁链，碎冰飞溅，音频：大长老：“苏辰快走，这是大长老化身。”",
                "镜头2：镜头猛然推进至苏辰面部特写，他将林清雪的残魂光影强行压入木剑，剑身震颤，苏辰眼中血色弥漫，杀意狂暴，嘴角勾起决绝狂笑，音频：苏辰：“本体又如何？我迟早找了它！”",
                "镜头3：镜头拉升至远景，苏辰重剑轰然劈开神殿广场，大地崩裂现出万丈深渊，他紧握木剑，身影带着残魂光芒决绝坠入深渊，音频：旁白：“屠神之路，刚刚拉开序幕。”",
              ].join("；"),
              "环境动态：空间剧烈震动，冰晶碎裂声、暗金能量与清冷白光剧烈对撞，尘土与碎石在空中翻涌。",
              "结尾钩子：坠落中苏辰身形在空中扭转，目光如炬直视深渊上方，手中剑意直指天际。",
              "通用后缀：无字幕、无水印、无屏幕文字",
            ].join("\n"),
            duration: 15,
            targetDuration: 15,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 15,
            sceneIds: ["scene-1", "scene-2", "scene-3"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    await generateSegmentVideoAction({ segmentLabel: "1-1" }, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    expect(generateArgs?.prompt).toContain("\n大长老：苏辰快走，这是大长老化身。");
    expect(generateArgs?.prompt).toContain("\n苏辰：本体又如何？我迟早找了它！");
    expect(generateArgs?.prompt).toContain("\n旁白：屠神之路，刚刚拉开序幕。");
    expect(generateArgs?.prompt).not.toContain("音频：");
    expect(generateArgs?.prompt).not.toContain("“");
    expect(generateArgs?.prompt?.match(/苏辰快走，这是大长老化身/g)?.length).toBe(1);
    expect(generateArgs?.prompt?.match(/本体又如何？我迟早找了它/g)?.length).toBe(1);
    expect(generateArgs?.prompt?.match(/屠神之路，刚刚拉开序幕/g)?.length).toBe(1);
  });

  it("normalizes half-width section colons and folds transition guidance into the ending hook", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", status: "submitted", provider: "jimeng" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Arena Awakening",
            description: "苏辰在深坑中抬眼。",
            characters: ["苏辰"],
            dialogue: "",
            cameraDirection: "close-up",
            duration: 10,
            segmentLabel: "1-1",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: [
              "全局风格: 电影级真人武侠奇幻风格，10秒，氛围压抑粗粝。",
              "视觉锚点: 烈日笼罩下的青云宗演武场，苏辰血脸破碎黑袍。",
              "镜头推进: 分镜1（0-5秒）：电影感广角镜头缓缓推进，苏辰虚弱地躺在巨大深坑中。；分镜2（5-10秒）：极致眼部特写，苏辰瞳孔深处蓝光闪烁。",
              "环境动态: 尘土翻卷，碎石轻微震动。",
              "节奏衔接: 最后一个动作停在苏辰抬眼锁定前方的瞬间。",
              "结尾钩子: 保留下一秒即将反击的压迫感。",
            ].join("\n"),
            duration: 10,
            targetDuration: 10,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    await generateSegmentVideoAction({ segmentLabel: "1-1" }, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    expect(generateArgs?.prompt).toContain("\n\n分镜1（0-5秒）：\n电影感广角镜头缓缓推进，苏辰虚弱地躺在巨大深坑中。");
    expect(generateArgs?.prompt).toContain("\n\n分镜2（5-10秒）：\n苏辰瞳孔深处蓝光闪烁。");
    expect(generateArgs?.prompt).toContain("\n\n结尾钩子：\n最后一个动作停在苏辰抬眼锁定前方的瞬间；保留下一秒即将反击的压迫感。");
    expect(generateArgs?.prompt).not.toContain("视觉锚点:");
    expect(generateArgs?.prompt).not.toContain("镜头推进:");
    expect(generateArgs?.prompt).not.toContain("节奏衔接:");
    expect(generateArgs?.prompt).toMatch(/\n\n通用后缀： 无字幕、无水印、无屏幕文字$/);
  });

  it("pulls misplaced later storyboard beats back out of continuity and ending sections", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", status: "submitted", provider: "jimeng" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "宗门断崖入口",
            description: "远景，黑雾翻涌，洞口与外门弟子尸体同时入画。",
            characters: ["林慕", "赵峰"],
            dialogue: "",
            cameraDirection: "wide shot",
            duration: 3,
            segmentLabel: "1-2",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "宗门断崖入口",
            description: "特写，林慕前脸被压入碎石地，额头血口裂开。",
            characters: ["林慕"],
            dialogue: "",
            cameraDirection: "close-up",
            duration: 3,
            segmentLabel: "1-2",
          },
          {
            id: "scene-3",
            sceneNumber: 3,
            sceneName: "宗门断崖入口",
            description: "中景，赵峰高空俯冲，黑雾化掌压向林慕。",
            characters: ["林慕", "赵峰"],
            dialogue: "",
            cameraDirection: "medium shot",
            duration: 4,
            segmentLabel: "1-2",
          },
          {
            id: "scene-4",
            sceneNumber: 4,
            sceneName: "宗门断崖入口",
            description: "分镜4，赵峰冷笑逼近，围观外门弟子嘲弄。",
            characters: ["林慕", "赵峰"],
            dialogue: "赵峰：林慕，外门弟子的命比草还贱。",
            cameraDirection: "push-in",
            duration: 2,
            segmentLabel: "1-2",
          },
          {
            id: "scene-5",
            sceneNumber: 5,
            sceneName: "宗门断崖入口",
            description: "极近特写，林慕眼底寒意翻涌，呼吸骤停后杀意暴起。",
            characters: ["林慕"],
            dialogue: "",
            cameraDirection: "extreme close-up",
            duration: 3,
            segmentLabel: "1-2",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
        segmentVideoPrompts: {
          "1-2": {
            segmentLabel: "1-2",
            prompt: [
              "全局风格：电影化实拍质感，15秒总长，阴森压抑的肃杀氛围。",
              "视觉锚点：林慕身着灰色外门弟子服，赵峰身着华丽黑红锦袍，场景为宗门断崖入口。",
              "起始衔接：承接上一段林慕眼底寒芒初现的冰冷情绪，镜头从断崖高空向下俯冲。",
              [
                "衔接原则：采用“环境压迫 -> 受辱爆发 -> 杀意觉醒”的递进逻辑，保持林慕在地面、赵峰居高临下的空间优势。",
                "分镜1（0-3秒）：远景镜头，黑雾如潮水般从巨兽骸骨状的洞口涌出，风声凌厉，断崖边缘的枯草在死气中剧烈摆动。",
                "分镜2（3-6秒）：特写镜头，林慕的侧脸被一股巨力狠狠按入碎石地，额头伤口裂开，鲜血瞬间染红灰色衣领。",
                "分镜3（6-10秒）：中景俯拍，赵峰浮悬半空，黑雾化作利刃压向林慕。",
              ].join("；"),
              "环境细节：黑雾翻滚，碎石在碾压下碎裂，风卷起林慕散乱的发丝。",
              [
                "结尾钩子：定格在林慕死死锁定地面的冰冷眼神。",
                "赵峰：林慕，外门弟子的命比草还贱。",
                "分镜4（10-12秒）：赵峰冷笑扫过地面，围观的外门弟子扬起讥讽笑声。",
                "分镜5（12-15秒）：极近特写，林慕半边脸压在冰冷碎石上，瞳孔骤然放大，瞳孔深处翻涌起冰冷刺骨的杀意。",
              ].join("；"),
            ].join("\n"),
            duration: 15,
            targetDuration: 15,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 15,
            sceneIds: ["scene-1", "scene-2", "scene-3", "scene-4", "scene-5"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    await generateSegmentVideoAction({ segmentLabel: "1-2" }, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    const prompt = String(generateArgs?.prompt || "");
    expect(prompt).toContain("\n\n分镜1（0-3秒）：\n黑雾如潮水般从巨兽骸骨状的洞口涌出，风声凌厉，断崖边缘的枯草在死气中剧烈摆动。");
    expect(prompt).toContain("\n\n分镜2（3-6秒）：\n林慕的侧脸被一股巨力狠狠按入碎石地，额头伤口裂开，鲜血瞬间染红灰色衣领。");
    expect(prompt).toContain("\n\n分镜3（6-10秒）：\n赵峰浮悬半空，黑雾化作利刃压向林慕。");
    expect(prompt).toContain("\n\n分镜4（10-12秒）：\n赵峰冷笑扫过地面，围观的外门弟子扬起讥讽笑声。\n赵峰：林慕，外门弟子的命比草还贱。");
    expect(prompt).toContain("\n\n分镜5（12-15秒）：\n林慕半边脸压在冰冷碎石上，瞳孔骤然放大，瞳孔深处翻涌起冰冷刺骨的杀意。");
    expect(prompt.indexOf("分镜4（10-12秒）：")).toBeGreaterThan(prompt.indexOf("分镜3（6-10秒）："));
    expect(prompt.indexOf("\n\n环境细节：\n")).toBeGreaterThan(prompt.indexOf("分镜5（12-15秒）："));
    expect(prompt.indexOf("\n\n结尾钩子：\n")).toBeGreaterThan(prompt.indexOf("\n\n环境细节：\n"));
    expect(prompt).toContain("\n\n结尾钩子：\n定格在林慕死死锁定地面的冰冷眼神。");
    expect(prompt).not.toContain("结尾钩子：\n定格在林慕死死锁定地面的冰冷眼神。；赵峰");
  });

  it("softens generic camera cue prefixes inside storyboard narration and strips rule-like environment prose", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", status: "submitted", provider: "jimeng" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "副本第一层",
            description: "林萧猛地抬头，杀意翻涌。",
            characters: ["林萧", "赵峰"],
            dialogue: "林萧：赵师兄，刀剑穿心的滋味，你慢慢品尝",
            cameraDirection: "特写",
            duration: 3,
            segmentLabel: "1-2",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "万剑调转",
            description: "万千剑影齐刷刷指向赵峰。",
            characters: ["林萧", "赵峰"],
            dialogue: "",
            cameraDirection: "远景",
            duration: 3,
            segmentLabel: "1-2",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
        segmentVideoPrompts: {
          "1-2": {
            segmentLabel: "1-2",
            prompt: [
              "电影化短剧质感，15秒，压迫感强烈。",
              "视觉锚点：角色 林萧：年轻黑衣；场景：副本第一层昏暗石壁。",
              "起始衔接：承接上一段人物动作余势。",
              [
                "分镜1（0-3秒）：。",
                "特写：林萧猛地抬头，瞳孔震颤，整座副本剧烈震动。",
                "林萧：赵师兄，刀剑穿心的滋味，你慢慢品尝",
                "分镜2（3-6秒）：。",
                "远景：万千剑影调转方向，齐刷刷指向被按在地上的赵峰。",
              ].join("；"),
              "环境细节：优先把风、雨、烟尘、光影、反光、粒子、碎屑、人物呼吸、脚步、衣料摩擦或低沉能量嗡鸣等能驱动画面动势的元素写出来。",
              "结尾钩子：最后定格在赵峰瞳孔骤缩的瞬间。",
            ].join("\n"),
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-1", "scene-2"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    await generateSegmentVideoAction({ segmentLabel: "1-2" }, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    const prompt = String(generateArgs?.prompt || "");
    expect(prompt).toContain("\n\n分镜1（0-3秒）：\n林萧猛地抬头，瞳孔震颤，整座副本剧烈震动。");
    expect(prompt).toContain("\n\n分镜2（3-6秒）：\n万千剑影调转方向，齐刷刷指向被按在地上的赵峰。");
    expect(prompt).not.toContain("特写：");
    expect(prompt).not.toContain("远景：");
    expect(prompt).not.toContain("\n。\n");
    expect(prompt).not.toContain("环境细节：\n优先把");
    expect(prompt).not.toContain("把风、雨、烟尘");
  });

  it("splits mixed style-and-anchor preludes even on the sectioned submission path", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", status: "submitted", provider: "jimeng" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "副本第一层",
            description: "林萧猛地抬头，杀意翻涌。",
            characters: ["林萧", "赵峰"],
            dialogue: "",
            cameraDirection: "特写",
            duration: 3,
            segmentLabel: "1-2",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
        segmentVideoPrompts: {
          "1-2": {
            segmentLabel: "1-2",
            prompt: [
              "电影化短剧质感，15秒，压迫感强烈。角色 林萧：年轻黑衣，副本第一层昏暗石壁与血色巨眼保持一致。",
              "起始衔接：参考顺序：第1张参考图优先延续上一片段关键动作、站位、轴线和光向，不作为硬首帧复刻。上一停点：赵峰俯冲压下。 本段开场：林萧猛地抬头。",
              "分镜1（0-3秒）：特写：林萧猛地抬头，瞳孔震颤，整座副本剧烈震动。",
              "结尾钩子：最后定格在赵峰瞳孔骤缩的瞬间。",
            ].join("\n"),
            duration: 3,
            targetDuration: 3,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    await generateSegmentVideoAction({ segmentLabel: "1-2" }, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    const prompt = String(generateArgs?.prompt || "");
    expect(prompt).toContain("电影化短剧质感，15秒，压迫感强烈。");
    expect(prompt).toContain("\n\n角色 林萧：年轻黑衣，副本第一层昏暗石壁与血色巨眼保持一致。");
    expect(prompt.indexOf("\n\n角色 林萧：年轻黑衣，副本第一层昏暗石壁与血色巨眼保持一致。")).toBeGreaterThan(
      prompt.indexOf("电影化短剧质感，15秒，压迫感强烈。"),
    );
    expect(prompt.indexOf("\n\n分镜1（0-3秒）：\n")).toBeGreaterThan(
      prompt.indexOf("\n\n角色 林萧：年轻黑衣，副本第一层昏暗石壁与血色巨眼保持一致。"),
    );
  });

  it("rebuilds missing storyboard coverage at submit time while preserving the original global style", async () => {
    saveApiConfig({
      jimengExecutionMode: "api",
      jimengKey: "test-jimeng-key",
      runninghubKey: "test-runninghub-key",
      runninghubEndpoint: "https://www.runninghub.cn",
    });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", status: "submitted", provider: "runninghub-seedance" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        artStyle: "live-action",
        imageGenerationPrefs: {
          familyKey: "nano-banana-pro",
          resolution: "default",
          aspectRatio: "16:9",
          styleCategory: "realistic",
          stylePreset: "live-action",
        },
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "副本第一层",
            description: "林萧猛地抬头，额头鲜血顺着眼角滴下。",
            characters: ["林萧", "赵峰"],
            dialogue: "林萧：赵师兄，刀剑穿心的滋味，你慢慢品尝",
            cameraDirection: "特写",
            duration: 3,
            segmentLabel: "1-2",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "剑阵调转",
            description: "万千剑影调转方向，齐刷刷指向赵峰。",
            characters: ["林萧", "赵峰"],
            dialogue: "",
            cameraDirection: "中景",
            duration: 3,
            segmentLabel: "1-2",
          },
          {
            id: "scene-3",
            sceneNumber: 3,
            sceneName: "血眼睁开",
            description: "林萧眼神冷冽，背景黑暗中睁开一只血色巨眼。",
            characters: ["林萧"],
            dialogue: "",
            cameraDirection: "正面近景",
            duration: 3,
            segmentLabel: "1-2",
          },
          {
            id: "scene-4",
            sceneNumber: 4,
            sceneName: "赵峰后退",
            description: "剑阵向前推进半步，赵峰踉跄后退。",
            characters: ["赵峰"],
            dialogue: "赵峰：怎么可能！你这废物，竟能控制阵法？",
            cameraDirection: "横移",
            duration: 3,
            segmentLabel: "1-2",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-2-0-260128",
          resolution: "1080p",
          mode: "text-to-video",
        },
        segmentVideoPrompts: {
          "1-2": {
            segmentLabel: "1-2",
            prompt: [
              "全局风格：电影化短剧质感，15秒，氛围压抑凌厉，冷色主光与强烈呼吸感并存。",
              "视觉锚点：角色 林萧：年轻，眼神坚毅且深藏杀意，身穿洗得发白的灰色外门弟子服；赵峰：傲慢，神情病态兴奋，身穿华丽锦衣；场景 副本第一层：昏暗石壁、血色巨眼与潮湿反光地面保持一致。",
              "起始衔接：参考顺序：第1张参考图优先延续上一片段末帧的动作关系、站位、轴线和光向，不作为硬首帧复刻。上一停点：最后一帧停在副本第一层里人物动作未收完、视线已经锁定的瞬间，下一段从这里继续。",
              "衔接原则：全段按同一条长片时间线拍，遵循承接 -> 推进 -> 留停点。拆解骨架与剧本补全参考优先，不吞关键动作、反应和结果。",
              "镜头推进：。",
              "结尾钩子：最后一帧停在副本第一层里人物动作未收完、视线已经锁定的瞬间，下一段从这里继续。",
            ].join("\n"),
            duration: 12,
            targetDuration: 12,
            modelKey: "doubao-seedance-2-0-260128",
            maxDurationForModel: 12,
            sceneIds: ["scene-1", "scene-2", "scene-3", "scene-4"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    await generateSegmentVideoAction({ segmentLabel: "1-2" }, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    const prompt = String(generateArgs?.prompt || "");
    expect(generateArgs?.provider).toBe("runninghub-seedance");
    expect(prompt).toContain("电影化短剧质感，15秒，氛围压抑凌厉，冷色主光与强烈呼吸感并存。");
    expect(prompt).toContain("\n\n分镜1（0-3秒）：\n林萧猛地抬头，额头鲜血顺着眼角滴下。");
    expect(prompt).toContain("\n\n分镜2（3-6秒）：\n万千剑影调转方向，齐刷刷指向赵峰。");
    expect(prompt).toContain("\n\n分镜3（6-9秒）：\n林萧眼神冷冽，背景黑暗中睁开一只血色巨眼。");
    expect(prompt).toContain("\n\n分镜4（9-12秒）：\n剑阵向前推进半步，赵峰踉跄后退。\n赵峰：怎么可能！你这废物，竟能控制阵法？");
    expect(prompt).not.toContain("镜头推进：。");
    expect(prompt).not.toContain("…");
  });

  it("formats the submitted segment prompt exactly in the expected layout", async () => {
    saveApiConfig({
      jimengExecutionMode: "api",
      jimengKey: "test-jimeng-key",
      runninghubKey: "test-runninghub-key",
      runninghubEndpoint: "https://www.runninghub.cn",
    });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", status: "submitted", provider: "runninghub-seedance" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        artStyle: "live-action",
        imageGenerationPrefs: {
          familyKey: "nano-banana-pro",
          resolution: "default",
          aspectRatio: "16:9",
          styleCategory: "realistic",
          stylePreset: "live-action",
        },
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "副本第一层",
            description: "林萧猛地抬头，额头鲜血顺着眼角滴下。",
            characters: ["林萧", "赵峰"],
            dialogue: "林萧：赵师兄，刀剑穿心的滋味，你慢慢品尝",
            cameraDirection: "特写",
            duration: 3,
            segmentLabel: "1-2",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "剑阵调转",
            description: "万千剑影调转方向，齐刷刷指向赵峰。",
            characters: ["林萧", "赵峰"],
            dialogue: "",
            cameraDirection: "中景",
            duration: 3,
            segmentLabel: "1-2",
          },
          {
            id: "scene-3",
            sceneNumber: 3,
            sceneName: "血眼睁开",
            description: "林萧眼神冷冽，背景黑暗中睁开一只血色巨眼。",
            characters: ["林萧"],
            dialogue: "",
            cameraDirection: "正面近景",
            duration: 3,
            segmentLabel: "1-2",
          },
          {
            id: "scene-4",
            sceneNumber: 4,
            sceneName: "赵峰后退",
            description: "剑阵向前推进半步，赵峰踉跄后退。",
            characters: ["赵峰"],
            dialogue: "赵峰：怎么可能！你这废物，竟能控制阵法？",
            cameraDirection: "横移",
            duration: 3,
            segmentLabel: "1-2",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-2-0-260128",
          resolution: "1080p",
          mode: "text-to-video",
        },
        segmentVideoPrompts: {
          "1-2": {
            segmentLabel: "1-2",
            prompt: [
              "全局风格：电影化短剧质感，15秒，氛围压抑凌厉，冷色主光与强烈呼吸感并存。",
              "视觉锚点：角色 林萧：年轻，眼神坚毅且深藏杀意，身穿洗得发白的灰色外门弟子服；赵峰：傲慢，神情病态兴奋，身穿华丽锦衣；场景 副本第一层：昏暗石壁、血色巨眼与潮湿反光地面保持一致。",
              "起始衔接：参考顺序：第1张参考图优先延续上一片段末帧的动作关系、站位、轴线和光向，不作为硬首帧复刻。上一停点：最后一帧停在副本第一层里人物动作未收完、视线已经锁定的瞬间，下一段从这里继续。",
              "衔接原则：全段按同一条长片时间线拍，遵循承接 -> 推进 -> 留停点。拆解骨架与剧本补全参考优先，不吞关键动作、反应和结果。",
              "镜头推进：。",
              "结尾钩子：最后一帧停在副本第一层里人物动作未收完、视线已经锁定的瞬间，下一段从这里继续。",
            ].join("\n"),
            duration: 12,
            targetDuration: 12,
            modelKey: "doubao-seedance-2-0-260128",
            maxDurationForModel: 12,
            sceneIds: ["scene-1", "scene-2", "scene-3", "scene-4"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    await generateSegmentVideoAction({ segmentLabel: "1-2" }, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    expect(String(generateArgs?.prompt || "")).toBe(
      [
        "电影化短剧质感，15秒，氛围压抑凌厉，冷色主光与强烈呼吸感并存。",
        "",
        "角色 林萧：年轻，眼神坚毅且深藏杀意，身穿洗得发白的灰色外门弟子服。",
        "赵峰：傲慢，神情病态兴奋，身穿华丽锦衣。",
        "场景 副本第一层：昏暗石壁、血色巨眼与潮湿反光地面保持一致。",
        "",
        "起始衔接：",
        "参考顺序：第1张参考图优先延续上一片段末帧的动作关系、站位、轴线和光向，不作为硬首帧复刻。",
        "上一停点：最后一帧停在副本第一层里人物动作未收完、视线已经锁定的瞬间，下一段从这里继续。",
        "",
        "衔接原则：",
        "全段按同一条长片时间线拍，遵循承接 -> 推进 -> 留停点。",
        "先按已拆解分镜顺序推进，各分镜按上一结果 -> 当前动作 -> 下一停点接力；缺口只补剧本里明确存在的承接动作、反应或状态变化。",
        "本段结尾：剑阵向前推进半步，赵峰踉跄后退。",
        "",
        "分镜1（0-3秒）：",
        "林萧猛地抬头，额头鲜血顺着眼角滴下。",
        "林萧：赵师兄，刀剑穿心的滋味，你慢慢品尝",
        "",
        "分镜2（3-6秒）：",
        "万千剑影调转方向，齐刷刷指向赵峰。",
        "",
        "分镜3（6-9秒）：",
        "林萧眼神冷冽，背景黑暗中睁开一只血色巨眼。",
        "",
        "分镜4（9-12秒）：",
        "剑阵向前推进半步，赵峰踉跄后退。",
        "赵峰：怎么可能！你这废物，竟能控制阵法？",
        "",
        "结尾钩子：",
        "最后一帧停在副本第一层里人物动作未收完、视线已经锁定的瞬间，下一段从这里继续。",
        "",
        "通用后缀： 无字幕、无水印、无屏幕文字",
      ].join("\n"),
    );
  });

  it("rebuilds storyboard blocks for legacy segment prompts whose sceneIds are missing", async () => {
    saveApiConfig({
      jimengExecutionMode: "api",
      jimengKey: "test-jimeng-key",
      runninghubKey: "test-runninghub-key",
      runninghubEndpoint: "https://www.runninghub.cn",
    });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", status: "submitted", provider: "runninghub-seedance" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        artStyle: "live-action",
        imageGenerationPrefs: {
          familyKey: "nano-banana-pro",
          resolution: "default",
          aspectRatio: "16:9",
          styleCategory: "realistic",
          stylePreset: "live-action",
        },
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "副本第一层",
            description: "林萧猛地抬头，额头鲜血顺着眼角滴下。",
            characters: ["林萧", "赵峰"],
            dialogue: "林萧：赵师兄，刀剑穿心的滋味，你慢慢品尝",
            cameraDirection: "特写",
            duration: 3,
            segmentLabel: "1-2",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "剑阵调转",
            description: "万千剑影调转方向，齐刷刷指向赵峰。",
            characters: ["林萧", "赵峰"],
            dialogue: "",
            cameraDirection: "中景",
            duration: 3,
            segmentLabel: "1-2",
          },
          {
            id: "scene-3",
            sceneNumber: 3,
            sceneName: "血眼睁开",
            description: "林萧眼神冷冽，背景黑暗中睁开一只血色巨眼。",
            characters: ["林萧"],
            dialogue: "",
            cameraDirection: "正面近景",
            duration: 3,
            segmentLabel: "1-2",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-2-0-260128",
          resolution: "1080p",
          mode: "text-to-video",
        },
        segmentVideoPrompts: {
          "1-2": {
            segmentLabel: "1-2",
            prompt: [
              "全局风格：电影化短剧质感，15秒，幽暗石室冷色调，高张力动作与诡异氛围。",
              "视觉锚点：林萧（灰袍）、赵峰（锦衣）、暗黑石壁剑槽阶梯、红光阵眼核心、金色令牌。",
              "起始衔接：上一停点：最后一帧锁定在赵峰极度惊恐的仰视面容，与林萧冷冽杀意的俯视视线形成死局对峙，保留崩弦般的张力势能。",
              "衔接原则：全段按同一条长片时间线拍，遵循承接 -> 推进 -> 留停点。",
              "环境细节：玄铁剑震颤的金属鸣响、石室落石粉尘、红光阵纹脉动、血色雾气翻涌、衣料摩擦声。",
              "结尾钩子：最后一帧锁定在林萧冷冽视线与背景血色巨眼的同框，将肃杀的复仇定格，为下一集长老剧情留下悬念势能。",
            ].join("\n"),
            duration: 9,
            targetDuration: 9,
            modelKey: "doubao-seedance-2-0-260128",
            maxDurationForModel: 12,
            sceneIds: [],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    await generateSegmentVideoAction({ segmentLabel: "1-2" }, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    const prompt = String(generateArgs?.prompt || "");
    expect(prompt).toContain("\n\n分镜1（0-3秒）：\n林萧猛地抬头，额头鲜血顺着眼角滴下。");
    expect(prompt).toContain("\n\n分镜2（3-6秒）：\n万千剑影调转方向，齐刷刷指向赵峰。");
    expect(prompt).toContain("\n\n分镜3（6-9秒）：\n林萧眼神冷冽，背景黑暗中睁开一只血色巨眼。");
    expect(prompt).toContain("通用后缀： 无字幕、无水印、无屏幕文字");
  });

  it("rebuilds a first-segment storyboard block while preserving legacy start continuity", async () => {
    saveApiConfig({
      jimengExecutionMode: "api",
      jimengKey: "test-jimeng-key",
      runninghubKey: "test-runninghub-key",
      runninghubEndpoint: "https://www.runninghub.cn",
    });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", status: "submitted", provider: "runninghub-seedance" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        artStyle: "live-action",
        imageGenerationPrefs: {
          familyKey: "nano-banana-pro",
          resolution: "default",
          aspectRatio: "16:9",
          styleCategory: "realistic",
          stylePreset: "live-action",
        },
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "宗门断崖入口",
            description: "灰衣林萧与华服赵峰在断崖副本入口对峙，碎石遍地。",
            characters: ["林萧", "赵峰"],
            dialogue: "",
            cameraDirection: "手持晃动",
            duration: 15,
            segmentLabel: "1-1",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-2-0-260128",
          resolution: "1080p",
          mode: "text-to-video",
        },
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: [
              "全局风格：古风仙侠电影质感，15秒，阴森压抑，冷色调暗光，手持微晃镜头。",
              "视觉锚点：宗门断崖巨兽之口入口，灰衣林萧与华服赵峰，碎石地面。",
              "起始衔接：本段为开场首段，镜头从荒凉阴森的断崖副本入口起拍，奠定压抑死寂的氛围。",
              "衔接原则：全段按同一条长片时间线拍，遵循承接 -> 推进 -> 留停点。",
              "环境细节：缭绕的黑雾，冷风吹动衣角，碎石在脚下碾磨的微尘，沉重的喘息声。",
              "结尾钩子：最后一帧定格在林萧充满杀意的瞳孔特写，保留极度压抑即将爆发的仇恨势能，视线死死锁定地面。",
            ].join("\n"),
            duration: 15,
            targetDuration: 15,
            modelKey: "doubao-seedance-2-0-260128",
            maxDurationForModel: 15,
            sceneIds: [],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    await generateSegmentVideoAction({ segmentLabel: "1-1" }, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    const prompt = String(generateArgs?.prompt || "");
    expect(prompt).toContain("\n\n起始衔接：\n本段为开场首段，镜头从荒凉阴森的断崖副本入口起拍，奠定压抑死寂的氛围。");
    expect(prompt).toContain("\n\n衔接原则：\n");
    expect(prompt).toContain("\n\n分镜1（0-15秒）：\n灰衣林萧与华服赵峰在断崖副本入口对峙，碎石遍地。");
    expect(prompt).toContain("\n\n环境细节：\n缭绕的黑雾，冷风吹动衣角，碎石在脚下碾磨的微尘，沉重的喘息声。");
    expect(prompt).toContain("\n\n通用后缀： 无字幕、无水印、无屏幕文字");
  });

  it("returns the moderation failure directly for Seedance 2.0 segment text-to-video with references", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: null,
          error: new Error(
            "Ark video task creation failed (400): InputImageSensitiveContentDetected.PrivacyInformation | The request failed because the input image contains privacy information.",
          ),
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Warehouse",
            description: "Hero enters the warehouse.",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "wide tracking shot",
            duration: 6,
            segmentLabel: "1-1",
          },
        ],
        sceneSettings: [
          {
            id: "setting-warehouse",
            name: "Warehouse",
            description: "Cold industrial warehouse.",
            imageUrl: "https://example.com/warehouse-ref.jpg",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        characters: [
          {
            id: "char-hero",
            name: "Hero",
            description: "Main character.",
            imageUrl: "https://example.com/hero-ref.jpg",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-2-0-260128",
          resolution: "720p",
          mode: "text-to-video",
        },
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "Segment prompt that already describes the warehouse reference.",
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-2-0-260128",
            maxDurationForModel: 15,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    const result = await generateSegmentVideoAction({ segmentLabel: "1-1" }, runtime);
    const savedProject = result.data?.videoProject;

    const generateCalls = invokeFunction.mock.calls.filter(([name]) => name === "generate-video");
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]?.[1]).toEqual(
      expect.objectContaining({
        provider: "jimeng",
        model: "doubao-seedance-2-0-260128",
        resolution: "720p",
        duration: 6,
        videoMode: "text-to-video",
      }),
    );
    expect(generateCalls[0]?.[1]).not.toHaveProperty("imageUrl");
    expect(generateCalls[0]?.[1]?.referenceImageUrls).toBeUndefined();
    expect(result.summary).toContain("1-1");
    expect(result.summary).toContain("InputImageSensitiveContentDetected.PrivacyInformation");
    expect(savedProject?.segmentVideoStatuses?.["1-1"]).toEqual(
      expect.objectContaining({
        status: "failed",
        failure: expect.objectContaining({
          stage: "submit",
        }),
      }),
    );
    expect(savedProject?.segmentVideoStatuses?.["1-1"]?.failure?.message).toContain(
      "InputImageSensitiveContentDetected.PrivacyInformation",
    );
    expect(savedProject?.videoGenerationModeNotice).toBeNull();
  });

  it("submits a scene reference image for image-to-video segment generation", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", status: "submitted", provider: "jimeng" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Warehouse",
            description: "Hero enters the warehouse.",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "wide tracking shot",
            duration: 6,
            segmentLabel: "1-1",
          },
        ],
        sceneSettings: [
          {
            id: "setting-warehouse",
            name: "Warehouse",
            description: "Cold industrial warehouse.",
            imageUrl: "https://example.com/warehouse-ref.jpg",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "image-to-video",
        },
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "Segment prompt that should use the warehouse image as the visual anchor.",
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    await generateSegmentVideoAction({ segmentLabel: "1-1" }, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    expect(generateArgs).toEqual(
      expect.objectContaining({
        provider: "jimeng",
        model: "doubao-seedance-1-5-pro_720p",
        resolution: "720p",
        duration: 6,
        imageUrl: "https://example.com/warehouse-ref.jpg",
      }),
    );
  });

  it("keeps non-first Jimeng segment continuation in strict text-to-video mode when only prompt continuity is available", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", status: "submitted", provider: "jimeng" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Courtyard Fall",
            description: "Hero drops to one knee and locks eyes with the enemy.",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "wide push-in",
            duration: 6,
            segmentLabel: "1-1",
            storyboardUrl: "https://media.storyforge.test/segment-1-1-tail.jpg",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "Courtyard Counter",
            description: "Hero surges forward from the kneeling stance.",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "tracking shot",
            duration: 6,
            segmentLabel: "1-2",
            storyboardUrl: "https://media.storyforge.test/segment-1-2-head.jpg",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "Segment 1-1 prompt.",
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
          "1-2": {
            segmentLabel: "1-2",
            prompt: "Segment 1-2 prompt.",
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-2"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    await generateSegmentVideoAction({ segmentLabel: "1-2" }, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    expect(generateArgs).toEqual(
      expect.objectContaining({
        provider: "jimeng",
        model: "doubao-seedance-1-5-pro_720p",
        resolution: "720p",
        duration: 6,
        videoMode: "text-to-video",
      }),
    );
    expect(generateArgs).not.toHaveProperty("imageUrl");
    expect(generateArgs).not.toHaveProperty("referenceImageUrls");
    expect(generateArgs?.prompt?.length).toBeLessThanOrEqual(980);
    expect(generateArgs?.prompt).not.toContain("参考顺序：");
    expect(generateArgs?.prompt).toContain("上一停点：");
    const startContinuityMatch = String(generateArgs?.prompt || "").match(/起始衔接：\n([\s\S]*?)\n\n/);
    expect(startContinuityMatch?.[1]).toContain("上一停点：");
  });

  it("uses the previous segment six-grid recap plus role and scene assets when a previous segment exists", async () => {
    saveApiConfig({
      runninghubKey: "test-runninghub-key",
      runninghubEndpoint: "https://www.runninghub.cn",
    });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", status: "submitted", provider: "runninghub-seedance" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Courtyard Fall",
            description: "Hero drops to one knee and locks eyes with the enemy.",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "wide push-in",
            duration: 6,
            segmentLabel: "1-1",
            storyboardUrl: "https://media.storyforge.test/segment-1-1-tail.jpg",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "Courtyard Counter",
            description: "Hero surges forward from the kneeling stance.",
            characters: ["Hero", "Villain"],
            dialogue: "",
            cameraDirection: "tracking shot",
            duration: 6,
            segmentLabel: "1-2",
            sceneTimeVariantId: "setting-courtyard-night",
            storyboardUrl: "https://media.storyforge.test/segment-1-2-head.jpg",
          },
          {
            id: "scene-3",
            sceneNumber: 3,
            sceneName: "Courtyard Clash",
            description: "Hero finishes the lunge and locks blades for the next beat.",
            characters: ["Hero", "Villain"],
            dialogue: "",
            cameraDirection: "tight clash close-up",
            duration: 6,
            segmentLabel: "1-2",
            sceneTimeVariantId: "setting-courtyard-night",
            storyboardUrl: "https://media.storyforge.test/segment-1-2-tail.jpg",
          },
        ],
        characters: [
          {
            id: "hero-1",
            name: "Hero",
            description: "Lead actor reference.",
            imageUrl: "https://example.com/hero-ref.jpg",
            isAIGenerated: false,
            source: "auto",
            costumes: [
              {
                id: "hero-costume-1",
                label: "Battle",
                description: "Battle outfit reference.",
                imageUrl: "https://example.com/hero-battle-ref.jpg",
                isAIGenerated: false,
              },
            ],
            activeCostumeId: "hero-costume-1",
          },
          {
            id: "villain-1",
            name: "Villain",
            description: "Antagonist reference.",
            imageUrl: "https://example.com/villain-ref.jpg",
            isAIGenerated: false,
            source: "auto",
          },
          {
            id: "mentor-1",
            name: "Mentor",
            description: "Unrelated mentor reference.",
            imageUrl: "https://example.com/mentor-ref.jpg",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        sceneSettings: [
          {
            id: "setting-courtyard",
            name: "Courtyard",
            description: "Stormy martial courtyard.",
            imageUrl: "https://example.com/courtyard-ref.jpg",
            isAIGenerated: false,
            source: "auto",
            activeTimeVariantId: "setting-courtyard-night",
            timeVariants: [
              {
                id: "setting-courtyard-night",
                label: "Night",
                description: "Night courtyard reference.",
                imageUrl: "https://example.com/courtyard-night-ref.jpg",
                isAIGenerated: false,
              },
            ],
          },
          {
            id: "setting-rooftop",
            name: "Rooftop",
            description: "Unrelated rooftop reference.",
            imageUrl: "https://example.com/rooftop-ref.jpg",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-2-0-260128",
          resolution: "2k",
          mode: "text-to-video",
        },
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: [
              "全局风格：电影级写实武侠短剧质感，6秒，暴雨压场，冷硬高反差光影持续逼近。",
              "分镜1（0-6秒）：Hero 在 Courtyard Fall 的跪地蓄力停点里猛然抬眼，肩背发力，视线锁死前方敌人，为下一段前冲反击蓄足势能。",
              "环境细节：雨幕贴地横扫，碎石与水花在青石地面持续溅开，空气里混着压抑喘息与兵刃震鸣。",
              "结尾钩子：画面停在 Hero 准备前冲的瞬间，把全部力量压到下一段开场动作里。",
              "通用后缀：无字幕、无水印、无屏幕文字",
            ].join("\n"),
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-2-0-260128",
            maxDurationForModel: 15,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
          "1-2": {
            segmentLabel: "1-2",
            prompt: [
              "全局风格：电影级写实武侠短剧质感，6秒，暴雨压场，动作接力紧绷且连贯。",
              "分镜1（0-3秒）：Hero 直接承接上一段跪地蓄力后的前冲势能，从 Courtyard Counter 的起拍状态猛然贴地突进，镜头保持上一段尾帧的低机位压迫感，人物朝向与冲刺惯性完全延续。",
              "分镜2（3-6秒）：镜头顺势跟到 Courtyard Clash，Hero 抵近对手后强行锁住刀锋交点，身体重心前压，动作停在即将爆开的正面对撞瞬间。",
              "环境细节：暴风卷着雨雾掠过石栏，脚步踏碎水花，兵刃摩擦声与衣袍破风声持续叠加。",
              "结尾钩子：画面定格在 Hero 前冲逼近对手、刀锋即将正面相撞的瞬间，保留下一段交锋爆发的全部势能。",
              "通用后缀：无字幕、无水印、无屏幕文字",
            ].join("\n"),
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-2-0-260128",
            maxDurationForModel: 15,
            sceneIds: ["scene-2", "scene-3"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
        segmentContinuityGridImages: {
          "1-1": {
            imageUrl: "https://media.storyforge.test/segment-1-1-grid.jpg",
            recapText: "前情提要：上一段从跪地蓄力推进到抬眼反击。",
            frameUrls: [
              "https://media.storyforge.test/segment-1-1-kf-1.jpg",
              "https://media.storyforge.test/segment-1-1-kf-2.jpg",
              "https://media.storyforge.test/segment-1-1-kf-3.jpg",
              "https://media.storyforge.test/segment-1-1-kf-4.jpg",
              "https://media.storyforge.test/segment-1-1-kf-5.jpg",
              "https://media.storyforge.test/segment-1-1-kf-6.jpg",
            ],
          },
        },
      }),
    );

    await generateSegmentVideoAction({ segmentLabel: "1-2" }, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    expect(generateArgs).toEqual(
        expect.objectContaining({
          provider: "runninghub-seedance",
          model: "doubao-seedance-2-0-260128",
          resolution: "2k",
          duration: 6,
          videoMode: "text-to-video",
          conversionSlots: ["image1", "image2", "image3", "image4"],
          returnLastFrame: true,
        }),
      );
    expect(generateArgs).not.toHaveProperty("imageUrl");
    expect(generateArgs?.referenceImageUrls).toEqual([
      "https://media.storyforge.test/segment-1-1-grid.jpg",
      "https://example.com/courtyard-night-ref.jpg",
      "https://example.com/hero-battle-ref.jpg",
      "https://example.com/villain-ref.jpg",
    ]);
    expect(generateArgs?.videoUrls).toBeUndefined();
    expect(generateArgs?.prompt?.length).toBeLessThanOrEqual(980);
    [
      "图片 1：上传的六宫格图片为上一段视频的连续时间参考。",
      "第1格为上一段镜头开始状态，第6格为上一段视频最终结束画面。",
      "本段视频必须从六宫格最后一格尾帧画面状态直接开始",
      "并把上一段“从跪地蓄力推进到抬眼反击”所形成的剧情余势、人物压迫关系与情绪方向直接接到本段首镜",
      "图片 2：场景资产图（Courtyard·Night）",
      "图片 3：角色资产图（Hero·Battle）",
      "图片 4：角色资产图（Villain）",
    ].forEach(
      (fragment) => expect(generateArgs?.prompt).toContain(fragment),
    );
    expect(generateArgs?.prompt).toContain("分镜1（0-3秒）：镜头直接承接上一段最后尾帧画面");
    expect(generateArgs?.prompt).toContain("Hero 直接承接上一段跪地蓄力后的前冲势能");
    expect(generateArgs?.prompt).toContain("分镜2（3-6秒）：镜头推进，顺势跟到 Courtyard Clash");
    ["逐图参考：", "图1：", "图2：", "图3：", "图4：", "图5：", "图6：", "上一片段真实末帧", "动作延续关键帧", "本段开场分镜图", "精确开场画面"].forEach((fragment) =>
      expect(generateArgs?.prompt).not.toContain(fragment),
    );
    ["https://example.com/mentor-ref.jpg", "https://example.com/rooftop-ref.jpg"].forEach((url) =>
      expect(generateArgs?.referenceImageUrls).not.toContain(url),
    );
    ["Mentor", "Rooftop"].forEach((fragment) =>
      expect(generateArgs?.prompt).not.toContain(fragment),
    );
  });

  it("keeps RunningHub continuation in text mode while uploading only the previous segment six-grid recap and role-scene asset anchors", async () => {
    saveApiConfig({
      runninghubKey: "test-runninghub-key",
      runninghubEndpoint: "https://www.runninghub.cn",
    });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", status: "submitted", provider: "runninghub-seedance" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Courtyard Fall",
            description: "Hero drops to one knee and locks eyes with the enemy.",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "wide push-in",
            duration: 6,
            segmentLabel: "1-1",
            storyboardUrl: "https://media.storyforge.test/segment-1-1-tail.jpg",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "Courtyard Counter",
            description: "Hero surges forward from the kneeling stance.",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "tracking shot",
            duration: 6,
            segmentLabel: "1-2",
            storyboardUrl: "https://media.storyforge.test/segment-1-2-head.jpg",
          },
          {
            id: "scene-3",
            sceneNumber: 3,
            sceneName: "Courtyard Clash",
            description: "Hero lands the forward burst and freezes on the blade lock.",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "tight clash close-up",
            duration: 6,
            segmentLabel: "1-2",
            storyboardUrl: "https://media.storyforge.test/segment-1-2-tail.jpg",
          },
        ],
        characters: [
          {
            id: "hero-1",
            name: "Hero",
            description: "Lead actor reference.",
            imageUrl: "https://example.com/hero-ref.jpg",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        sceneSettings: [
          {
            id: "setting-courtyard",
            name: "Courtyard",
            description: "Stormy martial courtyard.",
            imageUrl: "https://example.com/courtyard-ref.jpg",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-2-0-260128",
          resolution: "2k",
          mode: "text-to-video",
        },
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: [
              "全局风格：电影级写实武侠短剧质感，6秒，暴雨压场，冷硬高反差光影持续逼近。",
              "分镜1（0-6秒）：Hero 在 Courtyard Fall 的跪地蓄力停点里猛然抬眼，肩背发力，视线锁死前方敌人，为下一段前冲反击蓄足势能。",
              "环境细节：雨幕贴地横扫，碎石与水花在青石地面持续溅开，空气里混着压抑喘息与兵刃震鸣。",
              "结尾钩子：画面停在 Hero 准备前冲的瞬间，把全部力量压到下一段开场动作里。",
              "通用后缀：无字幕、无水印、无屏幕文字",
            ].join("\n"),
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-2-0-260128",
            maxDurationForModel: 15,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
          "1-2": {
            segmentLabel: "1-2",
            prompt: [
              "全局风格：电影级写实武侠短剧质感，6秒，暴雨压场，动作接力紧绷且连贯。",
              "分镜1（0-3秒）：Hero 直接承接上一段跪地蓄力后的前冲势能，从 Courtyard Counter 的起拍状态猛然贴地突进，镜头保持上一段尾帧的低机位压迫感，人物朝向与冲刺惯性完全延续。",
              "分镜2（3-6秒）：镜头顺势跟到 Courtyard Clash，Hero 抵近对手后强行锁住刀锋交点，身体重心前压，动作停在即将爆开的正面对撞瞬间。",
              "环境细节：暴风卷着雨雾掠过石栏，脚步踏碎水花，兵刃摩擦声与衣袍破风声持续叠加。",
              "结尾钩子：画面定格在 Hero 前冲逼近对手、刀锋即将正面相撞的瞬间，保留下一段交锋爆发的全部势能。",
              "通用后缀：无字幕、无水印、无屏幕文字",
            ].join("\n"),
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-2-0-260128",
            maxDurationForModel: 15,
            sceneIds: ["scene-2", "scene-3"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
        segmentContinuityGridImages: {
          "1-1": {
            imageUrl: "https://media.storyforge.test/segment-1-1-grid.jpg",
            recapText: "前情提要：上一段从跪地蓄力推进到抬眼反击。",
            frameUrls: [
              "https://media.storyforge.test/segment-1-1-kf-a.jpg",
              "https://media.storyforge.test/segment-1-1-kf-b.jpg",
              "https://media.storyforge.test/segment-1-1-kf-c.jpg",
              "https://media.storyforge.test/segment-1-1-kf-d.jpg",
              "https://media.storyforge.test/segment-1-1-kf-e.jpg",
              "https://media.storyforge.test/segment-1-1-kf-f.jpg",
            ],
          },
        },
      }),
    );

    await generateSegmentVideoAction({ segmentLabel: "1-2" }, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    expect(generateArgs).toEqual(expect.objectContaining({
      provider: "runninghub-seedance",
      videoMode: "text-to-video",
      conversionSlots: ["image1", "image2", "image3"],
    }));
    expect(generateArgs).not.toHaveProperty("imageUrl");
    expect(generateArgs?.referenceImageUrls).toEqual([
      "https://media.storyforge.test/segment-1-1-grid.jpg",
      "https://example.com/courtyard-ref.jpg",
      "https://example.com/hero-ref.jpg",
    ]);
    expect(generateArgs?.videoUrls).toBeUndefined();
    [
      "图片 1：上传的六宫格图片为上一段视频的连续时间参考。",
      "第1格为上一段镜头开始状态，第6格为上一段视频最终结束画面。",
      "本段视频必须从六宫格最后一格尾帧画面状态直接开始",
      "并把上一段“从跪地蓄力推进到抬眼反击”所形成的剧情余势、人物压迫关系与情绪方向直接接到本段首镜",
      "图片 2：场景资产图（Courtyard）",
      "图片 3：角色资产图（Hero）",
    ].forEach(
      (fragment) => expect(generateArgs?.prompt).toContain(fragment),
    );
    ["逐图参考：", "图1：", "图2：", "图3：", "图4：", "动作延续关键帧", "本段开场分镜图", "精确开场画面"].forEach((fragment) =>
      expect(generateArgs?.prompt).not.toContain(fragment),
    );
  });

  it("stores a fixed six-frame continuity set and emits the generated recap six-grid after a segment video completes", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });
    const gridRenderer = installContinuityGridRenderMocks();
    cacheProjectVideoSource.mockResolvedValue({
      localPath: "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-1.mp4",
      previewUrl: "file:///E:/projects/video-project-1/media/videos/generated/segment-1-1.mp4",
      size: 1024,
      mimeType: "video/mp4",
    });
    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: {
            status: "completed",
            video_url: "https://media.storyforge.test/generated-segment-1-1.mp4",
            last_frame_url: "https://media.storyforge.test/generated-segment-1-1-last.jpg",
          },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });
    window.electronAPI = {
      media: {
        extractVideoFrames: vi.fn(async () => ({
          ok: true,
          framePaths: [
            "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-1-kf-1.jpg",
            "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-1-kf-2.jpg",
            "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-1-kf-3.jpg",
            "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-1-kf-4.jpg",
            "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-1-kf-5.jpg",
            "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-1-kf-6.jpg",
          ],
        })),
      },
      storage: {
        getDefaultPath: vi.fn(async () => ({ files: "E:\\projects", db: "E:\\db" })),
        readBase64: vi.fn(async () => ({
          ok: true,
          exists: true,
          base64: "FRAME_BASE64",
          mimeType: "image/jpeg",
        })),
        writeBase64File: vi.fn(async ({ filePath }: { filePath: string }) => ({
          ok: true,
          filePath,
        })),
      },
    } as unknown as typeof window.electronAPI;

    try {
      const runtime = createRuntime(
        createVideoProject({
          segmentVideoPrompts: {
            "1-1": {
              segmentLabel: "1-1",
              prompt: "Segment prompt",
              duration: 6,
              targetDuration: 6,
              modelKey: "doubao-seedance-1-5-pro",
              maxDurationForModel: 12,
              sceneIds: ["scene-1"],
              generatedAt: "2026-04-03T00:00:00.000Z",
            },
          },
          segmentVideoStatuses: {
            "1-1": {
              segmentLabel: "1-1",
              status: "processing",
              taskId: "task-segment-1-1",
              provider: "jimeng",
              updatedAt: "2026-04-03T00:00:00.000Z",
            },
          },
        }),
      );

      const result = await refreshSegmentVideoAction({ segmentLabel: "1-1" }, runtime);
      const savedProject = result.data?.videoProject;

      expect(
        savedProject?.assetManifest?.items.find((item) => item.id === "segment:1-1:video"),
      ).toEqual(
        expect.objectContaining({
          kind: "video-segment",
          url: "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-1.mp4",
          source: "segment-video",
          sourceEntityId: "1-1",
        }),
      );
      expect(savedProject?.segmentContinuityFrames?.["1-1"]).toBe(
        "https://media.storyforge.test/generated-segment-1-1-last.jpg",
      );
      expect(savedProject?.segmentContinuityFrameSets?.["1-1"]).toEqual([
        "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-1-kf-1.jpg",
        "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-1-kf-2.jpg",
        "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-1-kf-3.jpg",
        "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-1-kf-4.jpg",
        "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-1-kf-5.jpg",
        "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-1-kf-6.jpg",
      ]);
      expect(savedProject?.segmentContinuityGridImages?.["1-1"]).toEqual(
        expect.objectContaining({
          imageUrl: expect.stringContaining(
            "E:\\projects\\projects\\video-project-1\\media\\images\\segment-continuity\\",
          ),
          recapText: expect.any(String),
          frameUrls: [
            "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-1-kf-1.jpg",
            "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-1-kf-2.jpg",
            "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-1-kf-3.jpg",
            "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-1-kf-4.jpg",
            "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-1-kf-5.jpg",
            "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-1-kf-6.jpg",
          ],
          updatedAt: expect.any(String),
        }),
      );
      expect(savedProject?.segmentContinuityGridImages?.["1-1"]?.recapText).not.toContain("前情提要：");
      expect(
        savedProject?.assetManifest?.items.find((item) => item.id === "segment:1-1:continuity-grid"),
      ).toEqual(
        expect.objectContaining({
          kind: "segment-continuity-grid",
          label: expect.stringContaining("片段1-1"),
          meta: "前情六宫格",
        }),
      );
      expect(result.imageUrls).toBeUndefined();
      expect(result.imageLabels).toBeUndefined();
    } finally {
      gridRenderer.restore();
    }
  });

  it("writes a real plot recap paragraph into the six-grid image instead of a placeholder summary label", async () => {
    const gridRenderer = installContinuityGridRenderMocks();
    const extractVideoFrames = vi.fn(async () => ({
      ok: true,
      framePaths: [
        "E:\\library\\segment-1-2-kf-1.jpg",
        "E:\\library\\segment-1-2-kf-2.jpg",
        "E:\\library\\segment-1-2-kf-3.jpg",
        "E:\\library\\segment-1-2-kf-4.jpg",
        "E:\\library\\segment-1-2-kf-5.jpg",
        "E:\\library\\segment-1-2-kf-6.jpg",
      ],
    }));
    const writeBase64File = vi.fn(async ({ filePath }: { filePath: string }) => ({
      ok: true,
      filePath,
    }));
    window.electronAPI = {
      media: {
        extractVideoFrames,
      },
      storage: {
        getDefaultPath: vi.fn(async () => ({ files: "E:\\projects", db: "E:\\db" })),
        readBase64: vi.fn(async () => ({
          ok: true,
          exists: true,
          base64: "FRAME_BASE64",
          mimeType: "image/jpeg",
        })),
        writeBase64File,
      },
    } as unknown as typeof window.electronAPI;

    try {
      const nextProject = await refreshSegmentContinuityArtifactsFromSegmentVideoSource({
        project: createVideoProject({
          segmentVideos: {
            "1-2": "E:\\library\\segment-1-2-story.mp4",
          },
          scenes: [
            {
              id: "scene-1",
              sceneNumber: 1,
              sceneName: "深坑压制",
              description: "苏辰被叶昊重创后倒在演武场深坑之中，周围弟子的嘲笑与压迫感不断逼近",
              characters: ["苏辰", "叶昊"],
              dialogue: "",
              cameraDirection: "wide push-in",
              duration: 5,
              segmentLabel: "1-2",
            },
            {
              id: "scene-2",
              sceneNumber: 2,
              sceneName: "危险逼近",
              description: "随着镜头持续缓慢推进，苏辰染血的右手逐渐握紧裂纹木剑，空气中的烟尘与灵气开始异常波动，叶昊也逐渐察觉到危险气息",
              characters: ["苏辰", "叶昊"],
              dialogue: "",
              cameraDirection: "slow push",
              duration: 5,
              segmentLabel: "1-2",
            },
            {
              id: "scene-3",
              sceneNumber: 3,
              sceneName: "觉醒前夜",
              description: "苏辰缓慢抬头，压抑已久的力量即将彻底觉醒",
              characters: ["苏辰", "叶昊"],
              dialogue: "",
              cameraDirection: "close-up",
              duration: 5,
              segmentLabel: "1-2",
            },
          ],
          segmentVideoPrompts: {
            "1-2": {
              segmentLabel: "1-2",
              prompt: [
                "全局风格：电影级黑色玄幻短剧质感，15秒，烈日炎烤的压抑肃杀氛围，冷调与高光对比的胶片光影。",
                "视觉锚点：陆沉武场青石台，黑发玄衣的陆沉被锁铜柱，满脸横肉的萧家执事手持剔骨尖刀。",
                "镜头推进：",
                "分镜1（0-5秒）：烈日如火，镜头从低角度缓慢向前推向演武场中央。",
                "分镜2（5-10秒）：陆沉浑身是血，他无力地低垂着头。",
                "分镜3（10-15秒）：苏辰缓慢抬头，压抑已久的力量即将彻底觉醒。",
                "结尾钩子：苏辰缓慢抬头，压抑已久的力量即将彻底觉醒。",
                "通用后缀：无字幕、无水印、无屏幕文字",
              ].join("\n"),
              duration: 15,
              targetDuration: 15,
              modelKey: "doubao-seedance-2-0-480p",
              maxDurationForModel: 15,
              sceneIds: ["scene-1", "scene-2", "scene-3"],
              generatedAt: "2026-04-03T00:00:00.000Z",
            },
          },
        }),
        segmentLabel: "1-2",
        videoUrl: "E:\\library\\segment-1-2-story.mp4",
      });

      const recapText = nextProject.segmentContinuityGridImages?.["1-2"]?.recapText || "";
      expect(recapText).not.toContain("人物状态：");
      expect(recapText).not.toContain("场景描述：");
      expect(recapText).not.toContain("人物动作：");
      expect(recapText).not.toContain("发生事件：");
      expect(recapText).toContain("苏辰被叶昊重创");
      expect(recapText).toContain("深坑压制");
      expect(recapText).toContain("握紧裂纹木剑");
      expect(recapText).toContain("力量即将彻底觉醒");
      expect(recapText).not.toContain("前情提要：");

      const paintedText = gridRenderer.fillText.mock.calls
        .map(([text]) => String(text || "").trim())
        .filter(Boolean);
      expect(paintedText).toContain("片段 1-2 前情六宫格");
      const titleIndex = paintedText.indexOf("片段 1-2 前情六宫格");
      const paintedRecap = paintedText.slice(titleIndex + 1).join("");
      expect(paintedRecap).toBe(`前情提要：${recapText}`);
      expect(writeBase64File).toHaveBeenCalled();
    } finally {
      gridRenderer.restore();
    }
  });

  it("extracts continuity keyframes from the segment video entry that feeds the library video tab", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });
    cacheProjectVideoSource.mockResolvedValue({
      localPath: "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-3.mp4",
      previewUrl: "file:///E:/projects/video-project-1/media/videos/generated/segment-1-3.mp4",
      size: 1024,
      mimeType: "video/mp4",
    });
    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: {
            status: "completed",
            video_url: "https://media.storyforge.test/generated-segment-1-3.mp4",
            last_frame_url: "https://media.storyforge.test/generated-segment-1-3-last.jpg",
          },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });
    const extractVideoFrames = vi.fn(async () => ({
      ok: true,
      framePaths: [
        "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-3-kf-1.jpg",
        "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-3-kf-2.jpg",
        "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-3-kf-3.jpg",
        "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-3-kf-4.jpg",
        "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-3-kf-5.jpg",
      ],
    }));
    window.electronAPI = {
      media: {
        extractVideoFrames,
      },
    } as unknown as typeof window.electronAPI;

    const runtime = createRuntime(
      createVideoProject({
        segmentVideoPrompts: {
          "1-3": {
            segmentLabel: "1-3",
            prompt: "Segment prompt",
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
        segmentVideoStatuses: {
          "1-3": {
            segmentLabel: "1-3",
            status: "processing",
            taskId: "task-segment-1-3",
            provider: "jimeng",
            updatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    await refreshSegmentVideoAction({ segmentLabel: "1-3" }, runtime);

    expect(extractVideoFrames).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-3.mp4",
      }),
    );
  });

  it("prefers an existing local segment library video when the provider only returns a remote completion url", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });
    cacheProjectVideoSource.mockResolvedValue(null);
    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: {
            status: "completed",
            video_url: "https://media.storyforge.test/generated-segment-1-4.mp4",
            last_frame_url: "https://media.storyforge.test/generated-segment-1-4-last.jpg",
          },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });
    const extractVideoFrames = vi.fn(async () => ({
      ok: true,
      framePaths: [
        "E:\\library\\segment-1-4-kf-1.jpg",
        "E:\\library\\segment-1-4-kf-2.jpg",
        "E:\\library\\segment-1-4-kf-3.jpg",
        "E:\\library\\segment-1-4-kf-4.jpg",
      ],
    }));
    window.electronAPI = {
      media: {
        extractVideoFrames,
      },
    } as unknown as typeof window.electronAPI;

    const runtime = createRuntime(
      createVideoProject({
        segmentVideos: {
          "1-4": "E:\\library\\segment-1-4-local.mp4",
        },
        segmentVideoPrompts: {
          "1-4": {
            segmentLabel: "1-4",
            prompt: "Segment prompt",
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
        segmentVideoStatuses: {
          "1-4": {
            segmentLabel: "1-4",
            status: "processing",
            taskId: "task-segment-1-4",
            provider: "jimeng",
            updatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    const result = await refreshSegmentVideoAction({ segmentLabel: "1-4" }, runtime);

    expect(extractVideoFrames).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "E:\\library\\segment-1-4-local.mp4",
      }),
    );
    expect(result.data?.videoProject?.segmentVideos?.["1-4"]).toBe(
      "https://media.storyforge.test/generated-segment-1-4.mp4",
    );
  });

  it("re-extracts continuity frames from a manually replaced local segment video source", async () => {
    const extractVideoFrames = vi.fn(async () => ({
      ok: true,
      framePaths: [
        "E:\\library\\segment-1-2-kf-1.jpg",
        "E:\\library\\segment-1-2-kf-2.jpg",
      ],
    }));
    window.electronAPI = {
      media: {
        extractVideoFrames,
      },
    } as unknown as typeof window.electronAPI;

    const nextProject = await refreshSegmentContinuityArtifactsFromSegmentVideoSource({
      project: createVideoProject({
        segmentVideos: {
          "1-2": "E:\\library\\segment-1-2-replaced.mp4",
        },
        segmentContinuityFrames: {
          "1-2": "E:\\library\\segment-1-2-old-last.jpg",
        },
        segmentContinuityFrameSets: {
          "1-2": [
            "E:\\library\\segment-1-2-old-kf-1.jpg",
            "E:\\library\\segment-1-2-old-kf-2.jpg",
          ],
        },
      }),
      segmentLabel: "1-2",
      videoUrl: "E:\\library\\segment-1-2-replaced.mp4",
    });

    expect(extractVideoFrames).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "E:\\library\\segment-1-2-replaced.mp4",
      }),
    );
    expect(nextProject.segmentVideos?.["1-2"]).toBe("E:\\library\\segment-1-2-replaced.mp4");
    expect(nextProject.segmentContinuityFrames?.["1-2"]).toBe("E:\\library\\segment-1-2-kf-2.jpg");
    expect(nextProject.segmentContinuityFrameSets?.["1-2"]).toEqual([
      "E:\\library\\segment-1-2-kf-1.jpg",
      "E:\\library\\segment-1-2-kf-2.jpg",
    ]);
  });

  it("samples nearby candidate frames around each six-grid anchor and always keeps the first and last frame for the recap six-grid", async () => {
    const extractVideoFrames = vi.fn(async ({ framePercents }: { framePercents: number[] }) => ({
      ok: true,
      framePaths: framePercents.map(
        (percent) => `E:\\library\\segment-1-2-candidate-${String(percent).padStart(2, "0")}.jpg`,
      ),
    }));
    window.electronAPI = {
      media: {
        extractVideoFrames,
      },
    } as unknown as typeof window.electronAPI;

    const nextProject = await refreshSegmentContinuityArtifactsFromSegmentVideoSource({
      project: createVideoProject({
        segmentVideos: {
          "1-2": "E:\\library\\segment-1-2-neighborhood.mp4",
        },
      }),
      segmentLabel: "1-2",
      videoUrl: "E:\\library\\segment-1-2-neighborhood.mp4",
    });

    expect(extractVideoFrames).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "E:\\library\\segment-1-2-neighborhood.mp4",
        framePercents: [
          0, 2, 4,
          24, 26, 28, 30, 32,
          40, 42, 44, 46, 48,
          56, 58, 60, 62, 64,
          72, 74, 76, 78, 80,
          96, 98, 100,
        ],
      }),
    );
    expect(nextProject.segmentContinuityFrames?.["1-2"]).toBe(
      "E:\\library\\segment-1-2-candidate-100.jpg",
    );
    expect(nextProject.segmentContinuityFrameSets?.["1-2"]).toEqual([
      "E:\\library\\segment-1-2-candidate-00.jpg",
      "E:\\library\\segment-1-2-candidate-28.jpg",
      "E:\\library\\segment-1-2-candidate-44.jpg",
      "E:\\library\\segment-1-2-candidate-60.jpg",
      "E:\\library\\segment-1-2-candidate-76.jpg",
      "E:\\library\\segment-1-2-candidate-100.jpg",
    ]);
  });

  it("emits dedicated history-backfill extraction copy for existing local segment videos", async () => {
    const extractVideoFrames = vi.fn(async () => ({
      ok: true,
      framePaths: [
        "E:\\library\\segment-1-2-kf-1.jpg",
        "E:\\library\\segment-1-2-kf-2.jpg",
      ],
    }));
    window.electronAPI = {
      media: {
        extractVideoFrames,
      },
    } as unknown as typeof window.electronAPI;

    const events: Array<{ status: string; progress: number; message: string; frameCount?: number }> = [];
    const handleExtractionEvent = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        status: string;
        progress: number;
        message: string;
        frameCount?: number;
      };
      if (detail) events.push(detail);
    };
    window.addEventListener(
      "agent:segment-continuity-extraction",
      handleExtractionEvent as EventListener,
    );

    try {
      await refreshSegmentContinuityArtifactsFromSegmentVideoSource({
        project: createVideoProject({
          segmentVideos: {
            "1-2": "E:\\library\\segment-1-2-history.mp4",
          },
        }),
        segmentLabel: "1-2",
        videoUrl: "E:\\library\\segment-1-2-history.mp4",
        progressPreset: "history-backfill",
      });
    } finally {
      window.removeEventListener(
        "agent:segment-continuity-extraction",
        handleExtractionEvent as EventListener,
      );
    }

    expect(events.map((event) => event.message)).toEqual([
      "正在补历史片段六宫格…",
      "已抽取 2 张候选帧，正在生成六宫格…",
      "历史片段补全完成，已保留 2 张参考帧并更新六宫格。",
    ]);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        status: "completed",
        progress: 100,
        frameCount: 2,
      }),
    );
  });

  it("clears stale continuity frames when a replaced segment video yields no usable keyframes", async () => {
    const extractVideoFrames = vi.fn(async () => ({
      ok: true,
      framePaths: [],
    }));
    window.electronAPI = {
      media: {
        extractVideoFrames,
      },
    } as unknown as typeof window.electronAPI;

    const nextProject = await refreshSegmentContinuityArtifactsFromSegmentVideoSource({
      project: createVideoProject({
        segmentVideos: {
          "1-2": "E:\\library\\segment-1-2-empty.mp4",
        },
        segmentContinuityFrames: {
          "1-2": "E:\\library\\segment-1-2-old-last.jpg",
        },
        segmentContinuityFrameSets: {
          "1-2": [
            "E:\\library\\segment-1-2-old-kf-1.jpg",
            "E:\\library\\segment-1-2-old-kf-2.jpg",
          ],
        },
      }),
      segmentLabel: "1-2",
      videoUrl: "E:\\library\\segment-1-2-empty.mp4",
    });

    expect(extractVideoFrames).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "E:\\library\\segment-1-2-empty.mp4",
      }),
    );
    expect(nextProject.segmentVideos?.["1-2"]).toBe("E:\\library\\segment-1-2-empty.mp4");
    expect(nextProject.segmentContinuityFrames?.["1-2"]).toBeUndefined();
    expect(nextProject.segmentContinuityFrameSets?.["1-2"]).toBeUndefined();
  });

  it("falls back to the last extracted keyframe while keeping the full fixed continuity frame set when the provider does not return a last-frame url", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });
    cacheProjectVideoSource.mockResolvedValue({
      localPath: "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-2.mp4",
      previewUrl: "file:///E:/projects/video-project-1/media/videos/generated/segment-1-2.mp4",
      size: 1024,
      mimeType: "video/mp4",
    });
    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: {
            status: "completed",
            video_url: "https://media.storyforge.test/generated-segment-1-2.mp4",
          },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });
    window.electronAPI = {
      media: {
        extractVideoFrames: vi.fn(async () => ({
          ok: true,
          framePaths: [
            "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-2-kf-1.jpg",
            "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-2-kf-2.jpg",
            "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-2-kf-3.jpg",
            "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-2-kf-4.jpg",
            "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-2-kf-5.jpg",
            "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-2-kf-6.jpg",
          ],
        })),
      },
    } as unknown as typeof window.electronAPI;

    const runtime = createRuntime(
      createVideoProject({
        segmentVideoPrompts: {
          "1-2": {
            segmentLabel: "1-2",
            prompt: "Segment prompt",
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
        segmentVideoStatuses: {
          "1-2": {
            segmentLabel: "1-2",
            status: "processing",
            taskId: "task-segment-1-2",
            provider: "jimeng",
            updatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    const result = await refreshSegmentVideoAction({ segmentLabel: "1-2" }, runtime);
    const savedProject = result.data?.videoProject;

    expect(savedProject?.segmentContinuityFrames?.["1-2"]).toBe(
      "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-2-kf-6.jpg",
    );
    expect(savedProject?.segmentContinuityFrameSets?.["1-2"]).toEqual([
      "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-2-kf-1.jpg",
      "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-2-kf-2.jpg",
      "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-2-kf-3.jpg",
      "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-2-kf-4.jpg",
      "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-2-kf-5.jpg",
      "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-2-kf-6.jpg",
    ]);
  });

  it("keeps a fixed chronological six-frame continuity set for recap assembly", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });
    cacheProjectVideoSource.mockResolvedValue({
      localPath: "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-3.mp4",
      previewUrl: "file:///E:/projects/video-project-1/media/videos/generated/segment-1-3.mp4",
      size: 1024,
      mimeType: "video/mp4",
    });
    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: {
            status: "completed",
            video_url: "https://media.storyforge.test/generated-segment-1-3.mp4",
            last_frame_url: "https://media.storyforge.test/generated-segment-1-3-last.jpg",
          },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });
    window.electronAPI = {
      media: {
        extractVideoFrames: vi.fn(async () => ({
          ok: true,
          framePaths: [
            "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-3-kf-1.jpg",
            "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-3-kf-2.jpg",
            "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-3-kf-3.jpg",
            "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-3-kf-4.jpg",
            "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-3-kf-5.jpg",
            "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-3-kf-6.jpg",
          ],
        })),
      },
    } as unknown as typeof window.electronAPI;

    const runtime = createRuntime(
      createVideoProject({
        segmentVideoPrompts: {
          "1-3": {
            segmentLabel: "1-3",
            prompt: "Segment prompt",
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
        segmentVideoStatuses: {
          "1-3": {
            segmentLabel: "1-3",
            status: "processing",
            taskId: "task-segment-1-3",
            provider: "jimeng",
            updatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    const result = await refreshSegmentVideoAction({ segmentLabel: "1-3" }, runtime);
    const savedProject = result.data?.videoProject;

    expect(savedProject?.segmentContinuityFrames?.["1-3"]).toBe(
      "https://media.storyforge.test/generated-segment-1-3-last.jpg",
    );
    expect(savedProject?.segmentContinuityFrameSets?.["1-3"]).toEqual([
      "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-3-kf-1.jpg",
      "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-3-kf-2.jpg",
      "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-3-kf-3.jpg",
      "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-3-kf-4.jpg",
      "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-3-kf-5.jpg",
      "E:\\projects\\video-project-1\\media\\videos\\generated\\segment-1-3-kf-6.jpg",
    ]);
  });

  it("submits aggregated segment references for Seedance 2.0 Fast image-to-video generation", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", status: "submitted", provider: "jimeng" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Warehouse",
            description: "Hero enters the warehouse.",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "wide tracking shot",
            duration: 6,
            segmentLabel: "1-1",
            storyboardUrl: "https://media.storyforge.test/storyboard-1.jpg",
          },
        ],
        characters: [
          {
            id: "hero-1",
            name: "Hero",
            description: "Lead actor reference.",
            imageUrl: "https://example.com/hero-ref.jpg",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        sceneSettings: [
          {
            id: "setting-warehouse",
            name: "Warehouse",
            description: "Cold industrial warehouse.",
            imageUrl: "https://example.com/warehouse-ref.jpg",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-2-0-fast-260128",
          resolution: "720p",
          mode: "image-to-video",
        },
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "Segment prompt that should use every available reference asset.",
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-2-0-fast-260128",
            maxDurationForModel: 15,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    await generateSegmentVideoAction({ segmentLabel: "1-1" }, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    expect(generateArgs).toEqual(
      expect.objectContaining({
        provider: "jimeng",
        model: "doubao-seedance-2-0-fast-260128",
        resolution: "720p",
        duration: 6,
        imageUrl: "https://example.com/warehouse-ref.jpg",
        videoMode: "image-to-video",
      }),
    );
    expect(generateArgs?.referenceImageUrls).toEqual([
      "https://example.com/warehouse-ref.jpg",
      "https://media.storyforge.test/storyboard-1.jpg",
      "https://example.com/hero-ref.jpg",
    ]);
  });

  it("passes aggregated HappyHorse segment references into the RunningHub HappyHorse transport", async () => {
    saveApiConfig({
      aliyunKey: "test-aliyun-key",
      aliyunEndpoint: "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
      runninghubKey: "test-runninghub-key",
      runninghubEndpoint: "https://www.runninghub.cn",
    });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", status: "submitted", provider: "runninghub-happyhorse" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Warehouse",
            description: "Hero enters the warehouse.",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "wide tracking shot",
            duration: 6,
            segmentLabel: "1-1",
            storyboardUrl: "https://media.storyforge.test/storyboard-1.jpg",
          },
        ],
        characters: [
          {
            id: "hero-1",
            name: "Hero",
            description: "Lead actor reference.",
            imageUrl: "https://example.com/hero-ref.jpg",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        sceneSettings: [
          {
            id: "setting-warehouse",
            name: "Warehouse",
            description: "Cold industrial warehouse.",
            imageUrl: "https://example.com/warehouse-ref.jpg",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "happyhorse-1.0",
          resolution: "720p",
          mode: "image-to-video",
        },
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "Segment prompt that should use every available reference asset.",
            duration: 6,
            targetDuration: 6,
            modelKey: "happyhorse-1.0",
            maxDurationForModel: 15,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    await generateSegmentVideoAction({ segmentLabel: "1-1" }, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    expect(generateArgs).toEqual(
      expect.objectContaining({
        provider: "runninghub-happyhorse",
        model: "happyhorse-1.0",
        resolution: "720p",
        imageUrl: "https://example.com/warehouse-ref.jpg",
        videoMode: "image-to-video",
      }),
    );
    expect(generateArgs?.referenceImageUrls).toEqual([
      "https://example.com/warehouse-ref.jpg",
      "https://media.storyforge.test/storyboard-1.jpg",
      "https://example.com/hero-ref.jpg",
    ]);
  });

  it("records failed segment video status when segment submission fails", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });
    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return { data: null, error: new Error("segment submit failed") };
      }
      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Warehouse",
            description: "Hero enters the warehouse.",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "wide tracking shot",
            duration: 6,
            segmentLabel: "1-1",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "Segment prompt",
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    const result = await generateSegmentVideoAction({ segmentLabel: "1-1" }, runtime);
    const savedProject = result.data?.videoProject;

    expect(result.summary).toContain("片段 1-1 视频生成失败");
    expect(savedProject?.segmentVideoStatuses?.["1-1"]?.status).toBe("failed");
    expect(savedProject?.segmentVideoStatuses?.["1-1"]?.failure?.stage).toBe("submit");
    expect(savedProject?.segmentVideoStatuses?.["1-1"]?.failure?.message).toContain("segment submit failed");
  });

  it("emits a failed segment video event when segment submission fails", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });
    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return { data: null, error: new Error("segment submit failed") };
      }
      throw new Error(`unexpected function: ${name}`);
    });

    const emittedEvents: CustomEvent[] = [];
    const handleVideoFailed = (event: Event) => {
      emittedEvents.push(event as CustomEvent);
    };
    window.addEventListener("agent:video-generated-one-failed", handleVideoFailed as EventListener);
    try {
      const runtime = createRuntime(
        createVideoProject({
          scenes: [
            {
              id: "scene-1",
              sceneNumber: 1,
              sceneName: "Warehouse",
              description: "Hero enters the warehouse.",
              characters: ["Hero"],
              dialogue: "",
              cameraDirection: "wide tracking shot",
              duration: 6,
              segmentLabel: "1-1",
            },
          ],
          videoGenerationPrefs: {
            modelKey: "doubao-seedance-1-5-pro",
            resolution: "720p",
            mode: "text-to-video",
          },
          segmentVideoPrompts: {
            "1-1": {
              segmentLabel: "1-1",
              prompt: "Segment prompt",
              duration: 6,
              targetDuration: 6,
              modelKey: "doubao-seedance-1-5-pro",
              maxDurationForModel: 12,
              sceneIds: ["scene-1"],
              generatedAt: "2026-04-03T00:00:00.000Z",
            },
          },
        }),
      );

      await generateSegmentVideoAction({ segmentLabel: "1-1", mediaEventId: "media:segment-failed-1" }, runtime);

      expect(emittedEvents).toEqual([
        expect.objectContaining({
          type: "agent:video-generated-one-failed",
          detail: expect.objectContaining({
            mediaEventId: "media:segment-failed-1",
            segmentLabel: "1-1",
            reason: expect.stringContaining("segment submit failed"),
          }),
        }),
      ]);
    } finally {
      window.removeEventListener("agent:video-generated-one-failed", handleVideoFailed as EventListener);
    }
  });

  it("marks a segment as failed when video submission does not return a task id", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });
    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", taskId: "", status: "submitted", provider: "jimeng" },
          error: null,
        };
      }
      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Warehouse",
            description: "Hero enters the warehouse.",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "wide tracking shot",
            duration: 6,
            segmentLabel: "1-1",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "Segment prompt",
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    const result = await generateSegmentVideoAction({ segmentLabel: "1-1" }, runtime);
    const savedProject = result.data?.videoProject;

    expect(result.summary).toContain("task_id");
    expect(savedProject?.segmentVideoStatuses?.["1-1"]?.status).toBe("failed");
    expect(savedProject?.segmentVideoStatuses?.["1-1"]?.failure?.stage).toBe("submit");
    expect(savedProject?.segmentVideoStatuses?.["1-1"]?.failure?.message).toContain("task_id");
  });

  it("prefers RunningHub for live-action segment generation when a RunningHub key is available", async () => {
    saveApiConfig({
      jimengExecutionMode: "api",
      jimengKey: "test-jimeng-key",
      runninghubKey: "test-runninghub-key",
      runninghubEndpoint: "https://www.runninghub.cn",
    });
    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", taskId: "", status: "submitted", provider: "runninghub-seedance" },
          error: null,
        };
      }
      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        artStyle: "live-action",
        imageGenerationPrefs: {
          familyKey: "nano-banana-pro",
          resolution: "default",
          aspectRatio: "16:9",
          styleCategory: "realistic",
          stylePreset: "live-action",
        },
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "仓库门前",
            description: "主角在雨夜仓库门口急停抬眼。",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "中景跟拍",
            duration: 6,
            segmentLabel: "1-1",
          },
        ],
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "电影级真人写实动作戏。",
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
      }),
    );

    await generateSegmentVideoAction({ segmentLabel: "1-1" }, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    expect(generateArgs).toEqual(
      expect.objectContaining({
        provider: "runninghub-seedance",
        model: "doubao-seedance-1-5-pro_720p",
      }),
    );
  });

  it("keeps live-action Seedance on RunningHub even when the project lost explicit style prefs", async () => {
    saveApiConfig({
      jimengExecutionMode: "api",
      jimengKey: "test-jimeng-key",
      runninghubKey: "test-runninghub-key",
      runninghubEndpoint: "https://www.runninghub.cn",
    });
    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", taskId: "", status: "submitted", provider: "runninghub-seedance" },
          error: null,
        };
      }
      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        artStyle: "",
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "仓库门前",
            description: "主角在雨夜仓库门口急停抬眼。",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "中景跟拍",
            duration: 6,
            segmentLabel: "1-1",
          },
        ],
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "电影级真人写实动作戏。",
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
      }),
    );

    await generateSegmentVideoAction({ segmentLabel: "1-1" }, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    expect(generateArgs).toEqual(
      expect.objectContaining({
        provider: "runninghub-seedance",
        model: "doubao-seedance-1-5-pro_720p",
      }),
    );
  });

  it("keeps non-live-action segment generation on the default provider when RunningHub is available", async () => {
    saveApiConfig({
      jimengExecutionMode: "api",
      jimengKey: "test-jimeng-key",
      runninghubKey: "test-runninghub-key",
      runninghubEndpoint: "https://www.runninghub.cn",
    });
    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", taskId: "", status: "submitted", provider: "jimeng" },
          error: null,
        };
      }
      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        artStyle: "anime-3d",
        imageGenerationPrefs: {
          familyKey: "nano-banana-pro",
          resolution: "default",
          aspectRatio: "16:9",
          styleCategory: "animation-3d",
          stylePreset: "anime-3d",
        },
        shotStyle: "三渲二动作番剧感",
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "霓虹街口",
            description: "角色在霓虹街口回身拔刀。",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "中景跟拍",
            duration: 6,
            segmentLabel: "1-1",
          },
        ],
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "三渲二动作番剧风格。",
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
      }),
    );

    await generateSegmentVideoAction({ segmentLabel: "1-1" }, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    expect(generateArgs).toEqual(
      expect.objectContaining({
        provider: "jimeng",
        model: "doubao-seedance-1-5-pro_720p",
      }),
    );
  });

  it("records an automatic local repair task when segment QA fails but repair budget remains", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });
    invokeFunction.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === "generate-video") {
        if (args?.action === "status") {
          return {
            data: {
              status: "completed",
              state: "completed",
              video_url: "https://media.storyforge.test/segment-1-2.mp4",
              last_frame_url: "https://media.storyforge.test/segment-1-2-last.jpg",
            },
            error: null,
          };
        }
        return {
          data: { task_id: "segment-task-1", status: "submitted", provider: "jimeng" },
          error: null,
        };
      }
      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "雨夜追击",
            description: "主角从雨夜长街冲入仓库入口。",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "跟拍",
            duration: 6,
            segmentLabel: "1-1",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "仓库对峙",
            description: "主角在仓库门口急停回头。",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "中景",
            duration: 6,
            segmentLabel: "1-2",
          },
        ],
        segmentVideos: {
          "1-1": "https://media.storyforge.test/segment-1-1.mp4",
        },
        segmentContinuityFrames: {
          "1-1": "https://media.storyforge.test/segment-1-1-last.jpg",
        },
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "完整片段 1-1 提示词",
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
          "1-2": {
            segmentLabel: "1-2",
            prompt: "电影级真人动作戏。",
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-2"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
      }),
    );

    const emittedEvents: CustomEvent[] = [];
    const handleVideoFailed = (event: Event) => {
      emittedEvents.push(event as CustomEvent);
    };
    window.addEventListener("agent:video-generated-one-failed", handleVideoFailed as EventListener);
    vi.useFakeTimers();
    try {
      const resultPromise = generateSegmentVideoAction({ segmentLabel: "1-2" }, runtime);
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await resultPromise;
      const savedProject = result.data?.videoProject;

      expect(result.summary).toContain("自动 QA 未通过");
      expect(savedProject?.videoAuditPackets?.at(-1)).toEqual(
        expect.objectContaining({
          targetType: "segment",
          segmentLabel: "1-2",
          status: "regenerate",
        }),
      );
      expect(savedProject?.videoRepairTasks?.at(-1)).toEqual(
        expect.objectContaining({
          targetType: "segment",
          segmentLabel: "1-2",
          route: "regenerate",
          status: "pending",
        }),
      );
      expect(savedProject?.segmentVideoPrompts?.["1-2"]?.prompt).toBeUndefined();
      expect(savedProject?.segmentVideos?.["1-2"]).toBeUndefined();
      expect(analyzeSegmentVideoVisualQuality).toHaveBeenCalledWith(
        expect.objectContaining({
          videoUrl: "https://media.storyforge.test/segment-1-2.mp4",
          submittedPrompt: expect.any(String),
        }),
      );
      expect(savedProject?.automationState?.segments?.["1-2"]).toEqual(
        expect.objectContaining({
          totalPasses: 1,
          regenerateCount: 1,
          latestRepairTaskId: "repair:segment:1-2",
        }),
      );
      expect(savedProject?.archivedSegmentVideos?.["1-2"]?.[0]).toEqual(
        expect.objectContaining({
          segmentLabel: "1-2",
          videoUrl: "https://media.storyforge.test/segment-1-2.mp4",
          route: "regenerate",
          auditId: savedProject?.videoAuditPackets?.at(-1)?.id,
          provider: "jimeng",
          taskId: "segment-task-1",
          submittedPrompt: expect.any(String),
        }),
      );
      expect(emittedEvents).toEqual([
        expect.objectContaining({
          type: "agent:video-generated-one-failed",
          detail: expect.objectContaining({
            segmentLabel: "1-2",
            url: "https://media.storyforge.test/segment-1-2.mp4",
            previewVideoUrl: "https://media.storyforge.test/segment-1-2.mp4",
            historyEntryId: savedProject?.archivedSegmentVideos?.["1-2"]?.[0]?.id,
            failure: expect.objectContaining({
              route: "regenerate",
              previewVideoUrl: "https://media.storyforge.test/segment-1-2.mp4",
            }),
          }),
        }),
      ]);
    } finally {
      window.removeEventListener("agent:video-generated-one-failed", handleVideoFailed as EventListener);
      vi.useRealTimers();
    }
  });

  it("escalates a segment into review when QA budget is exhausted", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });
    invokeFunction.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === "generate-video") {
        if (args?.action === "status") {
          return {
            data: {
              status: "completed",
              state: "completed",
              video_url: "https://media.storyforge.test/segment-1-2.mp4",
              last_frame_url: "https://media.storyforge.test/segment-1-2-last.jpg",
            },
            error: null,
          };
        }
        return {
          data: { task_id: "segment-task-2", status: "submitted", provider: "jimeng" },
          error: null,
        };
      }
      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "雨夜追击",
            description: "主角从雨夜长街冲入仓库入口。",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "跟拍",
            duration: 6,
            segmentLabel: "1-1",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "仓库对峙",
            description: "主角在仓库门口急停回头。",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "中景",
            duration: 6,
            segmentLabel: "1-2",
          },
        ],
        segmentVideos: {
          "1-1": "https://media.storyforge.test/segment-1-1.mp4",
        },
        segmentContinuityFrames: {
          "1-1": "https://media.storyforge.test/segment-1-1-last.jpg",
        },
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "完整片段 1-1 提示词",
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
          "1-2": {
            segmentLabel: "1-2",
            prompt: "电影级真人动作戏。",
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-2"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
        automationState: {
          strategy: "quality-first",
          segmentPassBudget: 1,
          localRepairBudget: 0,
          regenerateBudget: 0,
          assetPrimaryRetryBudget: 3,
          assetVariantRetryBudget: 2,
          segments: {
            "1-2": {
              totalPasses: 1,
              localRepairCount: 0,
              regenerateCount: 0,
            },
          },
          updatedAt: "2026-04-03T00:00:00.000Z",
        },
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
      }),
    );

    vi.useFakeTimers();
    try {
      const resultPromise = generateSegmentVideoAction({ segmentLabel: "1-2" }, runtime);
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await resultPromise;
      const savedProject = result.data?.videoProject;

      expect(result.summary).toContain("review");
      expect(savedProject?.videoRepairTasks?.at(-1)).toEqual(
        expect.objectContaining({
          segmentLabel: "1-2",
          route: "escalate",
          status: "exhausted",
        }),
      );
      expect(savedProject?.reviewQueue).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            targetIds: ["segment:1-2"],
          }),
        ]),
      );
      expect(savedProject?.automationState?.segments?.["1-2"]).toEqual(
        expect.objectContaining({
          exhausted: true,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks escalated segment review items approved and closes the repair task", async () => {
    const runtime = createRuntime(
      createVideoProject({
        reviewQueue: [
          {
            id: "review:segment:1-2",
            title: "片段 1-2",
            summary: "自动 QA 超出预算",
            targetIds: ["segment:1-2"],
            status: "pending",
            createdAt: "2026-04-03T00:00:00.000Z",
            updatedAt: "2026-04-03T00:00:00.000Z",
          },
        ],
        videoRepairTasks: [
          {
            id: "repair:segment:1-2",
            targetType: "segment",
            targetId: "segment:1-2",
            segmentLabel: "1-2",
            route: "escalate",
            status: "exhausted",
            reason: "自动 QA 超出预算",
            attempts: 5,
            createdAt: "2026-04-03T00:00:00.000Z",
            updatedAt: "2026-04-03T00:00:00.000Z",
          },
        ],
        automationState: {
          localRepairBudget: 2,
          regenerateBudget: 2,
          segmentPassBudget: 5,
          segments: {
            "1-2": {
              totalPasses: 5,
              localRepairCount: 2,
              regenerateCount: 2,
              exhausted: true,
              latestRepairTaskId: "repair:segment:1-2",
            },
          },
          updatedAt: "2026-04-03T00:00:00.000Z",
        },
      }),
    );

    const result = await approveVideoAssetsAction({ targetIds: ["segment:1-2"] }, runtime);
    const savedProject = result.data?.videoProject;

    expect(savedProject?.reviewQueue?.[0]).toEqual(
      expect.objectContaining({
        id: "review:segment:1-2",
        status: "approved",
      }),
    );
    expect(savedProject?.videoRepairTasks?.[0]).toEqual(
      expect.objectContaining({
        id: "repair:segment:1-2",
        status: "completed",
      }),
    );
    expect(savedProject?.automationState?.segments?.["1-2"]).toEqual(
      expect.objectContaining({
        exhausted: false,
      }),
    );
  });

  it("turns a reviewed segment redo into a pending regenerate task and clears stale segment output", async () => {
    const runtime = createRuntime(
      createVideoProject({
        reviewQueue: [
          {
            id: "review:segment:1-2",
            title: "片段 1-2",
            summary: "自动 QA 超出预算",
            targetIds: ["segment:1-2"],
            status: "pending",
            createdAt: "2026-04-03T00:00:00.000Z",
            updatedAt: "2026-04-03T00:00:00.000Z",
          },
        ],
        segmentVideos: {
          "1-2": "https://media.storyforge.test/segment-1-2.mp4",
        },
        segmentVideoPrompts: {
          "1-2": {
            segmentLabel: "1-2",
            prompt: "旧提示词",
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-2"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
        videoRepairTasks: [
          {
            id: "repair:segment:1-2",
            targetType: "segment",
            targetId: "segment:1-2",
            segmentLabel: "1-2",
            route: "escalate",
            status: "exhausted",
            reason: "自动 QA 超出预算",
            attempts: 5,
            createdAt: "2026-04-03T00:00:00.000Z",
            updatedAt: "2026-04-03T00:00:00.000Z",
          },
        ],
        automationState: {
          localRepairBudget: 2,
          regenerateBudget: 2,
          segmentPassBudget: 5,
          segments: {
            "1-2": {
              totalPasses: 5,
              localRepairCount: 2,
              regenerateCount: 2,
              exhausted: true,
              latestRepairTaskId: "repair:segment:1-2",
            },
          },
          updatedAt: "2026-04-03T00:00:00.000Z",
        },
      }),
    );

    const result = await redoVideoAssetsAction({ targetIds: ["segment:1-2"], reason: "人工判定需要重做" }, runtime);
    const savedProject = result.data?.videoProject;

    expect(savedProject?.reviewQueue?.[0]).toEqual(
      expect.objectContaining({
        id: "review:segment:1-2",
        status: "redo",
      }),
    );
    expect(savedProject?.videoRepairTasks?.[0]).toEqual(
      expect.objectContaining({
        id: "repair:segment:1-2",
        route: "regenerate",
        status: "pending",
        reason: "人工判定需要重做",
      }),
    );
    expect(savedProject?.segmentVideos?.["1-2"]).toBeUndefined();
    expect(savedProject?.segmentVideoPrompts?.["1-2"]).toBeUndefined();
    expect(savedProject?.automationState?.segments?.["1-2"]).toEqual(
      expect.objectContaining({
        exhausted: false,
      }),
    );
  });

  it("resets an exhausted reference asset target back to pending when review marks it for redo", async () => {
    const runtime = createRuntime(
      createVideoProject({
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "Main character reference",
            imageUrl: "",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        sceneSettings: [],
        reviewQueue: [
          {
            id: "review:reference-character:char-1",
            title: "角色参考图 · Hero",
            summary: "已超出自动补图预算",
            targetIds: ["reference-character:char-1"],
            status: "pending",
            createdAt: "2026-04-03T00:00:00.000Z",
            updatedAt: "2026-04-03T00:00:00.000Z",
          },
        ],
        automationState: {
          strategy: "quality-first",
          segmentPassBudget: 5,
          localRepairBudget: 2,
          regenerateBudget: 2,
          assetPrimaryRetryBudget: 3,
          assetVariantRetryBudget: 2,
          segments: {},
          referenceTargets: {
            "reference-character:char-1": {
              targetId: "reference-character:char-1",
              targetType: "character-primary",
              entityId: "char-1",
              status: "exhausted",
              attemptCount: 3,
              retryBudget: 3,
              lastError: "provider timeout",
              qualityScore: 62,
              lastQaSummary: "旧的失败结论",
              lastQaScore: 62,
              lastQaPassed: false,
              lastQaIssues: ["脸部识别不稳定"],
              lastQaAt: "2026-04-03T00:00:00.000Z",
            },
          },
          updatedAt: "2026-04-03T00:00:00.000Z",
        },
      }),
    );

    const result = await redoVideoAssetsAction(
      { targetIds: ["reference-character:char-1"], reason: "人工允许继续自动补图" },
      runtime,
    );
    const savedProject = result.data?.videoProject;

    expect(savedProject?.reviewQueue?.[0]).toEqual(
      expect.objectContaining({
        id: "review:reference-character:char-1",
        status: "redo",
      }),
    );
    expect(savedProject?.automationState?.referenceTargets?.["reference-character:char-1"]).toEqual(
      expect.objectContaining({
        status: "pending",
        attemptCount: 0,
        retryBudget: 3,
        lastError: "人工允许继续自动补图",
        qualityScore: undefined,
        lastQaSummary: undefined,
        lastQaScore: undefined,
        lastQaPassed: undefined,
        lastQaIssues: undefined,
        lastQaAt: undefined,
      }),
    );
  });

  it("runs auto QA after a refreshed segment completes when submission metadata is available", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });
    cacheProjectVideoSource.mockImplementation(async (remoteUrl: string) => ({
      localPath: remoteUrl.replace("https://media.storyforge.test/", "E:/videos/"),
    }));
    invokeFunction.mockImplementation(async (name: string, payload?: Record<string, unknown>) => {
      if (name !== "generate-video") {
        throw new Error(`unexpected function: ${name}`);
      }
      expect(payload).toEqual(expect.objectContaining({ action: "status", taskId: "segment-refresh-1" }));
      return {
        data: {
          status: "completed",
          state: "completed",
          video_url: "https://media.storyforge.test/segment-refresh-1.mp4",
          last_frame_url: "https://media.storyforge.test/segment-refresh-1-last.jpg",
        },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Warehouse",
            description: "Hero enters the warehouse.",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "wide tracking shot",
            duration: 6,
            segmentLabel: "1-1",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "片段提示词",
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
        segmentVideoStatuses: {
          "1-1": {
            segmentLabel: "1-1",
            status: "processing",
            taskId: "segment-refresh-1",
            provider: "jimeng",
            submittedPrompt: "电影感测试。\n\n分镜1（0-6秒）：\nHero enters the warehouse.\n\n通用后缀： 无字幕、无水印、无屏幕文字",
            referenceImageUrls: [],
            usedContinuityFrame: false,
            usedRelayVideo: false,
            updatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    const result = await refreshSegmentVideoAction({ segmentLabel: "1-1" }, runtime);
    const savedProject = result.data?.videoProject;

    expect(result.summary).toContain("自动 QA");
    expect(savedProject?.videoAuditPackets?.at(-1)).toEqual(
      expect.objectContaining({
        targetType: "segment",
        segmentLabel: "1-1",
        status: "local_repair",
      }),
    );
    expect(savedProject?.videoRepairTasks?.at(-1)).toEqual(
      expect.objectContaining({
        targetType: "segment",
        segmentLabel: "1-1",
        route: "local_repair",
      }),
    );
    expect(analyzeSegmentVideoVisualQuality).toHaveBeenCalledWith(
      expect.objectContaining({
        videoUrl: "E:/videos/segment-refresh-1.mp4",
        submittedPrompt: expect.stringContaining("通用后缀"),
      }),
    );
    expect(savedProject?.segmentVideos?.["1-1"]).toBeUndefined();
    expect(savedProject?.segmentContinuityFrames?.["1-1"]).toBeUndefined();
    expect(savedProject?.segmentContinuityFrameSets?.["1-1"]).toBeUndefined();
    expect(savedProject?.segmentContinuityGridImages?.["1-1"]).toBeUndefined();
    expect(savedProject?.archivedSegmentVideos?.["1-1"]?.[0]).toEqual(
      expect.objectContaining({
        videoUrl: "E:/videos/segment-refresh-1.mp4",
        route: "local_repair",
        provider: "jimeng",
        taskId: "segment-refresh-1",
      }),
    );
  });

  it("does not block a refreshed segment just because visual QA sees subtitle pollution", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });
    cacheProjectVideoSource.mockImplementation(async (remoteUrl: string) => ({
      localPath: remoteUrl.replace("https://media.storyforge.test/", "E:/videos/"),
    }));
    analyzeSegmentVideoVisualQuality.mockResolvedValue({
      inspected: true,
      frameCount: 3,
      summary: "片段整体连续，只有轻微字幕污染，可直接作为成片片段使用。",
      continuityScore: 90,
      identityScore: 92,
      semanticScore: 89,
      visualScore: 88,
      subtitleVisible: true,
      watermarkVisible: false,
      deliverableReady: false,
      issues: ["画面中央出现了可见字幕。"],
    });
    invokeFunction.mockImplementation(async (name: string, payload?: Record<string, unknown>) => {
      if (name !== "generate-video") {
        throw new Error(`unexpected function: ${name}`);
      }
      expect(payload).toEqual(expect.objectContaining({ action: "status", taskId: "segment-refresh-2" }));
      return {
        data: {
          status: "completed",
          state: "completed",
          video_url: "https://media.storyforge.test/segment-refresh-2.mp4",
          last_frame_url: "https://media.storyforge.test/segment-refresh-2-last.jpg",
        },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Warehouse pursuit",
            description: "Hero rushes into the warehouse and locks onto the shadow ahead.",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "tracking shot",
            duration: 6,
            segmentLabel: "1-1",
          },
        ],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "片段提示词",
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
        segmentVideoStatuses: {
          "1-1": {
            segmentLabel: "1-1",
            status: "processing",
            taskId: "segment-refresh-2",
            provider: "jimeng",
            submittedPrompt: [
              "电影级现实动作风格，6秒，冷色压迫氛围。",
              "",
              "冷色工业仓库，Hero 深色外套，雨夜入口与反光地面保持一致。",
              "",
              "分镜1（0-3秒）：",
              "Hero 冲入仓库后急停回头，身体仍带着上一段冲刺余势。",
              "",
              "分镜2（3-6秒）：",
              "镜头跟进 Hero 视线，前方阴影里的人影逐渐显形。",
              "",
              "环境细节：",
              "雨水滴落，脚步回响，呼吸急促。",
              "",
              "结尾钩子：",
              "最后一帧停在 Hero 视线锁定阴影的瞬间。",
              "",
              "通用后缀： 无字幕、无水印、无屏幕文字",
            ].join("\n"),
            referenceImageUrls: ["https://media.storyforge.test/hero-anchor.jpg"],
            usedContinuityFrame: false,
            usedRelayVideo: false,
            updatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    const result = await refreshSegmentVideoAction({ segmentLabel: "1-1" }, runtime);
    const savedProject = result.data?.videoProject;

    expect(result.summary).toContain("视频已刷新完成");
    expect(savedProject?.videoAuditPackets?.at(-1)).toEqual(
      expect.objectContaining({
        targetType: "segment",
        segmentLabel: "1-1",
        status: "pass",
        visualInspection: expect.objectContaining({
          inspected: true,
          subtitleVisible: true,
          deliverableReady: false,
        }),
      }),
    );
    expect(savedProject?.videoRepairTasks?.length ?? 0).toBe(0);
    expect(savedProject?.segmentVideos?.["1-1"]).toBe("E:/videos/segment-refresh-2.mp4");
    expect(savedProject?.segmentVideoStatuses?.["1-1"]?.status).toBe("completed");
    expect(analyzeSegmentVideoVisualQuality).toHaveBeenCalledWith(
      expect.objectContaining({
        videoUrl: "E:/videos/segment-refresh-2.mp4",
        submittedPrompt: expect.stringContaining("通用后缀"),
      }),
    );
  });

  it("caps first-batch segment video generation to three items per run", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });
    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "generate-video") {
        return {
          data: { task_id: "", status: "submitted", provider: "jimeng" },
          error: null,
        };
      }
      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: ["1-1", "1-2", "1-3", "1-4", "1-5"].map((segmentLabel, index) => ({
          id: `scene-${index + 1}`,
          sceneNumber: index + 1,
          sceneName: `Scene ${index + 1}`,
          description: `Description ${index + 1}`,
          characters: [],
          dialogue: "",
          cameraDirection: "",
          duration: 6,
          segmentLabel,
        })) as PersistedVideoProject["scenes"],
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
        segmentVideoPrompts: Object.fromEntries(
          ["1-1", "1-2", "1-3", "1-4", "1-5"].map((segmentLabel, index) => [
            segmentLabel,
            {
              segmentLabel,
              prompt: `prompt ${segmentLabel}`,
              duration: 6,
              targetDuration: 6,
              modelKey: "doubao-seedance-1-5-pro",
              maxDurationForModel: 12,
              sceneIds: [`scene-${index + 1}`],
              generatedAt: "2026-04-03T00:00:00.000Z",
            },
          ]),
        ),
      }),
    );

    const result = await generateSegmentVideoAction({ batchMode: "first" }, runtime);
    const submittedCalls = invokeFunction.mock.calls.filter(
      ([name, payload]) => name === "generate-video" && !(payload as { action?: string }).action,
    );

    expect(submittedCalls).toHaveLength(3);
    expect(
      submittedCalls.map(([, payload]) => (payload as { prompt?: string }).prompt),
    ).toEqual([
      expect.stringContaining("prompt 1-1"),
      expect.stringContaining("prompt 1-2"),
      expect.stringContaining("prompt 1-3"),
    ]);
    expect(result.summary).toContain("本轮按视频批次上限处理 3/5 个片段");
    expect(result.summary).toContain("继续点击同一个按钮会补下一批");
  });

  it("logs the segment prompt before the 3-second guard and only submits afterwards", async () => {
    vi.useFakeTimers();
    __setVideoWorkflowMediaSubmissionGuardDelayForTests(3000);
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });
    invokeFunction.mockImplementation(async (name: string, payload?: Record<string, unknown>) => {
      if (name !== "generate-video") {
        throw new Error(`unexpected function: ${name}`);
      }
      if (payload?.action === "status") {
        return {
          data: { status: "completed", video_url: "https://example.com/segment-task-1.mp4" },
          error: null,
        };
      }
      return {
        data: { task_id: "segment-task-1", status: "queued", provider: "jimeng" },
        error: null,
      };
    });

    const onProgress = vi.fn();
    const runtime = createRuntime(
      createVideoProject({
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            description: "Description 1",
            characters: [],
            dialogue: "",
            cameraDirection: "",
            duration: 6,
            segmentLabel: "1-1",
          },
        ] as PersistedVideoProject["scenes"],
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "prompt 1-1",
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    const pending = generateSegmentVideoAction({ segmentLabel: "1-1" }, runtime, onProgress);

    await Promise.resolve();
    expect(onProgress.mock.calls[0]?.[0]?.summary).toContain("已整理 1 个片段视频生成任务");
    expect(onProgress.mock.calls[0]?.[0]?.summary).toContain("prompt 1-1");
    expect(onProgress.mock.calls[0]?.[0]?.summary).toContain("3 秒防误触保护");
    await vi.runAllTimersAsync();
    await pending;

    const summaries = onProgress.mock.calls.map((call) => String(call[0]?.summary || ""));
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.stringContaining("已提交到 Seedance / Ark"),
      ]),
    );
    expect(invokeFunction).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("returns remaining segment labels after a completed first batch and persists finished segment videos", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });
    let submitCount = 0;
    cacheProjectVideoSource.mockImplementation(async (remoteUrl: string) => ({
      localPath: remoteUrl.replace("https://example.com/", "E:/videos/"),
    }));
    invokeFunction.mockImplementation(async (name: string, payload: Record<string, unknown>) => {
      if (name !== "generate-video") {
        throw new Error(`unexpected function: ${name}`);
      }

      if (payload.action === "status") {
        const taskId = String(payload.taskId || "");
        return {
          data: { status: "completed", video_url: `https://example.com/${taskId}.mp4` },
          error: null,
        };
      }

      submitCount += 1;
      return {
        data: { task_id: `segment-task-${submitCount}`, status: "queued", provider: "jimeng" },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
        scenes: ["1-1", "1-2", "1-3", "1-4", "1-5"].map((segmentLabel, index) => ({
          id: `scene-${index + 1}`,
          sceneNumber: index + 1,
          sceneName: `Scene ${index + 1}`,
          description: `Description ${index + 1}`,
          characters: [],
          dialogue: "",
          cameraDirection: "",
          duration: 6,
          segmentLabel,
        })) as PersistedVideoProject["scenes"],
        segmentVideoPrompts: Object.fromEntries(
          ["1-1", "1-2", "1-3", "1-4", "1-5"].map((segmentLabel, index) => [
            segmentLabel,
            {
              segmentLabel,
              prompt: `prompt ${segmentLabel}`,
              duration: 6,
              targetDuration: 6,
              modelKey: "doubao-seedance-1-5-pro",
              maxDurationForModel: 12,
              sceneIds: [`scene-${index + 1}`],
              generatedAt: "2026-04-03T00:00:00.000Z",
            },
          ]),
        ),
      }),
    );

    vi.useFakeTimers();
    try {
      const resultPromise = generateSegmentVideoAction({ batchMode: "first" }, runtime);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.remainingTargetIds).toEqual(["1-4", "1-5"]);
      expect(result.data?.videoProject?.segmentVideos).toMatchObject({
        "1-1": "E:/videos/segment-task-1.mp4",
        "1-2": "E:/videos/segment-task-2.mp4",
        "1-3": "E:/videos/segment-task-3.mp4",
      });
      expect(upsertStoredVideoProject.mock.calls.length).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports command-style progress while generating a segment video", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });
    cacheProjectVideoSource.mockImplementation(async (remoteUrl: string) => ({
      localPath: remoteUrl.replace("https://example.com/", "E:/videos/"),
    }));
    invokeFunction.mockImplementation(async (name: string, payload?: Record<string, unknown>) => {
      if (name !== "generate-video") {
        throw new Error(`unexpected function: ${name}`);
      }

      if (payload?.action === "status") {
        return {
          data: { status: "completed", video_url: "https://example.com/segment-progress-1.mp4" },
          error: null,
        };
      }

      return {
        data: { task_id: "segment-progress-1", status: "queued", provider: "jimeng" },
        error: null,
      };
    });

    const onProgress = vi.fn();
    const runtime = createRuntime(
      createVideoProject({
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            description: "Description 1",
            characters: [],
            dialogue: "",
            cameraDirection: "",
            duration: 6,
            segmentLabel: "1-1",
          },
        ] as PersistedVideoProject["scenes"],
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "prompt 1-1",
            duration: 6,
            targetDuration: 6,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 12,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    vi.useFakeTimers();
    try {
      const resultPromise = generateSegmentVideoAction({ segmentLabel: "1-1" }, runtime, onProgress);
      await vi.runAllTimersAsync();
      await resultPromise;
    } finally {
      vi.useRealTimers();
    }

    const summaries = onProgress.mock.calls.map((call) => call[0]?.summary).filter(Boolean);
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.stringContaining("已整理 1 个片段视频生成任务"),
        expect.stringContaining("片段视频 [.] 0/1 片段"),
        expect.stringContaining("片段视频 [>] 0/1 片段"),
        expect.stringContaining("片段 1-1"),
      ]),
    );
  });

  it("surfaces HappyHorse submit and poll details in segment video progress summaries", async () => {
    saveApiConfig({
      aliyunEndpoint:
        "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
      aliyunKey: "test-aliyun-key",
    });

    cacheProjectVideoSource.mockImplementation(async (remoteUrl: string) => ({
      localPath: remoteUrl.replace("https://example.com/", "E:/videos/"),
    }));

    let statusCallCount = 0;
    invokeFunction.mockImplementation(async (name: string, payload?: Record<string, unknown>) => {
      if (name !== "generate-video") {
        throw new Error(`unexpected function: ${name}`);
      }

      if (payload?.action === "status") {
        statusCallCount += 1;
        if (statusCallCount === 1) {
          return {
            data: {
              status: "queued",
              prompt_tips: "Keep the reference character identity stable.",
            },
            error: null,
          };
        }
        return {
          data: { status: "completed", video_url: "https://example.com/segment-happyhorse-1.mp4" },
          error: null,
        };
      }

      return {
        data: { task_id: "segment-happyhorse-1", status: "queued", provider: "aliyun" },
        error: null,
      };
    });

    const onProgress = vi.fn();
    const runtime = createRuntime(
      createVideoProject({
        videoGenerationPrefs: {
          modelKey: "happyhorse-1.0",
          resolution: "720p",
          mode: "text-to-video",
        },
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            description: "Description 1",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "",
            duration: 6,
            segmentLabel: "1-1",
          },
        ] as PersistedVideoProject["scenes"],
        characters: [
          {
            id: "character-1",
            name: "Hero",
            description: "Main hero",
            imageUrl: "https://example.com/hero.png",
            isAIGenerated: false,
            source: "auto",
          },
        ] as PersistedVideoProject["characters"],
        sceneSettings: [
          {
            id: "scene-setting-1",
            name: "Scene 1",
            description: "Scene reference",
            imageUrl: "https://example.com/scene.png",
            isAIGenerated: false,
            source: "auto",
          },
        ] as PersistedVideoProject["sceneSettings"],
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "prompt 1-1",
            duration: 6,
            targetDuration: 6,
            modelKey: "happyhorse-1.0",
            maxDurationForModel: 12,
            sceneIds: ["scene-1"],
            generatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    vi.useFakeTimers();
    try {
      const resultPromise = generateSegmentVideoAction({ segmentLabel: "1-1" }, runtime, onProgress);
      await vi.runAllTimersAsync();
      await resultPromise;
    } finally {
      vi.useRealTimers();
    }

    const summaries = onProgress.mock.calls.map((call) => call[0]?.summary).filter(Boolean);
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.stringContaining("HappyHorse"),
        expect.stringContaining("参考：Scene 1、Hero"),
        expect.stringContaining("第 1/72 轮轮询"),
        expect.stringContaining("提示：Keep the reference character identity stable."),
      ]),
    );
  });

  it("submits batched segment videos concurrently up to the active video model limit", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });

    const submitGate = createDeferred<void>();
    let inFlightSubmits = 0;
    let maxInFlightSubmits = 0;
    let submitCount = 0;

    cacheProjectVideoSource.mockImplementation(async (remoteUrl: string) => ({
      localPath: remoteUrl.replace("https://example.com/", "E:/videos/"),
    }));
    invokeFunction.mockImplementation(async (name: string, payload?: Record<string, unknown>) => {
      if (name !== "generate-video") {
        throw new Error(`unexpected function: ${name}`);
      }

      if (payload?.action === "status") {
        const taskId = String(payload.taskId || "");
        return {
          data: { status: "completed", video_url: `https://example.com/${taskId}.mp4` },
          error: null,
        };
      }

      submitCount += 1;
      inFlightSubmits += 1;
      maxInFlightSubmits = Math.max(maxInFlightSubmits, inFlightSubmits);
      await submitGate.promise;
      inFlightSubmits -= 1;
      return {
        data: { task_id: `segment-concurrent-${submitCount}`, status: "queued", provider: "jimeng" },
        error: null,
      };
    });

    const runtime = createRuntime(
      createVideoProject({
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
        scenes: ["1-1", "1-2", "1-3"].map((segmentLabel, index) => ({
          id: `scene-${index + 1}`,
          sceneNumber: index + 1,
          sceneName: `Scene ${index + 1}`,
          description: `Description ${index + 1}`,
          characters: [],
          dialogue: "",
          cameraDirection: "",
          duration: 6,
          segmentLabel,
        })) as PersistedVideoProject["scenes"],
        segmentVideoPrompts: Object.fromEntries(
          ["1-1", "1-2", "1-3"].map((segmentLabel, index) => [
            segmentLabel,
            {
              segmentLabel,
              prompt: `prompt ${segmentLabel}`,
              duration: 6,
              targetDuration: 6,
              modelKey: "doubao-seedance-1-5-pro",
              maxDurationForModel: 12,
              sceneIds: [`scene-${index + 1}`],
              generatedAt: "2026-04-03T00:00:00.000Z",
            },
          ]),
        ),
      }),
    );

    vi.useFakeTimers();
    try {
      const resultPromise = generateSegmentVideoAction({ batchMode: "first" }, runtime);
      await flushMicrotasks();

      expect(maxInFlightSubmits).toBeGreaterThan(1);

      submitGate.resolve();
      await vi.runAllTimersAsync();
      await resultPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns remaining scene target ids and preserves the media event id for progressive video batches", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });
    cacheProjectVideoSource.mockResolvedValue({
      localPath: "D:\\StoryForgeFiles\\projects\\video-project-1\\media\\videos\\generated\\scene-1.mp4",
      previewUrl: "file:///D:/StoryForgeFiles/projects/video-project-1/media/videos/generated/scene-1.mp4",
      size: 1024,
      mimeType: "video/mp4",
    });
    invokeFunction.mockImplementation(async (name: string, payload?: Record<string, unknown>) => {
      if (name === "enhance-video-prompt") {
        return {
          data: { enhanced: "batch video prompt", duration: 6 },
          error: null,
        };
      }

      if (name === "generate-video" && payload?.action === "status") {
        return {
          data: {
            status: "completed",
            video_url: "https://media.storyforge.test/generated-scene-1.mp4",
          },
          error: null,
        };
      }

      if (name === "generate-video") {
        return {
          data: { task_id: "task-batch-scene-1", status: "submitted", provider: "jimeng" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const emittedEvents: CustomEvent[] = [];
    const handleVideoGenerated = (event: Event) => {
      emittedEvents.push(event as CustomEvent);
    };
    window.addEventListener("agent:video-generated-one", handleVideoGenerated as EventListener);
    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "闀滃ご涓€",
            description: "desc-1",
            characters: ["娌堟槶"],
            dialogue: "",
            cameraDirection: "shot-1",
            duration: 6,
            storyboardUrl: "https://media.storyforge.test/storyboard-1.jpg",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "闀滃ご浜?",
            description: "desc-2",
            characters: ["娌堟槶"],
            dialogue: "",
            cameraDirection: "shot-2",
            duration: 6,
            storyboardUrl: "https://media.storyforge.test/storyboard-2.jpg",
          },
        ],
      }),
    );

    vi.useFakeTimers();
    try {
      const onProgress = vi.fn();
      const resultPromise = generateVideoAssetsAction(
        { batchSize: 1, mediaEventId: "media:video-batch-1" },
        runtime,
        onProgress,
      );
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.videoUrls).toEqual([
        "D:\\StoryForgeFiles\\projects\\video-project-1\\media\\videos\\generated\\scene-1.mp4",
      ]);
      expect(result.remainingTargetIds).toEqual(["scene-2"]);
      expect(onProgress).toHaveBeenCalled();
      expect(emittedEvents).toEqual([
        expect.objectContaining({
          type: "agent:video-generated-one",
          detail: expect.objectContaining({
            mediaEventId: "media:video-batch-1",
            sceneId: "scene-1",
          }),
        }),
      ]);
    } finally {
      window.removeEventListener("agent:video-generated-one", handleVideoGenerated as EventListener);
      vi.useRealTimers();
    }
  });

  it("refreshes a completed segment video task into segmentVideos", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });
    cacheProjectVideoSource.mockResolvedValueOnce({ localPath: "E:/videos/segment-1-1.mp4" });
    invokeFunction.mockImplementation(async (name: string, payload: Record<string, unknown>) => {
      if (name === "generate-video" && payload.action === "status") {
        return {
          data: { status: "completed", video_url: "https://example.com/segment-1-1.mp4" },
          error: null,
        };
      }
      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
        segmentVideoStatuses: {
          "1-1": {
            segmentLabel: "1-1",
            status: "processing",
            taskId: "task-segment-1",
            provider: "jimeng",
            updatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    const result = await refreshSegmentVideoAction({ segmentLabel: "1-1" }, runtime);
    const savedProject = result.data?.videoProject;

    expect(result.summary).toContain("片段 1-1 视频已刷新完成");
    expect(savedProject?.segmentVideos?.["1-1"]).toBe("E:/videos/segment-1-1.mp4");
    expect(savedProject?.segmentVideoStatuses?.["1-1"]?.status).toBe("completed");
    expect(result.videoUrls).toEqual(["E:/videos/segment-1-1.mp4"]);
  });

  it("surfaces RunningHub failure details when a segment refresh query returns failed", async () => {
    invokeFunction.mockImplementation(async (name: string, payload: Record<string, unknown>) => {
      if (name === "generate-video" && payload.action === "status") {
        return {
          data: {
            status: "failed",
            state: "FAILED",
            error_code: "1505",
            error_message:
              "Current mode does not support real-person content. To enable it, set realPersonMode to true",
          },
          error: null,
        };
      }
      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(
      createVideoProject({
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-2-0",
          resolution: "480p",
          mode: "text-to-video",
        },
        segmentVideoStatuses: {
          "1-2": {
            segmentLabel: "1-2",
            status: "processing",
            taskId: "task-segment-runninghub-1",
            provider: "runninghub-seedance",
            updatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    const result = await refreshSegmentVideoAction({ segmentLabel: "1-2" }, runtime);
    const savedProject = result.data?.videoProject;

    expect(result.summary).toContain("1505");
    expect(result.summary).toContain("realPersonMode");
    expect(savedProject?.segmentVideoStatuses?.["1-2"]?.status).toBe("failed");
    expect(savedProject?.segmentVideoStatuses?.["1-2"]?.failure?.stage).toBe("status");
    expect(savedProject?.segmentVideoStatuses?.["1-2"]?.failure?.message).toContain("1505");
    expect(savedProject?.segmentVideoStatuses?.["1-2"]?.failure?.message).toContain("realPersonMode");
  });

  it("exports completed text-to-video segment outputs without requiring scene-level video urls", async () => {
    window.electronAPI = {
      storage: {
        copyFile: vi.fn(async () => ({ ok: true })),
      },
    } as unknown as typeof window.electronAPI;

    const runtime = createRuntime(
      createVideoProject({
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
          mode: "text-to-video",
        },
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "雨夜追击",
            description: "女主在雨夜回头看见追兵。",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "中景跟拍",
            duration: 6,
            storyboardUrl: "https://media.storyforge.test/storyboard-1.jpg",
            segmentLabel: "1-1",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "巷口转身",
            description: "她在巷口急停转身。",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "近景推近",
            duration: 5,
            storyboardUrl: "https://example.com/storyboard-2.jpg",
            segmentLabel: "1-1",
          },
        ],
        segmentVideos: {
          "1-1": "file:///E:/videos/segment-1-1.mp4",
        },
        segmentVideoStatuses: {
          "1-1": {
            segmentLabel: "1-1",
            status: "completed",
            taskId: "task-segment-1",
            provider: "jimeng",
            updatedAt: "2026-04-03T00:00:00.000Z",
          },
        },
      }),
    );

    const result = await compileSegmentVideosAction(
      { directoryPath: "E:\\exports\\video-test" },
      runtime,
    );

    expect(normalizeLocalVideoPath).toHaveBeenCalledWith("file:///E:/videos/segment-1-1.mp4");
    expect(window.electronAPI?.storage.copyFile).toHaveBeenCalledWith(
      "E:\\videos\\segment-1-1.mp4",
      "E:\\exports\\video-test\\segment-1-1.mp4",
    );
    expect(result.summary).toContain("已整理 1 个片段视频");
    expect(result.summary).toContain("已自动导出到 E:\\exports\\video-test");
    expect(result.data?.videoProject?.segmentVideos?.["1-1"]).toBe("E:\\videos\\segment-1-1.mp4");
  });

  it("normalizes the legacy dreamina-cli provider override back to the Seedance API path", async () => {
    saveApiConfig({
      jimengExecutionMode: "api",
      jimengKey: "seedance-key",
      geminiKey: "gemini-key",
    });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "enhance-video-prompt") {
        return {
          data: { enhanced: "enhanced video prompt", duration: 6 },
          error: null,
        };
      }

      if (name === "generate-video") {
        return {
          data: { task_id: "task-1", status: "completed", provider: "jimeng" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(createVideoProject({
      videoGenerationPrefs: {
        modelKey: "doubao-seedance-1-5-pro",
        resolution: "720p",
        mode: "image-to-video",
      },
    }));
    const result = await generateVideoAssetsAction({ provider: "dreamina-cli" }, runtime);
    const scene = result.data?.videoProject?.scenes[0];
    const enhanceArgs = invokeFunction.mock.calls.find(([name]) => name === "enhance-video-prompt")?.[1];
    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];

    expect(enhanceArgs).toEqual(
      expect.objectContaining({
        referenceImageUrl: "https://media.storyforge.test/storyboard-1.jpg",
      }),
    );
    expect(generateArgs).toEqual(
      expect.objectContaining({
        provider: "jimeng",
        duration: 6,
      }),
    );
    expect(generateArgs).toHaveProperty("imageUrl", "https://media.storyforge.test/storyboard-1.jpg");
    expect(scene?.videoTaskId).toBe("task-1");
    expect(scene?.videoProvider).toBe("jimeng");
    expect(scene?.videoStatus).toBe("completed");
    expect(result.summary).toContain("1");
  });

  it("fails fast when API mode is selected but no Seedance-compatible key is available", async () => {
    window.electronAPI = {} as typeof window.electronAPI;
    saveApiConfig({
      jimengEndpoint: "https://direct.seedance.test/v1/videos",
      jimengExecutionMode: "api",
      jimengKey: "",
      geminiKey: "",
      runninghubEndpoint: "",
      runninghubKey: "",
      aliyunEndpoint: "",
      aliyunKey: "",
    });

    const runtime = createRuntime(createVideoProject());

    await expect(generateVideoAssetsAction({}, runtime)).rejects.toThrow(
      "当前已锁定 API，但缺少 Seedance / Gemini 可用 Key，无法发起出片。",
    );
    expect(invokeFunction).not.toHaveBeenCalled();
  });

  it("requires a dedicated Ark key when the Seedance endpoint points to Volcengine Ark", async () => {
    window.electronAPI = {} as typeof window.electronAPI;
    saveApiConfig({
      jimengExecutionMode: "api",
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengKey: "",
      geminiKey: "shared-gemini-key",
    });

    const runtime = createRuntime(createVideoProject());

    await expect(generateVideoAssetsAction({}, runtime)).rejects.toThrow(
      "当前已锁定 API，但缺少 Seedance / Ark 专用 Key，无法发起出片。",
    );
    expect(invokeFunction).not.toHaveBeenCalled();
  });

  it("refreshes generated video results back into the homepage project state", async () => {
    cacheProjectVideoSource.mockResolvedValue({
      localPath: "D:\\StoryForgeFiles\\projects\\video-project-1\\media\\videos\\generated\\scene-1.mp4",
      previewUrl: "file:///D:/StoryForgeFiles/projects/video-project-1/media/videos/generated/scene-1.mp4",
      size: 1024,
      mimeType: "video/mp4",
    });
    invokeFunction.mockResolvedValue({
      data: {
        status: "succeeded",
        video_url: "https://example.com/video-new.mp4",
      },
      error: null,
    });

    const runtime = createRuntime(
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "雨夜追击",
            description: "女主在雨夜回头看见追兵。",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "中景跟拍",
            duration: 5,
            storyboardUrl: "https://media.storyforge.test/storyboard-1.jpg",
            videoUrl: "https://example.com/video-old.mp4",
            videoTaskId: "task-1",
            videoProvider: "dreamina-cli",
            videoStatus: "processing",
          },
        ],
      }),
    );

    const result = await refreshVideoAssetsAction({}, runtime);
    const scene = result.data?.videoProject?.scenes[0];

    expect(invokeFunction).toHaveBeenCalledWith(
      "generate-video",
      expect.objectContaining({
        action: "status",
        taskId: "task-1",
        provider: "dreamina-cli",
      }),
      expect.objectContaining({
        abortSignal: undefined,
      }),
    );
    expect(cacheProjectVideoSource).toHaveBeenCalledWith(
      "https://example.com/video-new.mp4",
      "镜头01_雨夜追击.mp4",
      "video-project-1",
    );
    expect(scene?.videoUrl).toBe("D:\\StoryForgeFiles\\projects\\video-project-1\\media\\videos\\generated\\scene-1.mp4");
    expect(scene?.videoStatus).toBe("completed");
    expect(scene?.videoHistory?.[0]?.videoUrl).toBe("https://example.com/video-old.mp4");
    expect(result.videoUrls).toEqual(["D:\\StoryForgeFiles\\projects\\video-project-1\\media\\videos\\generated\\scene-1.mp4"]);
    expect(result.summary).toContain("已完成 1 条镜头出片");
  });

  it("stores structured failure details when video submission fails", async () => {
    saveApiConfig({ jimengExecutionMode: "api", geminiKey: "test-gemini-key" });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "enhance-video-prompt") {
        return {
          data: { enhanced: "增强后的视频提示词", duration: 6 },
          error: null,
        };
      }

      if (name === "generate-video") {
        return {
          data: null,
          error: new Error("Seedance rate limit exceeded"),
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(createVideoProject());
    const result = await generateVideoAssetsAction({}, runtime);
    const scene = result.data?.videoProject?.scenes[0];

    expect(scene?.videoStatus).toBe("failed");
    expect(scene?.videoFailure?.stage).toBe("submit");
    expect(scene?.videoFailure?.message).toContain("Seedance rate limit exceeded");
    expect(result.summary).toContain("当前没有镜头成功提交出片任务。");
  });
  it("emits a failed scene video event when video submission fails", async () => {
    saveApiConfig({ jimengExecutionMode: "api", geminiKey: "test-gemini-key" });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "enhance-video-prompt") {
        return {
          data: { enhanced: "增强后的视频提示词", duration: 6 },
          error: null,
        };
      }

      if (name === "generate-video") {
        return {
          data: null,
          error: new Error("scene submit failed"),
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const emittedEvents: CustomEvent[] = [];
    const handleVideoFailed = (event: Event) => {
      emittedEvents.push(event as CustomEvent);
    };
    window.addEventListener("agent:video-generated-one-failed", handleVideoFailed as EventListener);
    try {
      const runtime = createRuntime(createVideoProject());
      await generateVideoAssetsAction({ mediaEventId: "media:scene-failed-1" }, runtime);

      expect(emittedEvents).toEqual([
        expect.objectContaining({
          type: "agent:video-generated-one-failed",
          detail: expect.objectContaining({
            mediaEventId: "media:scene-failed-1",
            sceneId: "scene-1",
            reason: expect.stringContaining("scene submit failed"),
          }),
        }),
      ]);
    } finally {
      window.removeEventListener("agent:video-generated-one-failed", handleVideoFailed as EventListener);
    }
  });

  it("marks a scene as failed when video submission does not return a task id", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "enhance-video-prompt") {
        return {
          data: { enhanced: "澧炲己鍚庣殑瑙嗛鎻愮ず璇?", duration: 6 },
          error: null,
        };
      }

      if (name === "generate-video") {
        return {
          data: { task_id: "", status: "queued", provider: "jimeng" },
          error: null,
        };
      }

      throw new Error(`unexpected function: ${name}`);
    });

    const runtime = createRuntime(createVideoProject());
    const result = await generateVideoAssetsAction({}, runtime);
    const scene = result.data?.videoProject?.scenes[0];

    expect(scene?.videoStatus).toBe("failed");
    expect(scene?.videoFailure?.stage).toBe("submit");
    expect(scene?.videoFailure?.message).toContain("task_id");
    expect(result.summary).toContain("当前没有镜头成功提交出片任务。");
  });
});

describe("planVideoWorkflowContinuation", () => {
  function makeBase(): PersistedVideoProject {
    return {
      id: "vp-plan-1",
      title: "测试项目",
      script: "测试脚本内容",
      targetPlatform: "抖音",
      shotStyle: "电影感",
      outputGoal: "预告片",
      productionNotes: "",
      scenes: [],
      characters: [],
      sceneSettings: [],
      artStyle: "live-action",
      currentStep: 1,
      systemPrompt: "",
      analysisSummary: "",
      storyboardPlan: "",
      videoPromptBatch: "",
      sourceProjectId: undefined,
      styleLock: null,
      worldModel: null,
      assetManifest: null,
      shotPackets: [],
      reviewQueue: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  it("returns analyze_script_for_video when no scenes exist", () => {
    const plan = planVideoWorkflowContinuation(makeBase());
    expect(plan.actionKind).toBe("analyze_script_for_video");
    expect(plan.policy).toBe("bootstrap-analysis");
  });

  it("returns analyze_script_for_video when saved scenes do not cover all script episodes", () => {
    const project = {
      ...makeBase(),
      script: [
        "第1集：开端\n正文",
        "第2集：推进\n正文",
        "第3集：转折\n正文",
        "第4集：收束\n正文",
      ].join("\n\n---\n\n"),
      scenes: [
        { id: "s1", sceneNumber: 1, segmentLabel: "1-1", sceneName: "s", description: "", characters: [], dialogue: "", cameraDirection: "", duration: 5 },
        { id: "s2", sceneNumber: 2, segmentLabel: "3-1", sceneName: "s", description: "", characters: [], dialogue: "", cameraDirection: "", duration: 5 },
      ],
    };
    const plan = planVideoWorkflowContinuation(project);
    expect(plan.actionKind).toBe("analyze_script_for_video");
    expect(plan.policy).toBe("bootstrap-analysis");
    expect(plan.reason).toContain("没有覆盖全部集数");
  });

  it("returns extract_video_entities when scenes exist but no entities", () => {
    const project = {
      ...makeBase(),
      scenes: [{ id: "s1", sceneNumber: 1, sceneName: "s", description: "", characters: [], dialogue: "", cameraDirection: "", duration: 5 }],
    };
    const plan = planVideoWorkflowContinuation(project);
    expect(plan.actionKind).toBe("extract_video_entities");
    expect(plan.policy).toBe("bootstrap-entities");
  });

  it("auto-generates missing reference assets for image-to-video when entities exist but assets are incomplete", () => {
    const project = {
      ...makeBase(),
      scenes: [{ id: "s1", sceneNumber: 1, sceneName: "s", description: "", characters: [], dialogue: "", cameraDirection: "", duration: 5 }],
      characters: [{ id: "c1", name: "角色A", description: "", isAIGenerated: false, source: "auto" as const }],
      sceneSettings: [{ id: "sc1", name: "场景A", description: "", isAIGenerated: false, source: "auto" as const }],
      videoGenerationPrefs: normalizeVideoGenerationPrefs({ mode: "image-to-video" }),
    };
    const plan = planVideoWorkflowContinuation(project);
    expect(plan.actionKind).toBe("generate_video_reference_assets");
    expect(plan.policy).toBe("bootstrap-reference-assets");
  });

  it("auto-generates missing reference assets for text-to-video when reference assets are still incomplete", () => {
    const project = {
      ...makeBase(),
      scenes: [{ id: "s1", sceneNumber: 1, sceneName: "s", description: "", characters: [], dialogue: "", cameraDirection: "", duration: 5 }],
      characters: [{ id: "c1", name: "角色A", description: "", isAIGenerated: false, source: "auto" as const }],
      sceneSettings: [{ id: "sc1", name: "场景A", description: "", isAIGenerated: false, source: "auto" as const }],
      videoGenerationPrefs: normalizeVideoGenerationPrefs({ mode: "text-to-video" }),
    };
    const plan = planVideoWorkflowContinuation(project);
    expect(plan.actionKind).toBe("generate_video_reference_assets");
    expect(plan.policy).toBe("bootstrap-reference-assets");
  });

  it("routes exhausted reference assets into review instead of blindly retrying", () => {
    const project = {
      ...makeBase(),
      scenes: [{ id: "s1", sceneNumber: 1, sceneName: "s", description: "", characters: [], dialogue: "", cameraDirection: "", duration: 5 }],
      characters: [{ id: "c1", name: "角色A", description: "", isAIGenerated: false, source: "auto" as const }],
      sceneSettings: [{ id: "sc1", name: "场景A", description: "", isAIGenerated: false, source: "auto" as const }],
      videoGenerationPrefs: normalizeVideoGenerationPrefs({ mode: "text-to-video" }),
      automationState: {
        strategy: "quality-first" as const,
        segmentPassBudget: 5,
        localRepairBudget: 2,
        regenerateBudget: 2,
        assetPrimaryRetryBudget: 3,
        assetVariantRetryBudget: 2,
        segments: {},
        referenceTargets: {
          "reference-character:c1": {
            targetId: "reference-character:c1",
            targetType: "character-primary" as const,
            entityId: "c1",
            status: "exhausted" as const,
            attemptCount: 3,
            retryBudget: 3,
            lastError: "provider timeout",
          },
        },
        updatedAt: "2026-04-03T00:00:00.000Z",
      },
      reviewQueue: [
        {
          id: "review:reference-character:c1",
          title: "角色参考图 · 角色A",
          summary: "已超出自动补图预算",
          targetIds: ["reference-character:c1"],
          status: "pending",
          createdAt: "2026-04-03T00:00:00.000Z",
          updatedAt: "2026-04-03T00:00:00.000Z",
        },
      ],
    };
    const plan = planVideoWorkflowContinuation(project);
    expect(plan.actionKind).toBe("review_video_assets");
    expect(plan.policy).toBe("review-escalated");
    expect(plan.input).toMatchObject({
      targetIds: ["reference-character:c1"],
    });
  });

  it("returns bridge-summary when manualStepOverride is ahead of natural step", () => {
    const project = {
      ...makeBase(),
      scenes: [{ id: "s1", sceneNumber: 1, sceneName: "s", description: "", characters: [], dialogue: "", cameraDirection: "", duration: 5 }],
      characters: [{ id: "c1", name: "角色A", description: "", isAIGenerated: false, source: "auto" as const }],
      sceneSettings: [{ id: "sc1", name: "场景A", description: "", isAIGenerated: false, source: "auto" as const }],
      videoGenerationPrefs: normalizeVideoGenerationPrefs({ mode: "text-to-video" }),
      // 自然进度是步骤 2（实体已提取，无 shotPackets），用户手动跳到步骤 4
      currentStep: 4,
      manualStepOverride: 4,
    };
    const plan = planVideoWorkflowContinuation(project);
    expect(plan.actionKind).toBe("create_video_bridge_artifact");
    expect(plan.policy).toBe("bridge-summary");
  });

  it("proceeds normally when manualStepOverride equals natural step", () => {
    const project = {
      ...makeBase(),
      scenes: [{ id: "s1", sceneNumber: 1, sceneName: "s", description: "", characters: [], dialogue: "", cameraDirection: "", duration: 5 }],
      characters: [{ id: "c1", name: "角色A", description: "", imageUrl: "https://example.com/char-a.jpg", isAIGenerated: false, source: "auto" as const }],
      sceneSettings: [{ id: "sc1", name: "场景A", description: "", imageUrl: "https://example.com/scene-a.jpg", isAIGenerated: false, source: "auto" as const }],
      videoGenerationPrefs: normalizeVideoGenerationPrefs({ mode: "text-to-video" }),
      currentStep: 2,
      manualStepOverride: 2,
    };
    const plan = planVideoWorkflowContinuation(project);
    // 自然步骤也是 2，override 不大于自然步骤，应正常推进
    expect(plan.actionKind).toBe("compile_video_shot_packets");
  });

  it("returns segment prompt preparation for text-to-video when shot packets exist but no prompts generated", () => {
    const shotPacket = (sceneId: string, sceneNumber: number): import("@/types/project").VideoShotPacket => ({
      id: `sp-${sceneId}`,
      sceneId,
      sceneNumber,
      title: `镜头${sceneNumber}`,
      durationSec: 5,
      camera: { shotSize: "中景", movement: "固定" },
      characterRefs: [],
      sourceAssetIds: [],
      promptSeed: "",
      forbiddenChanges: [],
      renderMode: "text2video",
    });
    const project = {
      ...makeBase(),
      scenes: [
        { id: "s1", sceneNumber: 1, sceneName: "镜头1", description: "", characters: [], dialogue: "", cameraDirection: "", duration: 5, segmentLabel: "1-1" },
        { id: "s2", sceneNumber: 2, sceneName: "镜头2", description: "", characters: [], dialogue: "", cameraDirection: "", duration: 5, segmentLabel: "1-2" },
      ],
      characters: [{ id: "c1", name: "角色A", description: "", imageUrl: "https://example.com/char-a.jpg", isAIGenerated: false, source: "auto" as const }],
      sceneSettings: [{ id: "sc1", name: "场景A", description: "", imageUrl: "https://example.com/scene-a.jpg", isAIGenerated: false, source: "auto" as const }],
      videoGenerationPrefs: normalizeVideoGenerationPrefs({ mode: "text-to-video" }),
      shotPackets: [shotPacket("s1", 1), shotPacket("s2", 2)],
      videoPromptBatch: "",
      segmentVideoPrompts: {},
    };
    const plan = planVideoWorkflowContinuation(project);
    expect(plan.actionKind).toBe("prepare_segment_video_prompt");
    expect(plan.policy).toBe("bootstrap-segment-prompt");
  });

  it("returns segment prompt preparation for text-to-video when only partial segment prompts are generated", () => {
    const shotPacket = (sceneId: string, sceneNumber: number): import("@/types/project").VideoShotPacket => ({
      id: `sp-${sceneId}`,
      sceneId,
      sceneNumber,
      title: `镜头${sceneNumber}`,
      durationSec: 5,
      camera: { shotSize: "中景", movement: "固定" },
      characterRefs: [],
      sourceAssetIds: [],
      promptSeed: "",
      forbiddenChanges: [],
      renderMode: "text2video",
    });
    const segPrompt = (label: string): import("@/types/project").SegmentVideoPrompt => ({
      segmentLabel: label,
      prompt: `片段${label}提示词`,
      duration: 15,
      targetDuration: 15,
      modelKey: "seedance",
      maxDurationForModel: 15,
      sceneIds: [],
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    const project = {
      ...makeBase(),
      scenes: [
        { id: "s1", sceneNumber: 1, sceneName: "镜头1", description: "", characters: [], dialogue: "", cameraDirection: "", duration: 5, segmentLabel: "1-1" },
        { id: "s2", sceneNumber: 2, sceneName: "镜头2", description: "", characters: [], dialogue: "", cameraDirection: "", duration: 5, segmentLabel: "1-2" },
      ],
      characters: [{ id: "c1", name: "角色A", description: "", imageUrl: "https://example.com/char-a.jpg", isAIGenerated: false, source: "auto" as const }],
      sceneSettings: [{ id: "sc1", name: "场景A", description: "", imageUrl: "https://example.com/scene-a.jpg", isAIGenerated: false, source: "auto" as const }],
      videoGenerationPrefs: normalizeVideoGenerationPrefs({ mode: "text-to-video" }),
      shotPackets: [shotPacket("s1", 1), shotPacket("s2", 2)],
      videoPromptBatch: "",
      // 只有片段 1-1 有提示词，1-2 缺失
      segmentVideoPrompts: { "1-1": segPrompt("1-1") },
    };
    const plan = planVideoWorkflowContinuation(project);
    expect(plan.actionKind).toBe("prepare_segment_video_prompt");
    expect(plan.policy).toBe("bootstrap-segment-prompt");
  });

  it("proceeds to video generation for text-to-video when all segment prompts are complete", () => {
    const shotPacket = (sceneId: string, sceneNumber: number): import("@/types/project").VideoShotPacket => ({
      id: `sp-${sceneId}`,
      sceneId,
      sceneNumber,
      title: `镜头${sceneNumber}`,
      durationSec: 5,
      camera: { shotSize: "中景", movement: "固定" },
      characterRefs: [],
      sourceAssetIds: [],
      promptSeed: "",
      forbiddenChanges: [],
      renderMode: "text2video",
    });
    const segPrompt = (label: string): import("@/types/project").SegmentVideoPrompt => ({
      segmentLabel: label,
      prompt: `片段${label}提示词`,
      duration: 15,
      targetDuration: 15,
      modelKey: "seedance",
      maxDurationForModel: 15,
      sceneIds: [],
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    const project = {
      ...makeBase(),
      scenes: [
        { id: "s1", sceneNumber: 1, sceneName: "镜头1", description: "", characters: [], dialogue: "", cameraDirection: "", duration: 5, segmentLabel: "1-1" },
        { id: "s2", sceneNumber: 2, sceneName: "镜头2", description: "", characters: [], dialogue: "", cameraDirection: "", duration: 5, segmentLabel: "1-2" },
      ],
      characters: [{ id: "c1", name: "角色A", description: "", imageUrl: "https://example.com/char-a.jpg", isAIGenerated: false, source: "auto" as const }],
      sceneSettings: [{ id: "sc1", name: "场景A", description: "", imageUrl: "https://example.com/scene-a.jpg", isAIGenerated: false, source: "auto" as const }],
      videoGenerationPrefs: normalizeVideoGenerationPrefs({ mode: "text-to-video" }),
      shotPackets: [shotPacket("s1", 1), shotPacket("s2", 2)],
      videoPromptBatch: "",
      segmentVideoPrompts: { "1-1": segPrompt("1-1"), "1-2": segPrompt("1-2") },
    };
    const plan = planVideoWorkflowContinuation(project);
    expect(plan.actionKind).toBe("generate_segment_video");
    expect(plan.policy).toBe("generate-next-segment-batch");
  });

  it("still prefers segment prompt continuation over scene prompt batches for segmented text-to-video projects", () => {
    const shotPacket = (sceneId: string, sceneNumber: number): import("@/types/project").VideoShotPacket => ({
      id: `sp-${sceneId}`,
      sceneId,
      sceneNumber,
      title: `镜头${sceneNumber}`,
      durationSec: 5,
      camera: { shotSize: "中景", movement: "固定" },
      characterRefs: [],
      sourceAssetIds: [],
      promptSeed: "",
      forbiddenChanges: [],
      renderMode: "text2video",
    });
    const project = {
      ...makeBase(),
      scenes: [
        { id: "s1", sceneNumber: 1, sceneName: "镜头1", description: "", characters: [], dialogue: "", cameraDirection: "", duration: 5, segmentLabel: "1-1" },
      ],
      characters: [{ id: "c1", name: "角色A", description: "", imageUrl: "https://example.com/char-a.jpg", isAIGenerated: false, source: "auto" as const }],
      sceneSettings: [{ id: "sc1", name: "场景A", description: "", imageUrl: "https://example.com/scene-a.jpg", isAIGenerated: false, source: "auto" as const }],
      videoGenerationPrefs: normalizeVideoGenerationPrefs({ mode: "text-to-video" }),
      shotPackets: [shotPacket("s1", 1)],
      videoPromptBatch: "批次 1 / 镜头 1 / 1-1\n场景：镜头1",
      segmentVideoPrompts: {},
    };
    const plan = planVideoWorkflowContinuation(project);
    expect(plan.actionKind).toBe("prepare_segment_video_prompt");
    expect(plan.policy).toBe("bootstrap-segment-prompt");
  });
});
