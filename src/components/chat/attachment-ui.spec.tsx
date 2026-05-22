import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "@/lib/agent/chat-attachments";
import { DraftAttachmentList, MessageAttachmentList } from "./attachment-ui";

describe("MessageAttachmentList", () => {
  it("renders an inline audio player for attached draft audio files", () => {
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(() => "blob:voice-reference.wav"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });

    try {
      const { container } = render(
        <DraftAttachmentList
          files={[new File(["audio"], "voice-reference.wav", { type: "audio/wav" })]}
          activeTheme
          collapsed={false}
          onToggleCollapsed={vi.fn()}
          onRemove={vi.fn()}
        />,
      );

      expect(container.querySelector('audio[src="blob:voice-reference.wav"]')).toBeTruthy();
      const draftAudioCard = screen.getByText("voice-reference.wav").closest("div[class*='rounded-[18px]']");
      expect(draftAudioCard?.className).toContain("w-full");
      expect(draftAudioCard?.className).not.toContain("self-start");
    } finally {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        writable: true,
        value: originalCreateObjectUrl,
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        writable: true,
        value: originalRevokeObjectUrl,
      });
    }
  });

  it("renders an inline audio player for audio message attachments", () => {
    const attachments: ChatAttachment[] = [
      {
        id: "audio-1",
        fileName: "voice-reference.wav",
        mimeType: "audio/wav",
        size: 4096,
        kind: "binary",
        localPath: "D:\\voices\\voice-reference.wav",
      },
    ];

    const { container } = render(<MessageAttachmentList attachments={attachments} />);

    expect(container.querySelector("audio")).toBeTruthy();
    expect(container.querySelector('source[src="file:///D:/voices/voice-reference.wav"]')).toBeTruthy();
    const messageAudioCard = screen.getByText("voice-reference.wav").closest("div[class*='self-start']");
    expect(messageAudioCard?.className).toContain("self-start");
    expect(messageAudioCard?.className).toContain("w-[min(34rem,100%)]");
    expect(messageAudioCard?.className.split(/\s+/)).not.toContain("w-full");
  });

  it("switches image attachments between historical versions", () => {
    const attachments: ChatAttachment[] = [
      {
        id: "image-1",
        fileName: "latest-image.png",
        mimeType: "image/png",
        size: 0,
        kind: "image",
        previewUrl: "https://example.com/latest-image.png",
        history: [
          {
            id: "image-1-v1",
            fileName: "older-image.png",
            previewUrl: "https://example.com/older-image.png",
            createdAt: "2026-04-27T00:00:00.000Z",
          },
          {
            id: "image-1-v2",
            fileName: "latest-image.png",
            previewUrl: "https://example.com/latest-image.png",
            createdAt: "2026-04-27T00:01:00.000Z",
          },
        ],
      },
    ];

    const { container } = render(<MessageAttachmentList attachments={attachments} />);

    const preview = container.querySelector('img[src="https://example.com/latest-image.png"]');
    expect(preview).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "查看上一个版本" }));

    expect(container.querySelector('img[src="https://example.com/older-image.png"]')).toBeTruthy();
  });

  it("opens video attachments in the preview lightbox", () => {
    const attachments: ChatAttachment[] = [
      {
        id: "video-1",
        fileName: "generated-video.mp4",
        mimeType: "video/mp4",
        size: 0,
        kind: "video",
        previewUrl: "https://example.com/generated-video.mp4",
      },
    ];

    render(<MessageAttachmentList attachments={attachments} />);

    fireEvent.click(screen.getByRole("button", { name: /generated-video\.mp4/ }));

    const video = document.querySelector("video[controls]");
    expect(video).toBeTruthy();
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("playsinline");
    expect(document.querySelector('source[src="https://example.com/generated-video.mp4"]')).toBeTruthy();
  });

  it("opens the selected historical video version in the preview lightbox", () => {
    const attachments: ChatAttachment[] = [
      {
        id: "video-1",
        fileName: "latest-video.mp4",
        mimeType: "video/mp4",
        size: 0,
        kind: "video",
        previewUrl: "https://example.com/latest-video.mp4",
        history: [
          {
            id: "video-1-v1",
            fileName: "older-video.mp4",
            previewUrl: "https://example.com/older-video.mp4",
            createdAt: "2026-04-27T00:00:00.000Z",
          },
          {
            id: "video-1-v2",
            fileName: "latest-video.mp4",
            previewUrl: "https://example.com/latest-video.mp4",
            createdAt: "2026-04-27T00:01:00.000Z",
          },
        ],
      },
    ];

    render(<MessageAttachmentList attachments={attachments} />);

    fireEvent.click(screen.getByRole("button", { name: "查看上一个版本" }));
    fireEvent.click(screen.getByRole("button", { name: /latest-video\.mp4/ }));

    expect(document.querySelector('source[src="https://example.com/older-video.mp4"]')).toBeTruthy();
  });

  it("keeps failed videos previewable with a grey-filtered card", () => {
    const attachments: ChatAttachment[] = [
      {
        id: "video-failed-1",
        fileName: "qa-failed-video.mp4",
        mimeType: "video/mp4",
        size: 0,
        kind: "video",
        previewUrl: "https://example.com/qa-failed-video.mp4",
        failed: true,
        failureReason: "QA rejected this cut for continuity drift.",
      },
    ];

    const { container } = render(<MessageAttachmentList attachments={attachments} />);

    expect(screen.getByText("QA 未通过")).toBeTruthy();
    expect(screen.getByText("QA rejected this cut for continuity drift.")).toBeTruthy();
    expect(container.querySelector(".grayscale")).toBeTruthy();
    expect(container.querySelector("[draggable]")).toHaveAttribute("draggable", "false");

    fireEvent.click(screen.getByRole("button", { name: /qa-failed-video\.mp4/ }));

    expect(document.querySelector("video[controls]")).toBeTruthy();
    expect(document.querySelector('source[src="https://example.com/qa-failed-video.mp4"]')).toBeTruthy();
  });

  it("reveals local video attachments in the system file manager", () => {
    const openPath = vi.fn(async () => "");
    window.electronAPI = {
      storage: {
        openPath,
      },
    } as unknown as typeof window.electronAPI;

    const attachments: ChatAttachment[] = [
      {
        id: "video-1",
        fileName: "generated-video.mp4",
        mimeType: "video/mp4",
        size: 0,
        kind: "video",
        localPath: "D:\\StoryForgeFiles\\projects\\video-project-1\\media\\videos\\generated\\generated-video.mp4",
        previewUrl: "file:///D:/StoryForgeFiles/projects/video-project-1/media/videos/generated/generated-video.mp4",
      },
    ];

    render(<MessageAttachmentList attachments={attachments} />);

    fireEvent.click(screen.getByRole("button", { name: "定位本地文件" }));

    expect(openPath).toHaveBeenCalledWith(
      "D:\\StoryForgeFiles\\projects\\video-project-1\\media\\videos\\generated\\generated-video.mp4",
    );
  });

  it("allows dragging when a historical video version is selected", () => {
    const attachments: ChatAttachment[] = [
      {
        id: "video-1",
        fileName: "latest-video.mp4",
        mimeType: "video/mp4",
        size: 0,
        kind: "video",
        previewUrl: "https://example.com/latest-video.mp4",
        history: [
          {
            id: "video-1-v1",
            fileName: "older-video.mp4",
            previewUrl: "https://example.com/older-video.mp4",
            createdAt: "2026-04-27T00:00:00.000Z",
          },
          {
            id: "video-1-v2",
            fileName: "latest-video.mp4",
            previewUrl: "https://example.com/latest-video.mp4",
            createdAt: "2026-04-27T00:01:00.000Z",
          },
        ],
      },
    ];

    const { container } = render(<MessageAttachmentList attachments={attachments} />);

    const previousVersionButton = container.querySelector("button[aria-label]");
    expect(previousVersionButton).toBeTruthy();
    fireEvent.click(previousVersionButton!);

    const historicalPreview = container.querySelector('video[src="https://example.com/older-video.mp4"]');
    expect(historicalPreview?.closest("[draggable]")).toHaveAttribute("draggable", "true");
  });

  it("shows an inline warning and disables preview for expired signed images", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-28T00:00:00.000Z"));

    const attachments: ChatAttachment[] = [
      {
        id: "image-1",
        fileName: "expired-image.png",
        mimeType: "image/png",
        size: 0,
        kind: "image",
        previewUrl:
          "https://example.com/expired-image.png?X-Tos-Date=20260425T161753Z&X-Tos-Expires=86400",
      },
    ];

    const { container } = render(<MessageAttachmentList attachments={attachments} />);

    expect(screen.getByText(/已过期|无权限访问|请重新生成/)).toBeTruthy();
    expect(container.querySelector("[draggable]")).toHaveAttribute("draggable", "false");
    expect(screen.queryByRole("button", { name: /expired-image\.png/ })).toBeNull();
    fireEvent.click(screen.getByText(/已过期|无权限访问|请重新生成/));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container.querySelector('img[src*="expired-image.png"]')).toBeNull();

    vi.useRealTimers();
  });

  it("keeps an image slot reserved while the generated URL is not ready", () => {
    const attachments: ChatAttachment[] = [
      {
        id: "image-1",
        fileName: "queued-image.png",
        mimeType: "image/png",
        size: 0,
        kind: "image",
        aspectRatio: "9:16",
      },
    ];

    const { container } = render(<MessageAttachmentList attachments={attachments} />);

    expect(screen.getByText("queued-image")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(
      Array.from(container.querySelectorAll<HTMLElement>("[style]")).some(
        (element) => element.getAttribute("style")?.includes("--media-aspect-ratio: 9 / 16"),
      ),
    ).toBe(true);
    expect(container.querySelector(".h-10")).toBeTruthy();
  });

  it("shows an inline warning and disables preview for expired signed videos", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-28T00:00:00.000Z"));

    const attachments: ChatAttachment[] = [
      {
        id: "video-1",
        fileName: "expired-video.mp4",
        mimeType: "video/mp4",
        size: 0,
        kind: "video",
        previewUrl:
          "https://example.com/expired-video.mp4?X-Tos-Date=20260425T161753Z&X-Tos-Expires=86400",
      },
    ];

    const { container } = render(<MessageAttachmentList attachments={attachments} />);

    expect(screen.getByText(/已过期|无权限访问|请重新生成/)).toBeTruthy();
    expect(container.querySelector("[draggable]")).toHaveAttribute("draggable", "false");
    expect(screen.queryByRole("button", { name: /expired-video\.mp4/ })).toBeNull();
    fireEvent.click(screen.getByText(/已过期|无权限访问|请重新生成/));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector("video[controls]")).toBeNull();

    vi.useRealTimers();
  });

  it("shows an inline warning and disables preview for missing local videos", () => {
    window.electronAPI = {
      storage: {
        exists: vi.fn(() => false),
      },
    } as unknown as typeof window.electronAPI;

    const attachments: ChatAttachment[] = [
      {
        id: "video-1",
        fileName: "missing-video.mp4",
        mimeType: "video/mp4",
        size: 0,
        kind: "video",
        localPath: "E:\\missing\\missing-video.mp4",
        previewUrl: "file:///E:/missing/missing-video.mp4",
      },
    ];

    const { container } = render(<MessageAttachmentList attachments={attachments} />);

    expect(screen.getByText(/文件不存在|已被删除|已被移动|请重新生成/)).toBeTruthy();
    expect(container.querySelector("[draggable]")).toHaveAttribute("draggable", "false");
    expect(screen.queryByRole("button", { name: /missing-video\.mp4/ })).toBeNull();
    expect(container.querySelector('video[src*="missing-video.mp4"]')).toBeNull();
    expect(document.querySelector("video[controls]")).toBeNull();
  });
});
