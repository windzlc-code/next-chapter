import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Settings from "./Settings";

const mocks = vi.hoisted(() => ({
  setTheme: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
  readHomeAgentLaunchReadiness: vi.fn(),
  getDefaultPath: vi.fn(),
  readText: vi.fn(),
  writeText: vi.fn(),
  verifyBuiltinApiAdminPassword: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({
    theme: "dark",
    setTheme: mocks.setTheme,
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  toast: mocks.toast,
}));

vi.mock("@/lib/home-agent/launch-readiness", () => ({
  readHomeAgentLaunchReadiness: mocks.readHomeAgentLaunchReadiness,
}));

vi.mock("@/lib/home-agent/history-settings", () => ({
  MIN_HISTORY_PROJECT_COUNT: 5,
  MAX_HISTORY_PROJECT_COUNT: 2000,
  getHistorySettings: () => ({
    autoDelete: false,
    maxCount: 2000,
  }),
  saveHistorySettings: vi.fn(),
}));

vi.mock("@/lib/home-agent/automation-mode", () => ({
  readStoredAutomationMode: () => "manual",
  writeStoredAutomationMode: (mode: string) => mode,
}));

describe("Settings built-in API editor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.readHomeAgentLaunchReadiness.mockResolvedValue({
      checkedAt: new Date().toISOString(),
      textReady: true,
      textMessage: "主会话已就绪",
      image: {
        ready: true,
        label: "图像已就绪",
        detail: "Gemini / Tuzi",
        tone: "ready",
      },
      video: {
        mode: "api",
        ready: true,
        label: "视频已就绪",
        detail: "Seedance API",
        tone: "ready",
      },
      notice: null,
    });
    mocks.getDefaultPath.mockResolvedValue({ files: "C:/StoryForge" });
    mocks.readText.mockResolvedValue({
      ok: true,
      exists: true,
      content: "{}",
    });
    mocks.writeText.mockImplementation(async (_path: string, content: string) => {
      mocks.readText.mockResolvedValue({
        ok: true,
        exists: true,
        content,
      });
      return { ok: true };
    });
    mocks.verifyBuiltinApiAdminPassword.mockResolvedValue(true);
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        storage: {
          getDefaultPath: mocks.getDefaultPath,
          readText: mocks.readText,
          writeText: mocks.writeText,
        },
        runtime: {
          builtinApiBundlePath: "C:/StoryForge/builtin-api.json",
          builtinApiBundle: {},
          verifyBuiltinApiAdminPassword: mocks.verifyBuiltinApiAdminPassword,
        },
      },
    });
  });

  async function openBuiltinApiEditor(options?: { renderPage?: boolean }) {
    if (options?.renderPage !== false) {
      render(<Settings embedded />);
    }

    fireEvent.click(screen.getByRole("button", { name: /修改内置 API/i }));
    const passwordDialog = await screen.findByRole("dialog", { name: "输入管理员密码" });
    const passwordInput = passwordDialog.querySelector('input[type="password"]');
    expect(passwordInput).not.toBeNull();
    fireEvent.change(passwordInput as HTMLInputElement, {
      target: { value: "admin-password" },
    });
    fireEvent.click(within(passwordDialog).getByRole("button", { name: "验证" }));

    await waitFor(() => {
      expect(screen.getByText("Aliyun HappyHorse API")).toBeInTheDocument();
    });
  }

  it("shows concise provider hints and save-setting messaging", async () => {
    await openBuiltinApiEditor();

    expect(
      screen.getByPlaceholderText(
        "默认：https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("填写后点击保存设置生效。API 地址留空将使用默认值；未填写的 API Key 当前未生效。"),
    ).toBeInTheDocument();
    expect(screen.getByText("Seedream 图片 API 地址。留空复用 Gemini API 地址。")).toBeInTheDocument();
    expect(screen.getByText("Aliyun HappyHorse 视频 API 地址。留空使用默认值。")).toBeInTheDocument();
    expect(screen.getByText("Seedance 视频 API 地址。留空复用 Gemini API 地址。")).toBeInTheDocument();
    expect(screen.getByText("Sora 视频 API 地址。留空使用默认值。")).toBeInTheDocument();
    expect(
      screen.getByText("Aliyun API Key。填写后点击保存设置生效；未填写则当前未生效。"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Sora API Key。填写后点击保存设置生效；未填写则当前未生效。"),
    ).toBeInTheDocument();
  });

  it("writes edited built-in api values after clicking 保存设置", async () => {
    await openBuiltinApiEditor();

    const editorDialog = screen.getByRole("dialog", { name: "修改内置 API" });
    fireEvent.change(screen.getByTestId("builtin-api-key-aliyun"), {
      target: { value: "aliyun-key-123" },
    });

    fireEvent.click(within(editorDialog).getByRole("button", { name: "保存设置" }));

    await waitFor(() => {
      expect(mocks.writeText).toHaveBeenCalled();
    });
    expect(mocks.writeText.mock.calls[0]?.[0]).toBe("C:/StoryForge/builtin-api.json");
    expect(mocks.writeText.mock.calls[0]?.[1]).toContain('"aliyunKey": "aliyun-key-123"');

    await openBuiltinApiEditor({ renderPage: false });

    const reopenedAliyunKeyInput = screen.getByTestId("builtin-api-key-aliyun") as HTMLInputElement;
    const reopenedGeminiKeyInput = screen.getByTestId("builtin-api-key-gemini") as HTMLInputElement;
    expect(reopenedAliyunKeyInput.type).toBe("password");
    expect(reopenedGeminiKeyInput.type).toBe("password");
    expect(reopenedAliyunKeyInput.value).toBe("aliyun-key-123");
  });
});
