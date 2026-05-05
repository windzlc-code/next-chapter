import { beforeEach, describe, expect, it, vi } from "vitest";

const getResolvedFilesStoragePath = vi.fn(async () => "D:/files");
const getInlineData = vi.fn();

vi.mock("@/lib/storage-path", () => ({
  getResolvedFilesStoragePath,
}));

vi.mock("@/lib/gemini-client", () => ({
  getInlineData,
}));

const {
  dreaminaCliCancelVideo,
  dreaminaCliGenerateVideo,
  dreaminaCliGetStatus,
  dreaminaCliLogin,
  dreaminaCliQueryResult,
  dreaminaCliRelogin,
  getDreaminaCliModelCatalog,
} = await import("./dreamina-cli");

type ElectronApi = NonNullable<Window["electronAPI"]>;

function getElectronApi(): ElectronApi {
  return window.electronAPI as ElectronApi;
}

describe("dreamina-cli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.electronAPI = {
      dreaminaCli: {
        exec: vi.fn(),
      },
      jimeng: {
        writeFile: vi.fn(async () => ({ ok: true })),
      },
      storage: {
        getDefaultPath: vi.fn(async () => ({ files: "D:/files", db: "D:/db" })),
      },
    };
  });

  it("reads local login status through the official CLI", async () => {
    vi.mocked(getElectronApi().dreaminaCli!.exec).mockResolvedValue({
      ok: true,
      installed: true,
      stdout: '{"credit":120}',
      path: "C:/Users/test/bin/dreamina.exe",
    });

    const result = await dreaminaCliGetStatus();

    expect(result.ok).toBe(true);
    expect(result.loggedIn).toBe(true);
    expect(result.path).toContain("dreamina");
  });

  it("submits text-to-video through the official CLI", async () => {
    vi.mocked(getElectronApi().dreaminaCli!.exec).mockResolvedValue({
      ok: true,
      installed: true,
      stdout: '{"submit_id":"task-seedance-20","gen_status":"submitted"}',
    });

    const result = await dreaminaCliGenerateVideo({
      prompt: "a cinematic rainy alley chase",
      duration: 5,
      aspectRatio: "9:16",
    });

    expect(result.task_id).toBe("task-seedance-20");
    expect(getElectronApi().dreaminaCli!.exec).toHaveBeenCalledWith(
      expect.arrayContaining([
        "text2video",
        "--model_version=seedance2.0fast",
        "--video_resolution=720p",
        "--ratio=9:16",
      ]),
      undefined,
    );
  });

  it("starts the official browser login flow", async () => {
    vi.mocked(getElectronApi().dreaminaCli!.exec).mockResolvedValue({
      ok: true,
      installed: true,
      stdout: "",
      path: "C:/Users/test/bin/dreamina.exe",
    });

    const result = await dreaminaCliLogin();

    expect(result.ok).toBe(true);
    expect(result.message).toContain("浏览器登录流程已启动");
    expect(getElectronApi().dreaminaCli!.exec).toHaveBeenCalledWith(["login"], undefined);
  });

  it("starts the official relogin flow", async () => {
    vi.mocked(getElectronApi().dreaminaCli!.exec).mockResolvedValue({
      ok: true,
      installed: true,
      stdout: "relogin started",
      path: "C:/Users/test/bin/dreamina.exe",
    });

    const result = await dreaminaCliRelogin();

    expect(result.ok).toBe(true);
    expect(result.message).toContain("relogin started");
    expect(getElectronApi().dreaminaCli!.exec).toHaveBeenCalledWith(["relogin"], undefined);
  });

  it("submits image-to-video through the official CLI when a first frame exists", async () => {
    getInlineData.mockResolvedValue({
      mimeType: "image/png",
      data: "ZmFrZS1pbWFnZS1iYXNlNjQ=",
    });
    vi.mocked(getElectronApi().dreaminaCli!.exec).mockResolvedValue({
      ok: true,
      installed: true,
      stdout: '{"submit_id":"task-image-20","gen_status":"submitted"}',
    });

    const result = await dreaminaCliGenerateVideo({
      prompt: "push in on the heroine",
      imageUrl: "https://example.com/frame.png",
      duration: 6,
    });

    expect(result.task_id).toBe("task-image-20");
    expect(getElectronApi().jimeng!.writeFile).toHaveBeenCalled();
    expect(getElectronApi().dreaminaCli!.exec).toHaveBeenCalledWith(
      expect.arrayContaining([
        "image2video",
        "--model_version=seedance2.0",
        "--video_resolution=720p",
      ]),
      undefined,
    );
  });

  it("parses query_result output into app status shape", async () => {
    vi.mocked(getElectronApi().dreaminaCli!.exec).mockResolvedValue({
      ok: true,
      installed: true,
      stdout: '{"gen_status":"success","result":{"video_url":"https://example.com/video.mp4"}}',
    });

    const result = await dreaminaCliQueryResult("task-123");

    expect(result.status).toBe("succeeded");
    expect(result.video_url).toBe("https://example.com/video.mp4");
  });

  it("sends cancel to the official CLI for submitted video tasks", async () => {
    vi.mocked(getElectronApi().dreaminaCli!.exec).mockResolvedValue({
      ok: true,
      installed: true,
      stdout: '{"submit_id":"task-123","gen_status":"cancelled"}',
    });

    const result = await dreaminaCliCancelVideo("task-123");

    expect(result).toEqual({
      task_id: "task-123",
      status: "cancelled",
      provider: "dreamina-cli",
    });
    expect(getElectronApi().dreaminaCli!.exec).toHaveBeenCalledWith(
      ["cancel", "--submit_id=task-123"],
      undefined,
    );
  });

  it("exposes Seedance 2.0 variants in the local catalog", () => {
    const catalog = getDreaminaCliModelCatalog();

    expect(catalog.map((item) => item.id)).toEqual(["seedance2.0", "seedance2.0fast"]);
  });
});
