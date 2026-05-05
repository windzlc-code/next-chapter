import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_API_CONFIG,
  getStoredApiConfig,
  resolveJimengApiKey,
  loadBuiltinApiBundleFromDisk,
  resolveConfiguredModelNameFromConfig,
  resolveApiConfigForRuntime,
  saveApiConfig,
  type ApiConfig,
} from "./api-config";

describe("api-config builtin mode", () => {
  beforeEach(() => {
    window.electronAPI = {
      runtime: {
        builtinApiBundle: {
          geminiEndpoint: "https://api.tu-zi.com/v1beta",
          geminiKey: "",
          jimengEndpoint: "",
          jimengKey: "",
          viduEndpoint: "",
          viduKey: "",
          klingEndpoint: "",
          klingKey: "",
          modelMappings: {
            "gemini-3-flash-preview": "gemini-3-pro",
          },
        },
        builtinApiBundlePath: "C:\\mock\\builtin-api.json",
        verifyBuiltinApiAdminPassword: async () => true,
      },
    } as typeof window.electronAPI;
    localStorage.clear();
  });

  it("keeps locally-entered keys when builtin keys are empty", () => {
    const config: ApiConfig = {
      ...DEFAULT_API_CONFIG,
      apiMode: "builtin",
      geminiKey: "stale-custom-key",
      jimengKey: "stale-jimeng-key",
      gptEndpoint: "https://local-gpt.example.com/v1",
      tuziEndpoint: "https://local-tuzi.example.com/v1",
      tuziKey: "local-tuzi-key",
      modelMappings: {
        "gemini-3-flash-preview": "custom-model",
      },
    };

    const runtime = resolveApiConfigForRuntime(config);

    expect(runtime.geminiEndpoint).toBe("https://api.tu-zi.com/v1beta");
    expect(runtime.geminiKey).toBe("stale-custom-key");
    expect(runtime.jimengKey).toBe("stale-jimeng-key");
    expect(runtime.gptEndpoint).toBe("https://local-gpt.example.com/v1");
    expect(runtime.tuziEndpoint).toBe("https://local-tuzi.example.com/v1");
    expect(runtime.tuziKey).toBe("local-tuzi-key");
    expect(runtime.modelMappings["gemini-3-flash-preview"]).toBe("gemini-3-pro");
  });

  it("still lets non-empty builtin keys override local entries", async () => {
    window.electronAPI = {
      runtime: {
        builtinApiBundle: null,
        builtinApiBundlePath: "C:\\mock\\builtin-api.json",
        verifyBuiltinApiAdminPassword: async () => true,
      },
      storage: {
        readText: async () => ({
          ok: true,
          exists: true,
          content: JSON.stringify({
            geminiEndpoint: "https://builtin.example.com/v1beta",
            geminiKey: "builtin-gemini-key",
            tuziKey: "builtin-tuzi-key",
            modelMappings: {
              "gemini-3-flash-preview": "builtin-model",
            },
          }),
        }),
      },
    } as typeof window.electronAPI;

    await loadBuiltinApiBundleFromDisk();

    const runtime = resolveApiConfigForRuntime({
      ...DEFAULT_API_CONFIG,
      geminiEndpoint: "https://local.example.com/v1beta",
      geminiKey: "local-gemini-key",
      tuziKey: "local-tuzi-key",
      modelMappings: {
        "gemini-3-flash-preview": "local-model",
      },
    });

    expect(runtime.geminiEndpoint).toBe("https://builtin.example.com/v1beta");
    expect(runtime.geminiKey).toBe("builtin-gemini-key");
    expect(runtime.tuziKey).toBe("builtin-tuzi-key");
    expect(runtime.modelMappings["gemini-3-flash-preview"]).toBe("builtin-model");
  });

  it("normalizes legacy custom mode config back to builtin while keeping local keys", () => {
    localStorage.setItem(
      "storyforge_api_config",
      JSON.stringify({
        apiMode: "custom",
        geminiEndpoint: "https://custom.example.com",
        geminiKey: "custom-key",
        modelMappings: {
          "gemini-3-flash-preview": "custom-model",
        },
      }),
    );

    const config = getStoredApiConfig();

    expect(config.apiMode).toBe("builtin");
    expect(config.geminiEndpoint).toBe("https://custom.example.com");
    expect(config.geminiKey).toBe("custom-key");
    expect(config.modelMappings).toEqual({
      "gemini-3-flash-preview": "custom-model",
    });
  });

  it("preserves local api fields when saving other settings", () => {
    localStorage.setItem(
      "storyforge_api_config",
      JSON.stringify({
        apiMode: "custom",
        geminiEndpoint: "https://custom.example.com",
        geminiKey: "custom-key",
        retryCount: 5,
      }),
    );

    saveApiConfig({ storagePath: "C:\\workspace" });

    expect(JSON.parse(localStorage.getItem("storyforge_api_config") || "{}")).toEqual(
      expect.objectContaining({
        apiMode: "builtin",
        geminiEndpoint: "https://custom.example.com",
        geminiKey: expect.any(String),
        storagePath: "C:\\workspace",
        retryCount: 5,
      }),
    );
  });

  it("persists jimeng execution mode alongside other local settings", () => {
    saveApiConfig({ jimengExecutionMode: "cli" });

    const config = getStoredApiConfig();

    expect(config.jimengExecutionMode).toBe("cli");
  });

  it("keeps Ark Seedance endpoint mappings available even when the runtime bundle is unavailable", () => {
    window.electronAPI = {
      runtime: {
        builtinApiBundle: null,
        builtinApiBundlePath: "C:\\mock\\builtin-api.json",
        verifyBuiltinApiAdminPassword: async () => true,
      },
    } as typeof window.electronAPI;

    const runtime = resolveApiConfigForRuntime({
      ...DEFAULT_API_CONFIG,
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
    });

    expect(runtime.modelMappings["doubao-seedance-1-5-pro_480p"]).toBe(
      "ep-m-20260414192742-59w88",
    );
    expect(runtime.modelMappings["doubao-seedance-1-5-pro_720p"]).toBe(
      "ep-m-20260414192742-59w88",
    );
    expect(resolveConfiguredModelNameFromConfig(runtime, "doubao-seedance-1-5-pro_480p")).toBe(
      "ep-m-20260414192742-59w88",
    );
    expect(resolveConfiguredModelNameFromConfig(runtime, "doubao-seedance-1-5-pro_1080p")).toBe(
      "ep-m-20260414192742-59w88",
    );
  });

  it("does not reuse the Gemini key for Ark Seedance endpoints", () => {
    expect(
      resolveJimengApiKey({
        jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
        jimengKey: "",
        geminiKey: "gemini-only-key",
      }),
    ).toBe("");
  });

  it("still allows Gemini key fallback for non-Ark Seedance gateways", () => {
    expect(
      resolveJimengApiKey({
        jimengEndpoint: "https://api.tu-zi.com/v1beta",
        jimengKey: "",
        geminiKey: "gemini-only-key",
      }),
    ).toBe("gemini-only-key");
  });
});
