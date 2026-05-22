const SHARED_STATE_ENDPOINT = "/api/home-agent/shared-state";
const SHARED_STATE_MARKER_KEY = "storyforge-home-agent-cloud-shared-state-marker-v1";
const SHARED_STATE_CLIENT_ID_KEY = "storyforge-home-agent-cloud-shared-state-client-id-v1";
const SYNC_INTERVAL_MS = 2500;

export const HOME_AGENT_SHARED_STATE_STORAGE_KEYS = [
  "storyforge-home-agent-session-v1",
  "storyforge-home-agent-session-bootstrap-v1",
  "storyforge-home-agent-project-sessions-v1",
  "storyforge_projects",
  "storyforge_drama_projects",
  "storyforge_current_project",
  "storyforge-home-agent-text-model-v1",
  "storyforge-home-agent-image-prefs-v1",
  "storyforge-home-agent-video-prefs-v1",
  "storyforge-home-agent-automation-mode-v1",
  "storyforge-home-agent-project-meta-v1",
] as const;

type SharedStorageKey = (typeof HOME_AGENT_SHARED_STATE_STORAGE_KEYS)[number];

export type HomeAgentCloudSharedState = {
  version: 1;
  updatedAt: string | null;
  savedAt?: string | null;
  clientId?: string;
  storage: Partial<Record<SharedStorageKey, string>>;
};

type HydrateResult = {
  applied: boolean;
  hasRemoteState: boolean;
};

function canUseCloudSharedState(): boolean {
  if (typeof window === "undefined") return false;
  if (window.location.protocol === "file:") return false;
  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    return false;
  }
  return typeof window.fetch === "function" && typeof window.localStorage !== "undefined";
}

function safeGetItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Keep the app usable even if a browser blocks storage writes.
  }
}

function safeRemoveItem(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore cleanup failures.
  }
}

function safeReadMarker(): { updatedAt: string | null } {
  const raw = safeGetItem(SHARED_STATE_MARKER_KEY);
  if (!raw) return { updatedAt: null };
  try {
    const parsed = JSON.parse(raw) as { updatedAt?: unknown };
    return {
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    };
  } catch {
    return { updatedAt: null };
  }
}

function safeWriteMarker(updatedAt: string | null): void {
  if (!updatedAt) {
    safeRemoveItem(SHARED_STATE_MARKER_KEY);
    return;
  }
  safeSetItem(SHARED_STATE_MARKER_KEY, JSON.stringify({ updatedAt }));
}

function getClientId(): string {
  const existing = safeGetItem(SHARED_STATE_CLIENT_ID_KEY);
  if (existing) return existing;
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  safeSetItem(SHARED_STATE_CLIENT_ID_KEY, id);
  return id;
}

function timestampOf(value: string | null | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function collectLocalSharedStorage(): Partial<Record<SharedStorageKey, string>> {
  const storage: Partial<Record<SharedStorageKey, string>> = {};
  for (const key of HOME_AGENT_SHARED_STATE_STORAGE_KEYS) {
    const value = safeGetItem(key);
    if (typeof value === "string") {
      storage[key] = value;
    }
  }
  return storage;
}

function hasMeaningfulState(storage: Partial<Record<SharedStorageKey, string>>): boolean {
  return Boolean(
    storage["storyforge-home-agent-session-v1"] ||
      storage["storyforge-home-agent-project-sessions-v1"] ||
      storage.storyforge_projects,
  );
}

function normalizeRemoteState(payload: unknown): HomeAgentCloudSharedState | null {
  const state =
    payload && typeof payload === "object" && "state" in payload
      ? (payload as { state?: unknown }).state
      : payload;
  if (!state || typeof state !== "object") return null;
  const record = state as Partial<HomeAgentCloudSharedState>;
  const rawStorage =
    record.storage && typeof record.storage === "object" && !Array.isArray(record.storage)
      ? record.storage
      : {};
  const storage = Object.fromEntries(
    HOME_AGENT_SHARED_STATE_STORAGE_KEYS.flatMap((key) => {
      const value = (rawStorage as Record<string, unknown>)[key];
      return typeof value === "string" ? [[key, value]] : [];
    }),
  ) as Partial<Record<SharedStorageKey, string>>;

  return {
    version: 1,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
    savedAt: typeof record.savedAt === "string" ? record.savedAt : null,
    clientId: typeof record.clientId === "string" ? record.clientId : "",
    storage,
  };
}

async function fetchRemoteSharedState(): Promise<HomeAgentCloudSharedState | null> {
  const response = await fetch(SHARED_STATE_ENDPOINT, {
    method: "GET",
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (!response.ok) return null;
  return normalizeRemoteState(await response.json());
}

async function pushRemoteSharedState(storage: Partial<Record<SharedStorageKey, string>>): Promise<string | null> {
  const updatedAt = new Date().toISOString();
  const response = await fetch(SHARED_STATE_ENDPOINT, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      version: 1,
      updatedAt,
      clientId: getClientId(),
      storage,
    }),
  });
  if (!response.ok) return null;
  const remote = normalizeRemoteState(await response.json());
  return remote?.updatedAt ?? updatedAt;
}

export async function hydrateHomeAgentCloudSharedState(): Promise<HydrateResult> {
  if (!canUseCloudSharedState()) {
    return { applied: false, hasRemoteState: false };
  }

  try {
    const remote = await fetchRemoteSharedState();
    if (!remote || !hasMeaningfulState(remote.storage)) {
      return { applied: false, hasRemoteState: false };
    }

    const marker = safeReadMarker();
    const localStorageState = collectLocalSharedStorage();
    const localIsEmpty = !hasMeaningfulState(localStorageState);
    const remoteIsNewer = timestampOf(remote.updatedAt) > timestampOf(marker.updatedAt);
    if (!localIsEmpty && !remoteIsNewer) {
      return { applied: false, hasRemoteState: true };
    }

    for (const [key, value] of Object.entries(remote.storage)) {
      safeSetItem(key, value);
    }
    safeWriteMarker(remote.updatedAt);
    return { applied: true, hasRemoteState: true };
  } catch {
    return { applied: false, hasRemoteState: false };
  }
}

export function startHomeAgentCloudSharedStateSync(): () => void {
  if (!canUseCloudSharedState()) return () => undefined;

  let stopped = false;
  let pushing = false;
  let lastSnapshot = "";
  let timer: number | null = null;

  const syncNow = async () => {
    if (stopped || pushing) return;
    const storage = collectLocalSharedStorage();
    if (!hasMeaningfulState(storage)) return;
    const snapshot = JSON.stringify(storage);
    if (snapshot === lastSnapshot) return;

    pushing = true;
    try {
      const updatedAt = await pushRemoteSharedState(storage);
      if (updatedAt) {
        lastSnapshot = snapshot;
        safeWriteMarker(updatedAt);
      }
    } catch {
      // The next interval/pagehide will retry.
    } finally {
      pushing = false;
    }
  };

  const schedule = () => {
    if (timer !== null) window.clearInterval(timer);
    timer = window.setInterval(() => {
      void syncNow();
    }, SYNC_INTERVAL_MS);
  };

  const handleVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      void syncNow();
    }
  };

  const handlePageHide = () => {
    void syncNow();
  };

  void syncNow();
  schedule();
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pagehide", handlePageHide);

  return () => {
    stopped = true;
    if (timer !== null) window.clearInterval(timer);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("pagehide", handlePageHide);
  };
}
