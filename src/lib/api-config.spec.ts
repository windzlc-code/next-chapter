import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_API_CONFIG,
  getApiConfig,
  getStoredApiConfig,
  hydrateStoredApiConfigFromBuiltinBundle,
  resolveJimengApiKey,
  loadBuiltinApiBundleFromDisk,
  resolveConfiguredModelNameFromConfig,
  resolveApiConfigForRuntime,
  saveApiConfig,
  syncApiConfigToServerProxy,
  type ApiConfig,
} from "./api-config";

const ORIGINAL_CLAUDE_ENDPOINT_ENV = import.meta.env.VITE_DEFAULT_CLAUDE_ENDPOINT;
const ORIGINAL_CLAUDE_KEY_ENV = import.meta.env.VITE_DEFAULT_CLAUDE_KEY;

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
    import.meta.env.VITE_DEFAULT_CLAUDE_ENDPOINT = "";
    import.meta.env.VITE_DEFAULT_CLAUDE_KEY = "";
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

  afterEach(() => {
    import.meta.env.VITE_DEFAULT_CLAUDE_ENDPOINT = ORIGINAL_CLAUDE_ENDPOINT_ENV;
    import.meta.env.VITE_DEFAULT_CLAUDE_KEY = ORIGINAL_CLAUDE_KEY_ENV;
    vi.unstubAllGlobals();
  });

  it("drops legacy external storage overrides when saving other settings", () => {
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
        storagePath: "",
        retryCount: 5,
      }),
    );
  });

  it("persists jimeng execution mode alongside other local settings", () => {
    saveApiConfig({ jimengExecutionMode: "cli" });

    const config = getStoredApiConfig();

    expect(config.jimengExecutionMode).toBe("cli");
  });

  it("hydrates builtin api values into local storage so browser state can reuse them", () => {
    const changed = hydrateStoredApiConfigFromBuiltinBundle();

    expect(changed).toBe(true);
    expect(getStoredApiConfig()).toEqual(
      expect.objectContaining({
        geminiEndpoint: "https://api.tu-zi.com/v1beta",
      }),
    );

    const persisted = getStoredApiConfig();
    expect(persisted.gptEndpoint).toBe("https://api.tu-zi.com/v1beta");
    expect(persisted.claudeEndpoint).toBe("https://api.tu-zi.com/v1beta");
    expect(hydrateStoredApiConfigFromBuiltinBundle()).toBe(false);
  });

  it("does not overwrite locally entered keys when the builtin bundle keeps them empty", () => {
    saveApiConfig({
      geminiKey: "local-gemini-key",
      jimengKey: "local-jimeng-key",
    });

    const changed = hydrateStoredApiConfigFromBuiltinBundle();
    const persisted = getStoredApiConfig();

    expect(changed).toBe(true);
    expect(persisted.geminiKey).toBe("local-gemini-key");
    expect(persisted.jimengKey).toBe("local-jimeng-key");
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

  it("routes browser runtime requests through the local server proxy while preserving saved upstream values", () => {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: undefined,
    });

    saveApiConfig({
      geminiEndpoint: "https://upstream.example.com/v1beta",
      geminiKey: "upstream-gemini-key",
      jimengEndpoint: "https://video.example.com/v1",
    });

    expect(getStoredApiConfig().geminiEndpoint).toBe("https://upstream.example.com/v1beta");
    expect(getStoredApiConfig().jimengEndpoint).toBe("https://video.example.com/v1");

    const runtime = getApiConfig();
    expect(runtime.geminiEndpoint).toBe("/api/proxy/gemini");
    expect(runtime.jimengEndpoint).toBe("/api/proxy/jimeng");
    expect(runtime.geminiKey).toBe("upstream-gemini-key");
  });

  it("falls back to env defaults when stored sensitive fields are blank", () => {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: undefined,
    });

    const previousClaudeEndpoint = import.meta.env.VITE_DEFAULT_CLAUDE_ENDPOINT;
    const previousClaudeKey = import.meta.env.VITE_DEFAULT_CLAUDE_KEY;
    import.meta.env.VITE_DEFAULT_CLAUDE_ENDPOINT = "https://api.tu-zi.com/v1";
    import.meta.env.VITE_DEFAULT_CLAUDE_KEY = "env-claude-key";

    try {
      localStorage.setItem(
        "storyforge_api_config",
        JSON.stringify({
          apiMode: "builtin",
          claudeEndpoint: "",
          claudeKey: "",
        }),
      );

      const config = getStoredApiConfig();
      expect(config.claudeEndpoint).toBe("https://api.tu-zi.com/v1");
      expect(config.claudeKey).toBe("env-claude-key");
    } finally {
      import.meta.env.VITE_DEFAULT_CLAUDE_ENDPOINT = previousClaudeEndpoint;
      import.meta.env.VITE_DEFAULT_CLAUDE_KEY = previousClaudeKey;
    }
  });

  it("syncs saved upstream api settings into the local proxy session in browser mode", async () => {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: undefined,
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    saveApiConfig({
      geminiEndpoint: "https://sync-upstream.example.com/v1beta",
      geminiKey: "sync-gemini-key",
      runninghubEndpoint: "https://www.runninghub.cn",
      runninghubKey: "sync-runninghub-key",
    });

    await syncApiConfigToServerProxy();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/workflow/session",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/workflow/config",
      expect.objectContaining({
        method: "PUT",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
      }),
    );
    const secondCall = fetchMock.mock.calls[1];
    const secondOptions = secondCall?.[1] as { body?: string } | undefined;
    const syncedPayload = JSON.parse(String(secondOptions?.body || "{}"));
    expect(String(syncedPayload.geminiEndpoint || "")).not.toContain("/api/proxy/");
    expect(String(syncedPayload.runninghubEndpoint || "")).not.toContain("/api/proxy/");
    expect(syncedPayload.geminiKey).toBe("sync-gemini-key");
    expect(syncedPayload.runninghubEndpoint).toBe("https://www.runninghub.cn");
    expect(syncedPayload.runninghubKey).toBe("sync-runninghub-key");
  });
});
