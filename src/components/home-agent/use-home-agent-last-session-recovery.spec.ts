import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { StudioSessionState } from "@/lib/home-agent/types";
import { useHomeAgentLastSessionRecovery } from "./use-home-agent-last-session-recovery";

const sessionStoreMocks = vi.hoisted(() => ({
  readLastSessionFromFile: vi.fn<() => Promise<StudioSessionState | null>>(),
  writeStudioSession: vi.fn<(session: StudioSessionState) => void>(),
  hasSessionResetMarkerForProject: vi.fn<(projectId: string | null | undefined) => boolean>(),
}));

vi.mock("@/lib/home-agent/session-store", () => ({
  readLastSessionFromFile: sessionStoreMocks.readLastSessionFromFile,
  writeStudioSession: sessionStoreMocks.writeStudioSession,
  hasSessionResetMarkerForProject: sessionStoreMocks.hasSessionResetMarkerForProject,
}));

function createSession(overrides: Partial<StudioSessionState> = {}): StudioSessionState {
  return {
    sessionId: "session-1",
    mode: "active",
    creationMode: "fast",
    automationMode: "manual",
    devMode: false,
    suppressHistoricalMemory: false,
    messages: [],
    currentProjectSnapshot: null,
    recentMessageSummary: "",
    draft: "",
    selectedValues: [],
    deferredSelectedValues: [],
    deferredDraft: "",
    surfacedTaskIds: [],
    surfacedTaskFollowupKeys: [],
    surfacedProjectSuggestionKeys: [],
    fullAutoRun: null,
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useHomeAgentLastSessionRecovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStoreMocks.hasSessionResetMarkerForProject.mockReturnValue(false);
  });

  it("restores the last file-backed session once when boot has no seed session", async () => {
    const fileSession = createSession({ projectId: "project-1" });
    sessionStoreMocks.readLastSessionFromFile.mockResolvedValue(fileSession);
    const openProject = vi.fn();

    renderHook(() =>
      useHomeAgentLastSessionRecovery({
        hasSeedSession: false,
        openProject,
      }),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sessionStoreMocks.readLastSessionFromFile).toHaveBeenCalledTimes(1);
    expect(sessionStoreMocks.writeStudioSession).toHaveBeenCalledWith(fileSession);
    expect(openProject).toHaveBeenCalledWith("project-1");
  });

  it("does not reopen the last session after the user suppresses auto-restore", async () => {
    const fileSession = createSession({ projectId: "project-2" });
    const deferred = createDeferred<StudioSessionState | null>();
    sessionStoreMocks.readLastSessionFromFile.mockReturnValue(deferred.promise);
    const openProject = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentLastSessionRecovery({
        hasSeedSession: false,
        openProject,
      }),
    );

    act(() => {
      result.current.suppressAutoRestore();
    });

    await act(async () => {
      deferred.resolve(fileSession);
      await deferred.promise;
      await Promise.resolve();
    });

    expect(sessionStoreMocks.writeStudioSession).not.toHaveBeenCalled();
    expect(openProject).not.toHaveBeenCalled();
  });

  it("does not retry file recovery when the openProject callback identity changes", async () => {
    const deferred = createDeferred<StudioSessionState | null>();
    sessionStoreMocks.readLastSessionFromFile.mockReturnValue(deferred.promise);
    const firstOpenProject = vi.fn();

    const { rerender } = renderHook(
      ({ openProject }) =>
        useHomeAgentLastSessionRecovery({
          hasSeedSession: false,
          openProject,
        }),
      {
        initialProps: { openProject: firstOpenProject },
      },
    );

    rerender({ openProject: vi.fn() });

    expect(sessionStoreMocks.readLastSessionFromFile).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.resolve(null);
      await deferred.promise;
    });
  });
});
