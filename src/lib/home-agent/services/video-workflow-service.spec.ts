import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioRuntimeState } from "@/lib/home-agent/types";
import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import { saveApiConfig } from "@/lib/api-config";
import { createEmptyDramaProject } from "@/types/drama";
import { normalizeVideoGenerationPrefs } from "@/lib/home-agent/video-models";

const createStoredVideoProject = vi.fn();
const loadStoredVideoProjectById = vi.fn();
const upsertStoredVideoProject = vi.fn(async (project: PersistedVideoProject) => ({
  ...project,
  updatedAt: "2026-04-03T01:00:00.000Z",
}));
const invokeFunction = vi.fn();
const cacheProjectVideoSource = vi.fn(async () => null);
const dreaminaCliGetStatus = vi.fn(async () => ({
  ok: true,
  installed: true,
  loggedIn: true,
  message: "已登录 Dreamina CLI",
}));

vi.mock("@/hooks/use-local-persistence", () => ({
  createStoredVideoProject,
  loadStoredVideoProjectById,
  upsertStoredVideoProject,
}));

vi.mock("@/lib/invoke-with-key", () => ({
  invokeFunction,
}));

vi.mock("@/lib/home-agent/video-cache", () => ({
  cacheProjectVideoSource,
}));

vi.mock("@/lib/dreamina-cli", () => ({
  dreaminaCliGetStatus,
}));

const {
  abortVideoWorkflowGeneration,
  analyzeScriptForVideoAction,
  compileVideoShotPacketsAction,
  extractVideoEntitiesAction,
  prepareVideoPromptBatchAction,
  prepareSegmentVideoPromptAction,
  generateSegmentVideoAction,
  refreshSegmentVideoAction,
  generateProjectImageAction,
  prepareStoryboardBatchAction,
  generateVideoReferenceAssetsAction,
  generateStoryboardFramesAction,
  generateVideoAssetsAction,
  refreshVideoAssetsAction,
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
        storyboardUrl: "https://example.com/storyboard-1.jpg",
      },
    ],
    characters: [
      {
        id: "char-1",
        name: "沈昭",
        description: "红衣、清冷、警觉",
        imageUrl: "https://example.com/char-1.jpg",
        isAIGenerated: false,
        source: "auto",
      },
    ],
    sceneSettings: [
      {
        id: "setting-1",
        name: "雨夜长街",
        description: "冷色夜雨中的长街",
        imageUrl: "https://example.com/scene-1.jpg",
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

describe("video-workflow-service execution", () => {
  beforeEach(() => {
    invokeFunction.mockReset();
    createStoredVideoProject.mockReset();
    loadStoredVideoProjectById.mockReset();
    upsertStoredVideoProject.mockClear();
    cacheProjectVideoSource.mockReset();
    cacheProjectVideoSource.mockResolvedValue(null);
    dreaminaCliGetStatus.mockReset();
    dreaminaCliGetStatus.mockResolvedValue({
      ok: true,
      installed: true,
      loggedIn: true,
      message: "已登录 Dreamina CLI",
    });
    window.electronAPI = undefined;
    localStorage.clear();
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
  });

  it("reports command-style progress while generating missing segment prompts", async () => {
    invokeFunction.mockImplementation(async (name: string) => {
      if (name !== "enhance-video-prompt") {
        throw new Error(`unexpected function: ${name}`);
      }
      return {
        data: {
          prompt: "Segment prompt",
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
            storyboardUrl: "https://example.com/storyboard-1.jpg",
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
            storyboardUrl: "https://example.com/storyboard-1.jpg",
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
          prompt: "merged segment prompt",
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
    expect(segmentPrompt).toContain("merged segment prompt");
    expect(segmentPrompt).toContain("scene 1");
    expect(segmentPrompt).toContain("scene 2");
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
          prompt: `segment ${body.segmentLabel} merged prompt`,
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

    const result = await prepareSegmentVideoPromptAction(
      {
        batchMode: "remaining",
        videoGenerationPrefs: { mode: "text-to-video", modelKey: "doubao-seedance-1-5-pro" },
      },
      createRuntime(createVideoProject({
        scenes,
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "existing 1-1 segment prompt",
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
    expect(segmentCalls).toHaveLength(2);
    expect(segmentCalls.map(([, body]) => body?.segmentLabel)).toEqual(["1-2", "1-3"]);
    expect(segmentCalls[0]?.[1]).toEqual(expect.objectContaining({
      previousSegmentPrompt: expect.stringContaining("existing 1-1 segment prompt"),
      previousSegmentSummary: expect.stringContaining("片段 1-1"),
      nextSegmentSummary: expect.stringContaining("片段 1-3"),
    }));
    expect(segmentCalls[1]?.[1]).toEqual(expect.objectContaining({
      previousSegmentPrompt: expect.stringContaining("segment 1-2 merged prompt"),
    }));

    const nextProject = result.data?.videoProject;
    expect(nextProject?.segmentVideoPrompts?.["1-1"]?.prompt).toContain("existing 1-1 segment prompt");
    expect(nextProject?.segmentVideoPrompts?.["1-2"]?.prompt).toContain("segment 1-2 merged prompt");
    expect(nextProject?.segmentVideoPrompts?.["1-3"]?.prompt).toContain("segment 1-3 merged prompt");
    expect(result.summary).toContain("已按顺序补齐 2 个剩余片段");
    expect(result.summary).toContain("片段覆盖进度：3 / 3");
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
          prompt: `segment ${body.segmentLabel} merged prompt`,
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
    expect(result.data?.videoProject?.segmentVideoPrompts?.["1-1"]?.prompt).toContain("segment 1-1 merged prompt");
    expect(result.data?.videoProject?.segmentVideoPrompts?.["1-2"]).toBeUndefined();
    expect(result.summary).toContain("已分批生成 1 个片段");
    expect(result.summary).toContain("下次点击“分批生成片段”会继续处理片段 1-2");
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
          data: { imageUrl: "https://example.com/generated-character.jpg" },
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
          data: { imageUrl: "https://example.com/generated-scene.jpg" },
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
        referenceImageUrl: "https://example.com/shared-reference.jpg",
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
      "https://example.com/generated-character.jpg",
      "https://example.com/generated-scene.jpg",
    ]);
  });

  it("caps smart reference asset batches to the active image model limit", async () => {
    invokeFunction.mockImplementation(async (name: string, body: Record<string, unknown>) => ({
      data: {
        imageUrl: `https://example.com/${name}-${String(body.assetFileNameStem || body.name).replace(/\W+/g, "-")}.jpg`,
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

    expect(invokeFunction).toHaveBeenCalledTimes(4);
    expect(invokeFunction.mock.calls.map(([name]) => name)).toEqual([
      "generate-character",
      "generate-character",
      "generate-character",
      "generate-character",
    ]);
    expect(result.summary).toContain("本轮按当前生图模型上限处理 4/6 个资产目标");
    expect(result.summary).toContain("还剩 2 个");
    expect(result.data?.videoProject?.characters?.[0]?.costumes?.[2]?.imageUrl).toBeTruthy();
    expect(result.data?.videoProject?.characters?.[0]?.costumes?.[3]?.imageUrl).toBeFalsy();
    expect(result.data?.videoProject?.sceneSettings?.[0]?.imageUrl).toBeFalsy();
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

    expect(invokeFunction).toHaveBeenCalledTimes(1);
    expect(result.summary).toContain("1 个生成失败");
    expect(result.summary).toContain("1 个变体因主参考图缺失已跳过");
    expect(result.data?.videoProject?.characters?.[0]?.imageUrl).toBe("");
    expect(result.data?.videoProject?.characters?.[0]?.costumes?.[0]?.imageUrl).toBeUndefined();
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
        referenceImageUrl: "https://example.com/shared-reference.jpg",
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
    expect(result.imageUrls).toEqual(["https://example.com/generated-storyboard.jpg"]);
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
        referenceImageUrl: "https://example.com/storyboard-1.jpg",
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
    expect(generateArgs).toHaveProperty("imageUrl", "https://example.com/storyboard-1.jpg");
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

  it("locks exact script dialogue into the prompt submitted to the video model", async () => {
    saveApiConfig({ jimengExecutionMode: "api", jimengKey: "test-jimeng-key" });

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "enhance-video-prompt") {
        return {
          data: { enhanced: "A cinematic visual prompt without the spoken line.", duration: 6 },
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
            storyboardUrl: "https://example.com/storyboard-1.jpg",
          },
        ],
      }),
    );

    await generateVideoAssetsAction({}, runtime);

    const generateArgs = invokeFunction.mock.calls.find(([name]) => name === "generate-video")?.[1];
    expect(generateArgs?.prompt).toContain("【精确台词锁定】");
    expect(generateArgs?.prompt).toContain(exactDialogue);
    expect(generateArgs?.prompt).toContain("不得改写、增删、同义替换、换序或遗漏");
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
        imageUrl: "https://example.com/storyboard-1.jpg",
      }),
    );
    expect(result.data?.videoProject?.videoGenerationPrefs).toEqual({
      modelKey: "doubao-seedance-1-5-pro",
      resolution: "720p",
      mode: "image-to-video",
    });
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
            storyboardUrl: "https://example.com/storyboard-1.jpg",
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
            prompt: "Segment prompt that already describes the warehouse reference.",
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
    expect(generateArgs).not.toHaveProperty("imageUrl");
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

  it("allows an explicit Dreamina CLI provider override for homepage video generation", async () => {
    saveApiConfig({ jimengExecutionMode: "cli" });

    window.electronAPI = {
      dreaminaCli: {
        exec: vi.fn(),
      },
    } as unknown as Window["electronAPI"];

    invokeFunction.mockImplementation(async (name: string) => {
      if (name === "enhance-video-prompt") {
        return {
          data: { enhanced: "增强后的视频提示词", duration: 6 },
          error: null,
        };
      }

      if (name === "generate-video") {
        return {
          data: { task_id: "task-1", status: "completed", provider: "dreamina-cli" },
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
        referenceImageUrl: "https://example.com/storyboard-1.jpg",
      }),
    );
    expect(generateArgs).toEqual(
      expect.objectContaining({
        provider: "dreamina-cli",
        duration: 6,
      }),
    );
    expect(generateArgs).toHaveProperty("imageUrl", "https://example.com/storyboard-1.jpg");
    expect(scene?.videoTaskId).toBe("task-1");
    expect(scene?.videoProvider).toBe("dreamina-cli");
    expect(scene?.videoStatus).toBe("completed");
    expect(result.summary).toContain("已提交 1 条镜头出片任务");
  });

  it("fails fast when CLI mode is selected but Dreamina CLI is unavailable", async () => {
    saveApiConfig({ jimengExecutionMode: "cli" });

    const runtime = createRuntime(createVideoProject());

    await expect(generateVideoAssetsAction({ provider: "dreamina-cli" }, runtime)).rejects.toThrow(
      "当前已锁定 CLI，但 Dreamina CLI 未安装或当前环境不支持，无法发起出片。",
    );
    expect(invokeFunction).not.toHaveBeenCalled();
  });

  it("fails fast when CLI mode is selected but Dreamina CLI is not logged in", async () => {
    saveApiConfig({ jimengExecutionMode: "cli" });
    window.electronAPI = {
      dreaminaCli: {
        exec: vi.fn(),
      },
    } as unknown as Window["electronAPI"];
    dreaminaCliGetStatus.mockResolvedValueOnce({
      ok: false,
      installed: true,
      loggedIn: false,
      message: "请先登录 Dreamina CLI",
    });

    const runtime = createRuntime(createVideoProject());

    await expect(generateVideoAssetsAction({ provider: "dreamina-cli" }, runtime)).rejects.toThrow(
      "当前已锁定 CLI，但 Dreamina CLI 尚未登录，无法发起出片。请先完成登录，或切回 API。",
    );
    expect(invokeFunction).not.toHaveBeenCalled();
  });

  it("fails fast when API mode is selected but no Seedance-compatible key is available", async () => {
    saveApiConfig({
      jimengExecutionMode: "api",
      jimengKey: "",
      geminiKey: "",
    });

    const runtime = createRuntime(createVideoProject());

    await expect(generateVideoAssetsAction({}, runtime)).rejects.toThrow(
      "当前已锁定 API，但缺少 Seedance / Gemini 可用 Key，无法发起出片。",
    );
    expect(invokeFunction).not.toHaveBeenCalled();
  });

  it("requires a dedicated Ark key when the Seedance endpoint points to Volcengine Ark", async () => {
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
            storyboardUrl: "https://example.com/storyboard-1.jpg",
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

  it("returns bridge-summary for image-to-video when entities exist but reference assets are missing", () => {
    const project = {
      ...makeBase(),
      scenes: [{ id: "s1", sceneNumber: 1, sceneName: "s", description: "", characters: [], dialogue: "", cameraDirection: "", duration: 5 }],
      characters: [{ id: "c1", name: "角色A", description: "", isAIGenerated: false, source: "auto" as const }],
      sceneSettings: [{ id: "sc1", name: "场景A", description: "", isAIGenerated: false, source: "auto" as const }],
      videoGenerationPrefs: normalizeVideoGenerationPrefs({ mode: "image-to-video" }),
    };
    const plan = planVideoWorkflowContinuation(project);
    expect(plan.actionKind).toBe("create_video_bridge_artifact");
    expect(plan.policy).toBe("bridge-summary");
  });

  it("returns compile_video_shot_packets for text-to-video even without reference assets", () => {
    const project = {
      ...makeBase(),
      scenes: [{ id: "s1", sceneNumber: 1, sceneName: "s", description: "", characters: [], dialogue: "", cameraDirection: "", duration: 5 }],
      characters: [{ id: "c1", name: "角色A", description: "", isAIGenerated: false, source: "auto" as const }],
      sceneSettings: [{ id: "sc1", name: "场景A", description: "", isAIGenerated: false, source: "auto" as const }],
      videoGenerationPrefs: normalizeVideoGenerationPrefs({ mode: "text-to-video" }),
    };
    const plan = planVideoWorkflowContinuation(project);
    expect(plan.actionKind).toBe("compile_video_shot_packets");
    expect(plan.policy).toBe("bootstrap-shot-packets");
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
      characters: [{ id: "c1", name: "角色A", description: "", isAIGenerated: false, source: "auto" as const }],
      sceneSettings: [{ id: "sc1", name: "场景A", description: "", isAIGenerated: false, source: "auto" as const }],
      videoGenerationPrefs: normalizeVideoGenerationPrefs({ mode: "text-to-video" }),
      currentStep: 2,
      manualStepOverride: 2,
    };
    const plan = planVideoWorkflowContinuation(project);
    // 自然步骤也是 2，override 不大于自然步骤，应正常推进
    expect(plan.actionKind).toBe("compile_video_shot_packets");
  });

  it("returns bridge-summary for text-to-video when shot packets exist but no prompts generated", () => {
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
      characters: [{ id: "c1", name: "角色A", description: "", isAIGenerated: false, source: "auto" as const }],
      sceneSettings: [{ id: "sc1", name: "场景A", description: "", isAIGenerated: false, source: "auto" as const }],
      videoGenerationPrefs: normalizeVideoGenerationPrefs({ mode: "text-to-video" }),
      shotPackets: [shotPacket("s1", 1), shotPacket("s2", 2)],
      videoPromptBatch: "",
      segmentVideoPrompts: {},
    };
    const plan = planVideoWorkflowContinuation(project);
    expect(plan.actionKind).toBe("create_video_bridge_artifact");
    expect(plan.policy).toBe("bridge-summary");
  });

  it("returns bridge-summary for text-to-video when only partial segment prompts are generated", () => {
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
      characters: [{ id: "c1", name: "角色A", description: "", isAIGenerated: false, source: "auto" as const }],
      sceneSettings: [{ id: "sc1", name: "场景A", description: "", isAIGenerated: false, source: "auto" as const }],
      videoGenerationPrefs: normalizeVideoGenerationPrefs({ mode: "text-to-video" }),
      shotPackets: [shotPacket("s1", 1), shotPacket("s2", 2)],
      videoPromptBatch: "",
      // 只有片段 1-1 有提示词，1-2 缺失
      segmentVideoPrompts: { "1-1": segPrompt("1-1") },
    };
    const plan = planVideoWorkflowContinuation(project);
    expect(plan.actionKind).toBe("create_video_bridge_artifact");
    expect(plan.policy).toBe("bridge-summary");
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
      characters: [{ id: "c1", name: "角色A", description: "", isAIGenerated: false, source: "auto" as const }],
      sceneSettings: [{ id: "sc1", name: "场景A", description: "", isAIGenerated: false, source: "auto" as const }],
      videoGenerationPrefs: normalizeVideoGenerationPrefs({ mode: "text-to-video" }),
      shotPackets: [shotPacket("s1", 1), shotPacket("s2", 2)],
      videoPromptBatch: "",
      segmentVideoPrompts: { "1-1": segPrompt("1-1"), "1-2": segPrompt("1-2") },
    };
    const plan = planVideoWorkflowContinuation(project);
    // 片段提示词全部完成，应推进到视频生成
    expect(plan.actionKind).toBe("generate_video_assets");
  });

  it("proceeds to video generation for text-to-video when videoPromptBatch is set", () => {
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
      characters: [{ id: "c1", name: "角色A", description: "", isAIGenerated: false, source: "auto" as const }],
      sceneSettings: [{ id: "sc1", name: "场景A", description: "", isAIGenerated: false, source: "auto" as const }],
      videoGenerationPrefs: normalizeVideoGenerationPrefs({ mode: "text-to-video" }),
      shotPackets: [shotPacket("s1", 1)],
      videoPromptBatch: "批次 1 / 镜头 1 / 1-1\n场景：镜头1",
      segmentVideoPrompts: {},
    };
    const plan = planVideoWorkflowContinuation(project);
    // 镜头提示词批次已设置，应推进到视频生成
    expect(plan.actionKind).toBe("generate_video_assets");
  });
});
