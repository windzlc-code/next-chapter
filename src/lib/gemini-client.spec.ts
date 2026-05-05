import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-config", () => ({
  getApiConfig: () => ({
    geminiEndpoint: "https://api.tu-zi.com/v1beta",
    geminiKey: "test-gemini-key",
    gptEndpoint: "https://api.tu-zi.com/v1",
    gptKey: "test-gpt-key",
    tuziEndpoint: "https://api.tuziapi.com",
    tuziKey: "test-tuzi-key",
  }),
  resolveConfiguredModelName: (model: string) => model,
}));

vi.mock("@/lib/network-retry-settings", () => ({
  getNetworkRetrySettings: () => ({ maxRetries: 0, delayMs: 0 }),
}));

vi.mock("@/lib/upload-base64-to-storage", () => ({
  buildThumbnailRelativePath: vi.fn(),
  persistAssetToProjectCache: vi.fn(),
}));

import {
  AsyncImageTaskPendingError,
  callAsyncImageGeneration,
  callTuziImageGeneration,
  fetchImageAsBase64,
  getProgressiveAsyncImagePollIntervalMs,
  isAsyncImageTaskPendingError,
  pollAsyncImageResult,
} from "@/lib/gemini-client";

describe("gemini async image transport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    window.electronAPI = undefined;
  });

  it("uses the requested progressive polling cadence", () => {
    expect(getProgressiveAsyncImagePollIntervalMs(0)).toBe(1000);
    expect(getProgressiveAsyncImagePollIntervalMs(4_999)).toBe(1000);
    expect(getProgressiveAsyncImagePollIntervalMs(5_000)).toBe(2000);
    expect(getProgressiveAsyncImagePollIntervalMs(14_999)).toBe(2000);
    expect(getProgressiveAsyncImagePollIntervalMs(15_000)).toBe(5000);
    expect(getProgressiveAsyncImagePollIntervalMs(240_000)).toBe(5000);
  });

  it("submits production nano banana 2 images to /v1/images/generations", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ b64_json: "AQID", mime_type: "image/png" }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await callTuziImageGeneration("draw a small robot", {
      model: "gemini-3-pro-image-preview",
      size: "1536x1024",
    });

    expect(result).toEqual({ base64: "AQID", mimeType: "image/png" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const submitCall = fetchSpy.mock.calls[0];
    expect(submitCall?.[0]).toBe("https://api.tu-zi.com/v1/images/generations");

    const submitInit = submitCall?.[1] as RequestInit;
    expect(submitInit.method).toBe("POST");
    expect(submitInit.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer test-gemini-key",
        "Content-Type": "application/json",
      }),
    );
    expect(JSON.parse(String(submitInit.body))).toEqual({
      model: "gemini-3-pro-image-preview",
      prompt: "draw a small robot",
      n: 1,
      size: "1536x1024",
    });
  });

  it("routes gpt-image-2 image generation through the GPT endpoint and key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ b64_json: "AQID", mime_type: "image/png" }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    const consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const result = await callTuziImageGeneration("paint a lantern-lit alley", {
      model: "gpt-image-2",
      size: "1024x1024",
    });

    expect(result).toEqual({ base64: "AQID", mimeType: "image/png" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://api.tu-zi.com/v1/images/generations");

    const submitInit = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(submitInit.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer test-gpt-key",
        "Content-Type": "application/json",
      }),
    );
    expect(JSON.parse(String(submitInit.body))).toEqual({
      model: "gpt-image-2",
      prompt: "paint a lantern-lit alley",
      n: 1,
      size: "1024x1024",
    });
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      "[image-generation] submitting /v1/images/generations",
      expect.objectContaining({
        model: "gpt-image-2",
        service: "gpt",
      }),
    );
  });

  it("loads local file references through Electron before submitting image generation", async () => {
    const readBase64 = vi.fn().mockResolvedValue({
      ok: true,
      exists: true,
      base64: "LOCAL_IMAGE",
      mimeType: "image/jpeg",
    });
    window.electronAPI = {
      storage: {
        readBase64,
      },
    } as unknown as Window["electronAPI"];

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ b64_json: "AQID", mime_type: "image/png" }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await callTuziImageGeneration("use the local reference", {
      model: "gemini-3-pro-image-preview",
      input_reference:
        "file:///E:/Other/work/next-chapter_0.4.3_01/files/projects/project-1/images/generated/storyboards/frame.jpg",
    });

    expect(result).toEqual({ base64: "AQID", mimeType: "image/png" });
    expect(readBase64).toHaveBeenCalledWith(
      "E:/Other/work/next-chapter_0.4.3_01/files/projects/project-1/images/generated/storyboards/frame.jpg",
    );

    const submitInit = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(submitInit.body))).toEqual(
      expect.objectContaining({
        image: ["data:image/jpeg;base64,LOCAL_IMAGE"],
      }),
    );
  });

  it("does not browser-fetch file URLs when converting images to base64", async () => {
    const readBase64 = vi.fn().mockResolvedValue({
      ok: true,
      exists: true,
      base64: "LOCAL_IMAGE",
      mimeType: "image/png",
    });
    window.electronAPI = {
      storage: {
        readBase64,
      },
    } as unknown as Window["electronAPI"];
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await fetchImageAsBase64("file:///E:/workspace/frame.png");

    expect(result).toEqual({ data: "LOCAL_IMAGE", mimeType: "image/png" });
    expect(readBase64).toHaveBeenCalledWith("E:/workspace/frame.png");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("submits async image tasks to /v1/videos and uploads reference images", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(Uint8Array.from([1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ task_id: "task-123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const result = await callAsyncImageGeneration("draw a mountain", {
      model: "gemini-3-pro-image-preview-2k-async",
      size: "16:9",
      input_reference: "https://example.com/reference.png",
    });

    expect(result).toEqual({
      task_id: "task-123",
      fallbackModel: "gemini-3-pro-image-preview-2k",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://example.com/reference.png");

    const submitCall = fetchSpy.mock.calls[1];
    expect(submitCall?.[0]).toBe("https://api.tu-zi.com/v1/videos");

    const submitInit = submitCall?.[1] as RequestInit;
    expect(submitInit.method).toBe("POST");
    expect(submitInit.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer test-gemini-key",
      }),
    );
    expect(submitInit.body).toBeInstanceOf(FormData);

    const body = submitInit.body as FormData;
    expect(body.get("model")).toBe("gemini-3-pro-image-preview-2k-async");
    expect(body.get("prompt")).toBe("draw a mountain");
    expect(body.get("size")).toBe("16:9");

    const reference = body.get("input_reference");
    expect(reference).toBeInstanceOf(Blob);
    expect((reference as Blob).type).toBe("image/png");
  });

  it("polls async image tasks from /v1/videos/{id} and downloads the completed asset", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "completed",
            video_url: "https://cdn.example.com/generated.png",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        {
          ok: true,
          blob: async () => ({
            type: "image/png",
            arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
          }),
        } as Response,
      );

    const result = await pollAsyncImageResult("task-456");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://api.tu-zi.com/v1/videos/task-456");
    expect(fetchSpy.mock.calls[1]?.[0]).toBe("https://cdn.example.com/generated.png");
    expect(result).toEqual({
      base64: "AQID",
      mimeType: "image/png",
      usedFallback: false,
    });
  });

  it("returns a sync fallback marker when async reference images cannot be loaded", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 404 }),
    );

    const result = await callAsyncImageGeneration("draw a city", {
      model: "gemini-3-pro-image-preview-async",
      input_reference: "https://example.com/missing.png",
    });

    expect(result).toEqual({
      task_id: "",
      fallbackModel: "gemini-3-pro-image-preview",
      shouldUseFallback: true,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://example.com/missing.png");
  });

  it("throws a pending-task error instead of pretending queued work failed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "task-queued",
          object: "video",
          status: "queued",
          progress: 11,
          created_at: 1775925758790,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const error = await pollAsyncImageResult("task-queued", {
      maxAttempts: 1,
      maxDurationMs: 1,
      intervalMs: 1,
    }).catch((reason) => reason);

    expect(error).toBeInstanceOf(AsyncImageTaskPendingError);
    expect(isAsyncImageTaskPendingError(error)).toBe(true);
    expect(error).toMatchObject({
      taskId: "task-queued",
      status: "queued",
      progress: 11,
      createdAt: 1775925758790,
      maxDurationMs: 1,
    });
  });

  it("stops polling promptly when the user aborts during a backoff wait", async () => {
    vi.useFakeTimers();

    const controller = new AbortController();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "task-abort",
          object: "video",
          status: "queued",
          progress: 11,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const pending = pollAsyncImageResult("task-abort", {
      signal: controller.signal,
      maxAttempts: 5,
      maxDurationMs: 60_000,
    });

    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    controller.abort();

    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
      message: "请求已取消",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
