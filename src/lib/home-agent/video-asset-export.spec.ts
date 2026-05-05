import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import type { ProductionAssetManifest } from "@/types/project";
import {
  buildVideoAssetBundleExportSummary,
  exportVideoAssetBundle,
} from "./video-asset-export";

function createVideoProject(
  overrides: Partial<PersistedVideoProject> = {},
): PersistedVideoProject {
  return {
    id: "video-project-1",
    title: "雨夜追击预告片",
    script: "script",
    targetPlatform: "抖音",
    shotStyle: "电影感近景",
    outputGoal: "预告片",
    productionNotes: "",
    scenes: [],
    characters: [],
    sceneSettings: [],
    artStyle: "live-action",
    currentStep: 5,
    systemPrompt: "",
    analysisSummary: "",
    storyboardPlan: "",
    videoPromptBatch: "",
    sourceProjectId: "drama-1",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    styleLock: null,
    worldModel: null,
    assetManifest: null,
    shotPackets: [],
    reviewQueue: [],
    ...overrides,
  };
}

describe("video asset export", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("exports role, scene, storyboard, and video assets into the flattened archive structure", async () => {
    const selectFolder = vi.fn(async () => "E:/Exports");
    const copyFile = vi.fn(async () => ({ ok: true }));
    const readBase64 = vi.fn(async (filePath: string) => ({
      ok: true,
      exists: !filePath.includes("missing"),
      base64: "",
      mimeType: filePath.endsWith(".mp4") ? "video/mp4" : "image/jpeg",
    }));

    window.electronAPI = {
      storage: {
        selectFolder,
        copyFile,
        readBase64,
      },
    } as unknown as Window["electronAPI"];

    const project = createVideoProject({
      scenes: [
        {
          id: "scene-1",
          sceneNumber: 3,
          sceneName: "仙界断崖",
          description: "",
          characters: [],
          dialogue: "",
          cameraDirection: "",
          duration: 5,
          segmentLabel: "1-2",
        },
        {
          id: "scene-2",
          sceneNumber: 4,
          sceneName: "雨夜巷口",
          description: "",
          characters: [],
          dialogue: "",
          cameraDirection: "",
          duration: 5,
        },
      ],
    });

    const manifest: ProductionAssetManifest = {
      version: "manifest-1",
      summary: "summary",
      items: [
        {
          id: "image-character-1",
          kind: "character-reference",
          label: "角色·主角 参考#01",
          url: "C:/assets/hero.jpg",
          meta: "角色主参考",
          reusable: true,
          status: "ready",
          version: 1,
          createdAt: "2026-04-01T00:00:00.000Z",
        },
        {
          id: "image-scene-1",
          kind: "scene-reference",
          label: "场景·仙界-断崖",
          url: "C:/assets/cliff.png",
          meta: "场景参考",
          reusable: true,
          status: "ready",
          version: 1,
          createdAt: "2026-04-01T00:00:00.000Z",
        },
        {
          id: "image-storyboard-1",
          kind: "storyboard-frame",
          label: "分镜:镜头03 片段1-2 仙界断崖",
          url: "C:/assets/storyboard-03.jpg",
          meta: "分镜图",
          reusable: false,
          status: "ready",
          sceneId: "scene-1",
          sceneNumber: 3,
          version: 1,
          createdAt: "2026-04-01T00:00:00.000Z",
        },
        {
          id: "video-1",
          kind: "video-segment",
          label: "镜头03 片段1-2 成片01",
          url: "C:/assets/shot-1.mp4",
          meta: "completed",
          reusable: false,
          status: "needs-review",
          sceneId: "scene-1",
          sceneNumber: 3,
          version: 1,
          createdAt: "2026-04-01T00:00:00.000Z",
        },
        {
          id: "video-2",
          kind: "video-segment",
          label: "镜头04 未分段",
          url: "C:/assets/shot-missing.mp4",
          meta: "completed",
          reusable: false,
          status: "needs-review",
          sceneId: "scene-2",
          sceneNumber: 4,
          version: 1,
          createdAt: "2026-04-01T00:00:00.000Z",
        },
        {
          id: "image-remote",
          kind: "scene-reference",
          label: "远程场景",
          url: "https://example.com/scene.jpg",
          meta: "远程",
          reusable: true,
          status: "ready",
          version: 1,
          createdAt: "2026-04-01T00:00:00.000Z",
        },
      ],
    };

    const result = await exportVideoAssetBundle(project, manifest);

    expect(selectFolder).toHaveBeenCalledTimes(1);
    expect(copyFile).toHaveBeenCalledTimes(4);
    expect(copyFile).toHaveBeenNthCalledWith(
      1,
      "C:/assets/hero.jpg",
      "E:/Exports/雨夜追击预告片/图片/角色/角色_主角_参考_01.jpg",
    );
    expect(copyFile).toHaveBeenNthCalledWith(
      2,
      "C:/assets/cliff.png",
      "E:/Exports/雨夜追击预告片/图片/场景/场景_仙界_断崖.png",
    );
    expect(copyFile).toHaveBeenNthCalledWith(
      3,
      "C:/assets/storyboard-03.jpg",
      "E:/Exports/雨夜追击预告片/图片/第01集/分镜_镜头03_片段1_2_仙界断崖.jpg",
    );
    expect(copyFile).toHaveBeenNthCalledWith(
      4,
      "C:/assets/shot-1.mp4",
      "E:/Exports/雨夜追击预告片/视频/第01集/片段1_2/镜头03_片段1_2_成片01.mp4",
    );
    expect(result).toMatchObject({
      status: "success",
      directoryPath: "E:/Exports/雨夜追击预告片",
      exportedImageCount: 3,
      exportedVideoCount: 1,
      totalAssetCount: 6,
    });
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ assetId: "video-2", reason: "missing-file" }),
        expect.objectContaining({ assetId: "image-remote", reason: "remote-url" }),
      ]),
    );
  });

  it("falls back to 未分集 when the segment label cannot be parsed", async () => {
    const copyFile = vi.fn(async () => ({ ok: true }));
    window.electronAPI = {
      storage: {
        selectFolder: vi.fn(async () => "E:/Exports"),
        copyFile,
        readBase64: vi.fn(async () => ({ ok: true, exists: true, base64: "", mimeType: "image/jpeg" })),
      },
    } as unknown as Window["electronAPI"];

    const project = createVideoProject({
      scenes: [
        {
          id: "scene-x",
          sceneNumber: 7,
          sceneName: "未分组镜头",
          description: "",
          characters: [],
          dialogue: "",
          cameraDirection: "",
          duration: 5,
          segmentLabel: "片段A",
        },
      ],
    });

    await exportVideoAssetBundle(project, {
      version: "manifest-2",
      summary: "summary",
      items: [
        {
          id: "storyboard-x",
          kind: "storyboard-frame",
          label: "分镜·镜头07·片段A",
          url: "C:/assets/storyboard-x.jpg",
          meta: "分镜图",
          reusable: false,
          status: "ready",
          sceneId: "scene-x",
          sceneNumber: 7,
          version: 1,
          createdAt: "2026-04-01T00:00:00.000Z",
        },
      ],
    });

    expect(copyFile).toHaveBeenCalledWith(
      "C:/assets/storyboard-x.jpg",
      "E:/Exports/雨夜追击预告片/图片/未分集/分镜_镜头07_片段A.jpg",
    );
  });

  it("exports generated segment videos under the current episode segment folder", async () => {
    const copyFile = vi.fn(async () => ({ ok: true }));
    window.electronAPI = {
      storage: {
        selectFolder: vi.fn(async () => "E:/Exports"),
        copyFile,
        readBase64: vi.fn(async () => ({ ok: true, exists: true, base64: "", mimeType: "video/mp4" })),
      },
    } as unknown as Window["electronAPI"];

    const project = createVideoProject({
      scenes: [
        {
          id: "scene-1",
          sceneNumber: 1,
          sceneName: "雨夜追击",
          description: "",
          characters: [],
          dialogue: "",
          cameraDirection: "",
          duration: 5,
          segmentLabel: "1-1",
        },
        {
          id: "scene-2",
          sceneNumber: 2,
          sceneName: "雨夜反击",
          description: "",
          characters: [],
          dialogue: "",
          cameraDirection: "",
          duration: 5,
          segmentLabel: "1-2",
        },
      ],
      segmentVideos: {
        "1-2": "C:/assets/episode-1-segment-1-2.mp4",
      },
    });

    const result = await exportVideoAssetBundle(project, null);

    expect(copyFile).toHaveBeenCalledWith(
      "C:/assets/episode-1-segment-1-2.mp4",
      "E:/Exports/雨夜追击预告片/视频/第01集/第1集_片段/第1集_片段1_2.mp4",
    );
    expect(result).toMatchObject({
      status: "success",
      exportedImageCount: 0,
      exportedVideoCount: 1,
      totalAssetCount: 1,
    });
  });

  it("returns early when the user cancels folder selection", async () => {
    window.electronAPI = {
      storage: {
        selectFolder: vi.fn(async () => null),
        copyFile: vi.fn(),
      },
    } as unknown as Window["electronAPI"];

    const result = await exportVideoAssetBundle(createVideoProject(), {
      version: "manifest-3",
      summary: "summary",
      items: [
        {
          id: "image-1",
          kind: "character-reference",
          label: "主角参考01",
          url: "C:/assets/hero.jpg",
          meta: "角色主参考",
          reusable: true,
          status: "ready",
          version: 1,
          createdAt: "2026-04-01T00:00:00.000Z",
        },
      ],
    });

    expect(result.status).toBe("cancelled");
    expect(buildVideoAssetBundleExportSummary("雨夜追击预告片", result)).toContain("已取消导出");
  });

  it("strips a leading UI icon from the outer export folder name while preserving the title shape", async () => {
    const copyFile = vi.fn(async () => ({ ok: true }));
    window.electronAPI = {
      storage: {
        selectFolder: vi.fn(async () => "E:/Exports"),
        copyFile,
        readBase64: vi.fn(async () => ({ ok: true, exists: true, base64: "", mimeType: "image/jpeg" })),
      },
    } as unknown as Window["electronAPI"];

    const result = await exportVideoAssetBundle(
      createVideoProject({ title: "🎬 微短剧创作方案: 剑骨红衣/病娇王爷竟是潜伏仙尊 副本" }),
      {
        version: "manifest-4",
        summary: "summary",
        items: [
          {
            id: "image-1",
            kind: "character-reference",
            label: "主角参考01",
            url: "C:/assets/hero.jpg",
            meta: "角色主参考",
            reusable: true,
            status: "ready",
            version: 1,
            createdAt: "2026-04-01T00:00:00.000Z",
          },
        ],
      },
    );

    expect(copyFile).toHaveBeenCalledWith(
      "C:/assets/hero.jpg",
      "E:/Exports/微短剧创作方案： 剑骨红衣／病娇王爷竟是潜伏仙尊 副本/图片/角色/主角参考01.jpg",
    );
    expect(result.directoryPath).toBe("E:/Exports/微短剧创作方案： 剑骨红衣／病娇王爷竟是潜伏仙尊 副本");
  });
});
