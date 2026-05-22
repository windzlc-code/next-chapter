import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedVideoProject } from "@/hooks/use-local-persistence";

const getResolvedFilesStoragePath = vi.fn(async () => "D:/StoryForgeFiles");

vi.mock("@/lib/storage-path", () => ({
  getResolvedFilesStoragePath,
}));

const {
  buildVideoProductionBundlePreviewMessage,
  exportVideoProductionBundle,
} = await import("./production-state-export");

function createProject(overrides: Partial<PersistedVideoProject> = {}): PersistedVideoProject {
  return {
    id: "video-project-export-1",
    title: "长片续拍测试",
    script: "主角在仓库中与追兵对峙。",
    targetPlatform: "抖音",
    shotStyle: "电影感",
    outputGoal: "长片连续片段",
    productionNotes: "",
    scenes: [
      {
        id: "scene-1",
        sceneNumber: 1,
        sceneName: "仓库入口",
        description: "主角冲入仓库。",
        characters: ["主角"],
        dialogue: "",
        cameraDirection: "跟拍",
        duration: 6,
        segmentLabel: "1-1",
        storyboardUrl: "https://media.storyforge.test/storyboard-1.jpg",
      },
    ],
    characters: [
      {
        id: "char-1",
        name: "主角",
        description: "深色外套，神情紧绷",
        imageUrl: "https://media.storyforge.test/char-1.jpg",
        isAIGenerated: false,
        source: "auto",
      },
    ],
    sceneSettings: [
      {
        id: "setting-1",
        name: "仓库",
        description: "冷色工业仓库",
        imageUrl: "",
        isAIGenerated: false,
        source: "auto",
      },
    ],
    artStyle: "live-action",
    currentStep: 4,
    systemPrompt: "",
    analysisSummary: "已进入自动长片生产链路。",
    storyboardPlan: "",
    videoPromptBatch: "",
    styleLock: null,
    worldModel: null,
    assetManifest: null,
    shotPackets: [
      {
        id: "packet:scene-1",
        sceneId: "scene-1",
        sceneNumber: 1,
        title: "仓库入口",
        durationSec: 6,
        camera: { shotSize: "中景", movement: "跟拍" },
        characterRefs: [],
        sourceAssetIds: [],
        promptSeed: "主角冲入仓库。",
        forbiddenChanges: [],
        renderMode: "img2video",
      },
    ],
    segmentVideoPrompts: {},
    videoAuditPackets: [
      {
        id: "audit:segment:1-1",
        targetType: "segment",
        targetId: "segment:1-1",
        segmentLabel: "1-1",
        sceneIds: ["scene-1"],
        submittedPrompt: "分镜1（0-6秒）：主角冲入仓库。\n\n通用后缀： 无字幕、无水印、无屏幕文字",
        referenceImageUrls: ["https://media.storyforge.test/storyboard-1.jpg"],
        usedContinuityFrame: false,
        usedRelayVideo: false,
        symbolicPassed: true,
        totalScore: 88,
        status: "pass",
        scores: {
          continuity: { score: 88, passed: true, reason: "ok" },
          identity: { score: 90, passed: true, reason: "ok" },
          semantic: { score: 85, passed: true, reason: "ok" },
          visual: { score: 89, passed: true, reason: "ok" },
        },
        issues: [],
        createdAt: "2026-04-03T00:00:00.000Z",
        updatedAt: "2026-04-03T00:00:00.000Z",
      },
    ],
    videoRepairTasks: [
      {
        id: "repair:segment:1-1",
        targetType: "segment",
        targetId: "segment:1-1",
        segmentLabel: "1-1",
        route: "local_repair",
        status: "completed",
        reason: "历史修复记录",
        attempts: 1,
        createdAt: "2026-04-03T00:00:00.000Z",
        updatedAt: "2026-04-03T00:10:00.000Z",
      },
    ],
    automationState: {
      strategy: "quality-first",
      segmentPassBudget: 5,
      localRepairBudget: 2,
      regenerateBudget: 2,
      assetPrimaryRetryBudget: 3,
      assetVariantRetryBudget: 2,
      segments: {
        "1-1": {
          totalPasses: 1,
          localRepairCount: 1,
          regenerateCount: 0,
        },
      },
      referenceTargets: {
        "reference-character:char-1": {
          targetId: "reference-character:char-1",
          targetType: "character-primary",
          entityId: "char-1",
          status: "ready",
          attemptCount: 1,
          retryBudget: 3,
        },
        "reference-scene:setting-1": {
          targetId: "reference-scene:setting-1",
          targetType: "scene-primary",
          entityId: "setting-1",
          status: "exhausted",
          attemptCount: 3,
          retryBudget: 3,
          lastError: "provider timeout",
        },
      },
      updatedAt: "2026-04-03T00:10:00.000Z",
    },
    reviewQueue: [
      {
        id: "review:segment:1-1",
        title: "片段 1-1",
        summary: "仅作导出校验",
        targetIds: ["segment:1-1"],
        status: "pending",
        createdAt: "2026-04-03T00:00:00.000Z",
        updatedAt: "2026-04-03T00:10:00.000Z",
      },
    ],
    productionStateBundle: null,
    sourceProjectId: "script-1",
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:10:00.000Z",
    ...overrides,
  };
}

describe("production-state-export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as typeof window & {
      electronAPI?: {
        storage?: {
          writeText?: ReturnType<typeof vi.fn>;
        };
      };
    }).electronAPI = {
      storage: {
        writeText: vi.fn(async () => ({ ok: true })),
      },
    };
  });

  it("includes audit, repair, and automation counts in the preview message", () => {
    const preview = buildVideoProductionBundlePreviewMessage(createProject());

    expect(preview).toContain("QA 审核：1 个");
    expect(preview).toContain("Repair 记录：1 个");
    expect(preview).toContain("Review Queue：1 个");
    expect(preview).toContain("Automation Targets：2 个");
    expect(preview).toContain("Exhausted Automation Targets：1 个");
    expect(preview).toContain("automation-state");
  });

  it("exports automation, audit, repair, and review files with the bundle", async () => {
    const project = createProject();
    const writeText = window.electronAPI?.storage?.writeText as ReturnType<typeof vi.fn>;

    const result = await exportVideoProductionBundle(project);

    expect(getResolvedFilesStoragePath).toHaveBeenCalled();
    expect(result.exportedCount).toBe(10);
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("/automation-state.json"),
      expect.stringContaining("\"referenceTargets\""),
    );
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("/video-audits.json"),
      expect.stringContaining("\"targetType\": \"segment\""),
    );
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("/video-repair-tasks.json"),
      expect.stringContaining("\"route\": \"local_repair\""),
    );
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("/review-queue.json"),
      expect.stringContaining("\"targetIds\""),
    );
  });
});
