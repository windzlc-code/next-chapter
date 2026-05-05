import { beforeEach, describe, expect, it, vi } from "vitest";

import { saveApiConfig } from "./api-config";
import {
  buildIncompleteDecomposeError,
  invokeFunction,
  normalizeDecomposeScenes,
  normalizeEpisodeSegmentLabel,
  validateDecomposeSceneCounts,
} from "./invoke-with-key";

describe("invoke-with-key video transport", () => {
  beforeEach(() => {
    localStorage.clear();
    window.electronAPI = {
      runtime: {
        builtinApiBundle: null,
        builtinApiBundlePath: "",
        verifyBuiltinApiAdminPassword: async () => true,
      },
    } as typeof window.electronAPI;

    saveApiConfig({
      jimengEndpoint: "https://api.tu-zi.com/v1beta",
      jimengKey: "test-jimeng-key",
      jimengExecutionMode: "api",
      geminiEndpoint: "https://api.tu-zi.com/v1beta",
      geminiKey: "test-gemini-key",
    });
  });

  it("submits Seedance video generation to /v1/videos without seconds", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "video-task-123",
          status: "queued",
          progress: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "测试视频提示词",
      aspectRatio: "16:9",
      resolution: "1080p",
      model: "doubao-seedance-1-5-pro_1080p",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      task_id: "video-task-123",
      status: "queued",
      progress: 0,
      provider: "jimeng",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://api.tu-zi.com/v1/videos");

    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(request.method).toBe("POST");
    expect(request.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer test-jimeng-key",
      }),
    );
    expect(request.body).toBeInstanceOf(FormData);

    const body = request.body as FormData;
    expect(body.get("model")).toBe("doubao-seedance-1-5-pro_1080p");
    expect(body.get("prompt")).toBe("测试视频提示词");
    expect(body.get("size")).toBe("16:9");
    expect(body.get("seconds")).toBeNull();
  });

  it("submits a storyboard frame as input_reference when image-to-video input is provided", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "video-task-789",
          status: "queued",
          progress: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "text-only storyboard derived video prompt",
      imageUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3X8AAAAASUVORK5CYII=",
      aspectRatio: "16:9",
      resolution: "1080p",
      model: "doubao-seedance-1-5-pro_1080p",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(request.body).toBeInstanceOf(FormData);
    const body = request.body as FormData;
    expect(body.get("prompt")).toBe("text-only storyboard derived video prompt");
    expect(body.get("input_reference")).toBeInstanceOf(File);
  });

  it("submits Ark video generation tasks when the Jimeng endpoint points to contents/generations/tasks", async () => {
    saveApiConfig({
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengKey: "test-ark-key",
      jimengExecutionMode: "api",
      modelMappings: {
        "doubao-seedance-1-5-pro_1080p": "doubao-seedance-1-5-pro-251215",
      },
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "ark-task-123",
          status: "queued",
          progress: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "ark text to video prompt",
      resolution: "1080p",
      duration: 4,
      aspectRatio: "16:9",
      model: "doubao-seedance-1-5-pro_1080p",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks");

    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(request.method).toBe("POST");
    expect(request.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer test-ark-key",
        "Content-Type": "application/json",
      }),
    );

    const payload = JSON.parse(String(request.body));
    expect(payload).toEqual(
      expect.objectContaining({
        model: "doubao-seedance-1-5-pro-251215",
        resolution: "1080p",
        duration: 4,
        ratio: "16:9",
        watermark: false,
      }),
    );
    expect(payload.content).toEqual([{ type: "text", text: "ark text to video prompt" }]);
  });

  it("surfaces actionable Ark permission details when video task creation is forbidden", async () => {
    saveApiConfig({
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengKey: "test-ark-key",
      jimengExecutionMode: "api",
      modelMappings: {
        "doubao-seedance-1-5-pro_1080p": "ep-m-20260414192742-59w88",
      },
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: "OperationDenied.ServiceNotOpen",
          message: "service not open",
          request_id: "req-ark-403",
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "ark forbidden prompt",
      resolution: "1080p",
      duration: 4,
      aspectRatio: "16:9",
      model: "doubao-seedance-1-5-pro_1080p",
      provider: "jimeng",
    });

    expect(result.data).toBeNull();
    expect(result.error?.message).toContain("Ark 视频生成任务创建失败 (403)");
    expect(result.error?.message).toContain("OperationDenied.ServiceNotOpen");
    expect(result.error?.message).toContain("当前 Ark 账号或 API Key 尚未开通该视频能力");
    expect(result.error?.message).toContain("request_id: req-ark-403");
  });

  it("converts local storyboard file paths into data URLs before submitting Ark image-to-video tasks", async () => {
    saveApiConfig({
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengKey: "test-ark-key",
      jimengExecutionMode: "api",
    });

    window.electronAPI = {
      runtime: {
        builtinApiBundle: null,
        builtinApiBundlePath: "",
        verifyBuiltinApiAdminPassword: async () => true,
      },
      storage: {
        readBase64: async () => ({
          ok: true,
          exists: true,
          base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3X8AAAAASUVORK5CYII=",
          mimeType: "image/png",
        }),
      },
    } as typeof window.electronAPI;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "ark-task-i2v-123",
          status: "queued",
          progress: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "ark image to video prompt",
      imageUrl: "C:\\temp\\storyboard-frame.png",
      resolution: "720p",
      duration: 4,
      aspectRatio: "16:9",
      model: "doubao-seedance-1-5-pro_720p",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload.content).toEqual([
      { type: "text", text: "ark image to video prompt" },
      expect.objectContaining({
        type: "image_url",
        role: "first_frame",
        image_url: expect.objectContaining({
          url: expect.stringMatching(/^data:image\/png;base64,/),
        }),
      }),
    ]);
  });

  it("falls back to the bundled Ark endpoint id when no local model mapping is stored", async () => {
    saveApiConfig({
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengKey: "test-ark-key",
      jimengExecutionMode: "api",
      modelMappings: {},
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "ark-task-fallback-123",
          status: "queued",
          progress: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "ark fallback mapping prompt",
      resolution: "1080p",
      duration: 4,
      aspectRatio: "16:9",
      model: "doubao-seedance-1-5-pro_1080p",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload.model).toBe("ep-m-20260414192742-59w88");
  });

  it("also falls back to the bundled Ark endpoint id for 480p requests", async () => {
    saveApiConfig({
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengKey: "test-ark-key",
      jimengExecutionMode: "api",
      modelMappings: {},
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "ark-task-fallback-480p",
          status: "queued",
          progress: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "ark fallback mapping 480p prompt",
      resolution: "480p",
      duration: 4,
      aspectRatio: "16:9",
      model: "doubao-seedance-1-5-pro_480p",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload.model).toBe("ep-m-20260414192742-59w88");
    expect(payload.resolution).toBe("480p");
  });

  it("polls Ark video task status from contents/generations/tasks/{taskId}", async () => {
    saveApiConfig({
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengKey: "test-ark-key",
      jimengExecutionMode: "api",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "completed",
          content: {
            video_url: "https://cdn.example.com/ark-video.mp4",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      action: "status",
      taskId: "ark-task-456",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      status: "succeeded",
      video_url: "https://cdn.example.com/ark-video.mp4",
      state: "completed",
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/ark-task-456",
    );
  });

  it("polls Seedance video status from /v1/videos/{taskId}", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "completed",
          progress: 100,
          video_url: "https://cdn.example.com/video.mp4",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      action: "status",
      taskId: "video-task-456",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      status: "completed",
      progress: 100,
      video_url: "https://cdn.example.com/video.mp4",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://api.tu-zi.com/v1/videos/video-task-456");

    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(request.method).toBe("GET");
    expect(request.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer test-jimeng-key",
      }),
    );
  });

  it("normalizes nested Seedance video urls during status polling", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "completed",
          progress: 100,
          output: {
            videos: [{ url: "https://cdn.example.com/video-nested.mp4" }],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      action: "status",
      taskId: "video-task-nested-456",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual(
      expect.objectContaining({
        status: "completed",
        progress: 100,
        video_url: "https://cdn.example.com/video-nested.mp4",
      }),
    );
  });

  it("cancels Ark video tasks through contents/generations/tasks/{taskId}", async () => {
    saveApiConfig({
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengKey: "test-ark-key",
      jimengExecutionMode: "api",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, {
        status: 204,
      }),
    );

    const result = await invokeFunction("generate-video", {
      action: "cancel",
      taskId: "ark-task-789",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      task_id: "ark-task-789",
      status: "cancelled",
      provider: "jimeng",
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/ark-task-789",
    );
    expect((fetchSpy.mock.calls[0]?.[1] as RequestInit)?.method).toBe("DELETE");
  });

  it("cancels Seedance video tasks through /v1/videos/{taskId}", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, {
        status: 204,
      }),
    );

    const result = await invokeFunction("generate-video", {
      action: "cancel",
      taskId: "video-task-999",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      task_id: "video-task-999",
      status: "cancelled",
      provider: "jimeng",
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://api.tu-zi.com/v1/videos/video-task-999");
    expect((fetchSpy.mock.calls[0]?.[1] as RequestInit)?.method).toBe("DELETE");
  });

  it.skip("rejects decompositions that exceed the prompt shot ceiling", () => {
    expect(() =>
      validateDecomposeSceneCounts(
        [
          { segmentLabel: "1-1", description: "a" },
          { segmentLabel: "1-1", description: "b" },
          { segmentLabel: "1-1", description: "c" },
          { segmentLabel: "1-1", description: "d" },
          { segmentLabel: "1-1", description: "e" },
          { segmentLabel: "1-1", description: "f" },
          { segmentLabel: "1-2", description: "g" },
          { segmentLabel: "1-2", description: "h" },
          { segmentLabel: "1-2", description: "i" },
          { segmentLabel: "1-3", description: "j" },
          { segmentLabel: "1-3", description: "k" },
          { segmentLabel: "1-3", description: "l" },
          { segmentLabel: "1-4", description: "m" },
          { segmentLabel: "1-4", description: "n" },
          { segmentLabel: "1-4", description: "o" },
          { segmentLabel: "1-5", description: "p" },
          { segmentLabel: "1-5", description: "q" },
          { segmentLabel: "1-5", description: "r" },
        ],
        { segmentsTarget: 5, videoPace: "medium" },
      ),
    ).toThrow(/涓婇檺/);
  });

  it.skip("rejects decompositions that keep dialogue inside description", () => {
    expect(() =>
      validateDecomposeSceneCounts(
        [
          { segmentLabel: "1-1", description: "沈棠：你终于来了" },
          { segmentLabel: "1-1", description: "中景：雨水打在伞面" },
          { segmentLabel: "1-1", description: "特写：手指攥紧伞柄" },
          { segmentLabel: "1-2", description: "中景：巷口有人影逼近" },
          { segmentLabel: "1-2", description: "近景：[顾临]抬眼" },
          { segmentLabel: "1-2", description: "特写：鞋跟踩过积水" },
          { segmentLabel: "1-3", description: "中景：两人隔雨对峙" },
          { segmentLabel: "1-3", description: "近景：[沈棠]向后退半步" },
          { segmentLabel: "1-3", description: "特写：雨珠挂在睫毛上" },
          { segmentLabel: "1-4", description: "中景：[顾临]停在路灯下" },
          { segmentLabel: "1-4", description: "近景：风吹起衣角" },
          { segmentLabel: "1-4", description: "特写：路灯闪烁" },
          { segmentLabel: "1-5", description: "中景：两人沉默对望" },
          { segmentLabel: "1-5", description: "近景：呼吸在雨夜里起雾" },
          { segmentLabel: "1-5", description: "特写：指节泛白" },
        ],
        { segmentsTarget: 5, videoPace: "medium" },
      ),
    ).toThrow(/description/);
  });
});

describe("validateDecomposeSceneCounts", () => {
  it("normalizes dialogue lines out of description before validation", () => {
    expect(
      normalizeDecomposeScenes([
        {
          sceneNumber: 1,
          segmentLabel: "1-1",
          sceneName: "Rainy Alley",
          description: "中景：雨夜长街里，[沈棠]回头 | 沈棠：你终于来了",
          dialogue: "",
          characters: ["沈棠"],
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        description: "中景：雨夜长街里，[沈棠]回头",
        dialogue: "沈棠：你终于来了",
        characters: ["沈棠"],
      }),
    ]);
  });

  it("removes narration labels from characters and rebalances segment durations", () => {
    expect(
      normalizeDecomposeScenes([
        {
          sceneNumber: 1,
          segmentLabel: "1-1",
          sceneName: "Rainy Alley",
          description: "涓櫙锛氶洦澶滈暱琛楅噷",
          dialogue: "鏃佺櫧锛氶洦姘存部鐫€浼炴獝娣屼笅",
          characters: ["鏃佺櫧", "娌堟"],
          duration: 15,
        },
        {
          sceneNumber: 2,
          segmentLabel: "1-1",
          sceneName: "Rainy Alley",
          description: "杩戞櫙锛孾娌堟]鎶€澶?",
          dialogue: "",
          characters: ["娌堟"],
          duration: 15,
        },
        {
          sceneNumber: 3,
          segmentLabel: "1-1",
          sceneName: "Rainy Alley",
          description: "鐗瑰啓锛氶洦婊存粦杩囨墜鑳?",
          dialogue: "",
          characters: [],
          duration: 15,
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        characters: ["娌堟"],
        duration: 5,
      }),
      expect.objectContaining({
        duration: 5,
      }),
      expect.objectContaining({
        duration: 5,
      }),
    ]);
  });

  it("accepts scene counts that satisfy the prompt floor", () => {
    expect(() =>
      validateDecomposeSceneCounts(
        [
          { segmentLabel: "1-1", description: "a" },
          { segmentLabel: "1-1", description: "b" },
          { segmentLabel: "1-1", description: "c" },
          { segmentLabel: "1-2", description: "d" },
          { segmentLabel: "1-2", description: "e" },
          { segmentLabel: "1-2", description: "f" },
          { segmentLabel: "1-3", description: "g" },
          { segmentLabel: "1-3", description: "h" },
          { segmentLabel: "1-3", description: "i" },
          { segmentLabel: "1-4", description: "j" },
          { segmentLabel: "1-4", description: "k" },
          { segmentLabel: "1-4", description: "l" },
          { segmentLabel: "1-5", description: "m" },
          { segmentLabel: "1-5", description: "n" },
          { segmentLabel: "1-5", description: "o" },
        ],
        { segmentsTarget: 5, videoPace: "medium" },
      ),
    ).not.toThrow();
  });

  it("rejects decompositions that underfill required segments", () => {
    expect(() =>
      validateDecomposeSceneCounts(
        [
          { segmentLabel: "1-1", description: "a" },
          { segmentLabel: "1-1", description: "b" },
          { segmentLabel: "1-1", description: "c" },
          { segmentLabel: "1-2", description: "d" },
          { segmentLabel: "1-2", description: "e" },
          { segmentLabel: "1-2", description: "f" },
        ],
        { segmentsTarget: 5, videoPace: "medium" },
      ),
    ).toThrow(/片段数不足/);
  });

  it("rejects decompositions that underfill required shots per segment", () => {
    expect(() =>
      validateDecomposeSceneCounts(
        [
          { segmentLabel: "1-1", description: "a" },
          { segmentLabel: "1-1", description: "b" },
          { segmentLabel: "1-2", description: "c" },
          { segmentLabel: "1-2", description: "d" },
          { segmentLabel: "1-2", description: "e" },
          { segmentLabel: "1-3", description: "f" },
          { segmentLabel: "1-3", description: "g" },
          { segmentLabel: "1-3", description: "h" },
          { segmentLabel: "1-4", description: "i" },
          { segmentLabel: "1-4", description: "j" },
          { segmentLabel: "1-4", description: "k" },
          { segmentLabel: "1-5", description: "l" },
          { segmentLabel: "1-5", description: "m" },
          { segmentLabel: "1-5", description: "n" },
        ],
        { segmentsTarget: 5, videoPace: "medium" },
      ),
    ).toThrow(/分镜数不足/);
  });
});

describe("multi-episode script decomposition guards", () => {
  it("normalizes per-episode segment labels emitted with the wrong episode prefix", () => {
    expect(normalizeEpisodeSegmentLabel("1-1", 2)).toBe("2-1");
    expect(normalizeEpisodeSegmentLabel("2-1", 2)).toBe("2-1");
    expect(normalizeEpisodeSegmentLabel("2-1-1", 2)).toBe("2-1");
    expect(normalizeEpisodeSegmentLabel("片段4", 7)).toBe("7-4");
  });

  it("builds a blocking error when any episode chunk fails", () => {
    expect(buildIncompleteDecomposeError([0, 3, 6], 7).message).toBe(
      "剧本拆解未完成：第 1 集、第 4 集、第 7 集 拆解失败，仅完成 4/7 集。请重试剧本拆解，避免保存不完整分镜。",
    );
  });
});
