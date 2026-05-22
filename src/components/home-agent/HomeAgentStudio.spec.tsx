import { describe, expect, it } from "vitest";
import type { ChatAttachment } from "@/lib/agent/chat-attachments";
import type { HomeAgentMessage } from "@/lib/home-agent/types";
import {
  HOMEPAGE_IDENTITY_GUIDANCE,
  buildVideoMediaMessageV2,
  findPendingMediaMessageIndex,
  hasSegmentContinuityGridForProject,
  markFailedMediaAttachmentsInMessage,
  mergeCompletedVideoAttachments,
  resolveModeIsolationAction,
  shouldAutoCleanupInvalidAsset,
} from "./HomeAgentStudio";

function createVideoAttachment(
  id: string,
  overrides: Partial<ChatAttachment> = {},
): ChatAttachment {
  return {
    id,
    fileName: `${id}.mp4`,
    mimeType: "video/mp4",
    size: 0,
    kind: "video",
    localPath: `file:///tmp/${id}.mp4`,
    previewUrl: `file:///tmp/${id}.mp4`,
    ...overrides,
  };
}

function createPendingVideoMessage(id: string, mediaEventId: string): HomeAgentMessage {
  return {
    id,
    role: "assistant",
    content: "pending video",
    createdAt: "2026-05-13T00:00:00.000Z",
    status: "pending",
    mediaEventId,
    attachments: [createVideoAttachment(`${id}-placeholder`, { pending: true })],
  };
}

describe("HomeAgentStudio video helpers", () => {
  it("anchors identity introductions to the InFinio product role before raw model details", () => {
    expect(HOMEPAGE_IDENTITY_GUIDANCE).toContain("InFinio");
    expect(HOMEPAGE_IDENTITY_GUIDANCE).toContain("一站式 AI 创作与视频生产工作台");
    expect(HOMEPAGE_IDENTITY_GUIDANCE).toContain("原创剧本、参考改编、视频工作流");
    expect(HOMEPAGE_IDENTITY_GUIDANCE).toContain("不要主动先报 Claude、Anthropic、模型 ID");
  });

  it("treats an existing continuity six-grid as the auto-backfill completion signal", () => {
    expect(
      hasSegmentContinuityGridForProject(
        {
          segmentContinuityGridImages: {
            "1-2": {
              imageUrl: "E:\\StoryForgeFiles\\projects\\video-project-1\\media\\images\\segment-continuity\\segment-1-2_continuity_grid.jpg",
              createdAt: "2026-05-19T00:00:00.000Z",
            },
          },
        },
        "1-2",
      ),
    ).toBe(true);
    expect(
      hasSegmentContinuityGridForProject(
        {
          segmentContinuityGridImages: {
            "1-2": {
              imageUrl: "   ",
              createdAt: "2026-05-19T00:00:00.000Z",
            },
          },
        },
        "1-2",
      ),
    ).toBe(false);
  });

  it("prefers the matching mediaEventId when locating a pending video batch", () => {
    const messages: HomeAgentMessage[] = [
      createPendingVideoMessage("message-1", "media:batch-1"),
      createPendingVideoMessage("message-2", "media:batch-2"),
    ];

    expect(findPendingMediaMessageIndex(messages, "video", "media:batch-1")).toBe(0);
    expect(findPendingMediaMessageIndex(messages, "video", "media:batch-2")).toBe(1);
  });

  it("merges final batch videos without dropping earlier per-item attachments", () => {
    const existingFirst = createVideoAttachment("existing-first", {
      fileName: "shot-1.mp4",
      localPath: "file:///tmp/shot-1.mp4",
      previewUrl: "file:///tmp/shot-1.mp4",
    });
    const existingThird = createVideoAttachment("existing-third", {
      fileName: "shot-3.mp4",
      localPath: "file:///tmp/shot-3.mp4",
      previewUrl: "file:///tmp/shot-3.mp4",
    });
    const pendingSecond = createVideoAttachment("pending-second", {
      pending: true,
      fileName: "pending-second.mp4",
      localPath: undefined,
      previewUrl: undefined,
    });

    const incomingFirst = createVideoAttachment("incoming-first", {
      fileName: "shot-1.mp4",
      localPath: "file:///tmp/shot-1.mp4",
      previewUrl: "file:///tmp/shot-1.mp4",
    });
    const incomingSecond = createVideoAttachment("incoming-second", {
      fileName: "shot-2.mp4",
      localPath: "file:///tmp/shot-2.mp4",
      previewUrl: "file:///tmp/shot-2.mp4",
    });
    const incomingThird = createVideoAttachment("incoming-third", {
      fileName: "shot-3.mp4",
      localPath: "file:///tmp/shot-3.mp4",
      previewUrl: "file:///tmp/shot-3.mp4",
    });

    const merged = mergeCompletedVideoAttachments(
      [existingFirst, pendingSecond, existingThird],
      [incomingFirst, incomingSecond, incomingThird],
    );

    expect(merged.map((attachment) => attachment.id)).toEqual([
      "existing-first",
      "incoming-second",
      "existing-third",
    ]);
  });

  it("dedupes the same completed video even when the batch summary uses a different file name", () => {
    const existingDetailed = createVideoAttachment("existing-detailed", {
      fileName: "第1集·片段1-1.mp4",
      label: "第1集·片段1-1",
      localPath: "E:\\StoryForgeFiles\\projects\\video-project-1\\media\\videos\\generated\\segment-1-1.mp4",
      previewUrl: "file:///E:/StoryForgeFiles/projects/video-project-1/media/videos/generated/segment-1-1.mp4",
      generationContext: {
        action: "generate_segment_video",
        projectId: "video-project-1",
        targetId: "1-1",
        regenerateMode: "redo-and-generate",
      },
    });
    const incomingSummary = createVideoAttachment("incoming-summary", {
      fileName: "片段1-1.mp4",
      label: "片段1-1",
      localPath: "E:\\StoryForgeFiles\\projects\\video-project-1\\media\\videos\\generated\\segment-1-1.mp4",
      previewUrl: "file:///E:/StoryForgeFiles/projects/video-project-1/media/videos/generated/segment-1-1.mp4",
    });

    const merged = mergeCompletedVideoAttachments(
      [existingDetailed],
      [incomingSummary],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("existing-detailed");
    expect(merged[0]?.fileName).toBe("第1集·片段1-1.mp4");
    expect(merged[0]?.generationContext?.targetId).toBe("1-1");
  });

  it("uses the route hint as the second line while video generation is starting", () => {
    const copy = buildVideoMediaMessageV2({
      count: 1,
      mode: "image-to-video",
      provider: "jimeng",
      contentSummary: "镜头 1 · 雨夜追击",
      routeHint: "多图参考图生",
    });

    expect(copy.start).toContain("多图参考图生");
    expect(copy.done).not.toContain("多图参考图生");
    expect(copy.done).toContain("模式 图生视频");
  });
  it("replaces a pending placeholder with a failed but previewable video attachment", () => {
    const message = createPendingVideoMessage("message-1", "media:failed-1");

    const nextMessage = markFailedMediaAttachmentsInMessage(message, {
      kind: "video",
      failureReason: "QA rejected this cut for continuity drift.",
      attachmentOverrides: {
        fileName: "segment-1-2-failed.mp4",
        previewUrl: "file:///E:/library/segment-1-2-failed.mp4",
        localPath: "E:\\library\\segment-1-2-failed.mp4",
        generationContext: {
          action: "generate_segment_video",
          projectId: "video-project-1",
          targetId: "1-2",
          regenerateMode: "redo-and-generate",
        },
      },
    });

    expect(nextMessage.attachments?.[0]).toMatchObject({
      pending: false,
      failed: true,
      failureReason: "QA rejected this cut for continuity drift.",
      fileName: "segment-1-2-failed.mp4",
      previewUrl: "file:///E:/library/segment-1-2-failed.mp4",
      localPath: "E:\\library\\segment-1-2-failed.mp4",
      generationContext: {
        action: "generate_segment_video",
        projectId: "video-project-1",
        targetId: "1-2",
        regenerateMode: "redo-and-generate",
      },
    });
    expect(nextMessage.status).toBe("complete");
  });

  it("only auto-cleans manual assets and video segments", () => {
    expect(
      shouldAutoCleanupInvalidAsset({
        kind: "character-reference",
        origin: "derived",
      }),
    ).toBe(false);
    expect(
      shouldAutoCleanupInvalidAsset({
        kind: "storyboard-frame",
        origin: "derived",
      }),
    ).toBe(false);
    expect(
      shouldAutoCleanupInvalidAsset({
        kind: "video-segment",
        origin: "derived",
      }),
    ).toBe(true);
    expect(
      shouldAutoCleanupInvalidAsset({
        kind: "scene-reference",
        origin: "manual",
      }),
    ).toBe(false);
  });
});

describe("resolveModeIsolationAction", () => {
  it("opens the remembered target-mode project when the target project differs from the current one", () => {
    expect(
      resolveModeIsolationAction({
        currentSnapshot: {
          projectId: "manual-project-1",
          automationMode: "manual",
        },
        targetMode: "full-auto",
        nextProjectId: "full-auto-project-1",
        activeProjectId: "manual-project-1",
        hasMessages: true,
        hasDraft: true,
        mode: "active",
      }),
    ).toEqual({
      type: "open-project",
      projectId: "full-auto-project-1",
    });
  });

  it("resets to a blank home surface when the target mode points at the same project shell", () => {
    expect(
      resolveModeIsolationAction({
        currentSnapshot: {
          projectId: "shared-project",
          automationMode: "manual",
        },
        targetMode: "full-auto",
        nextProjectId: "shared-project",
        activeProjectId: "shared-project",
        hasMessages: true,
        hasDraft: false,
        mode: "active",
      }),
    ).toEqual({
      type: "reset-home",
    });
  });

  it("only flips the active mode when the home surface is already blank", () => {
    expect(
      resolveModeIsolationAction({
        currentSnapshot: null,
        targetMode: "full-auto",
        nextProjectId: null,
        activeProjectId: null,
        hasMessages: false,
        hasDraft: false,
        mode: "idle",
      }),
    ).toEqual({
      type: "activate-mode-only",
    });
  });
});
