import { beforeEach, describe, expect, it, vi } from "vitest";

const getProjectRootPath = vi.fn(async () => "D:\\StoryForgeFiles\\projects\\project-1");

vi.mock("@/lib/file-cache", () => ({
  getProjectRootPath,
}));

const { cacheProjectVideoSource } = await import("./video-cache");

describe("video cache", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    getProjectRootPath.mockResolvedValue("D:\\StoryForgeFiles\\projects\\project-1");
    global.fetch = vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["video"], { type: "video/mp4" }),
    })) as unknown as typeof fetch;
  });

  it("uses the semantic asset file name for cached generated videos", async () => {
    const writeFile = vi.fn(async () => ({ ok: true }));
    window.electronAPI = {
      jimeng: { writeFile },
      storage: {
        readBase64: vi.fn(async () => ({ ok: true, exists: false, base64: "" })),
      },
    } as unknown as Window["electronAPI"];

    const cached = await cacheProjectVideoSource(
      "https://example.com/generated-video.mp4",
      "镜头01_片段1-1_雨夜追击.mp4",
      "project-1",
    );

    expect(writeFile).toHaveBeenCalledWith(
      "D:\\StoryForgeFiles\\projects\\project-1\\media\\videos\\generated\\镜头01_片段1-1_雨夜追击.mp4",
      expect.any(String),
    );
    expect(cached?.localPath).toBe(
      "D:\\StoryForgeFiles\\projects\\project-1\\media\\videos\\generated\\镜头01_片段1-1_雨夜追击.mp4",
    );
  });

  it("adds a sequence suffix when the semantic file name already exists", async () => {
    const writeFile = vi.fn(async () => ({ ok: true }));
    const readBase64 = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, exists: true, base64: "" })
      .mockResolvedValueOnce({ ok: true, exists: false, base64: "" });
    window.electronAPI = {
      jimeng: { writeFile },
      storage: { readBase64 },
    } as unknown as Window["electronAPI"];

    await cacheProjectVideoSource(
      "https://example.com/generated-video-2.mp4",
      "镜头01_片段1-1_雨夜追击.mp4",
      "project-1",
    );

    expect(writeFile).toHaveBeenCalledWith(
      "D:\\StoryForgeFiles\\projects\\project-1\\media\\videos\\generated\\镜头01_片段1-1_雨夜追击_02.mp4",
      expect.any(String),
    );
  });
});
