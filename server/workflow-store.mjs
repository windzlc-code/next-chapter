import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_STORE = {
  version: 1,
  sessions: {},
  tasks: {},
};

const CONFIG_FIELDS = [
  "geminiEndpoint",
  "geminiKey",
  "gptEndpoint",
  "gptKey",
  "claudeEndpoint",
  "claudeKey",
  "grokEndpoint",
  "grokKey",
  "seedreamEndpoint",
  "seedreamKey",
  "jimengEndpoint",
  "jimengKey",
  "tuziEndpoint",
  "tuziKey",
  "jimengExecutionMode",
];

function cloneDefaultStore() {
  return {
    version: DEFAULT_STORE.version,
    sessions: {},
    tasks: {},
  };
}

function maskSecret(secret) {
  const value = String(secret || "").trim();
  if (!value) return "";
  if (value.length <= 8) return `${value.slice(0, 2)}***${value.slice(-1)}`;
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function normalizeSessionConfig(input) {
  const next = {};
  for (const field of CONFIG_FIELDS) {
    if (typeof input?.[field] === "string") {
      next[field] = input[field].trim();
    }
  }
  return next;
}

function buildConfigSummary(config) {
  const providers = [
    ["gemini", "geminiEndpoint", "geminiKey"],
    ["gpt", "gptEndpoint", "gptKey"],
    ["claude", "claudeEndpoint", "claudeKey"],
    ["grok", "grokEndpoint", "grokKey"],
    ["seedream", "seedreamEndpoint", "seedreamKey"],
    ["jimeng", "jimengEndpoint", "jimengKey"],
    ["tuzi", "tuziEndpoint", "tuziKey"],
  ];

  return providers.reduce((acc, [provider, endpointField, keyField]) => {
    const endpoint = String(config?.[endpointField] || "").trim();
    const apiKey = String(config?.[keyField] || "").trim();
    acc[provider] = {
      endpoint,
      hasEndpoint: Boolean(endpoint),
      hasApiKey: Boolean(apiKey),
      apiKeyMasked: apiKey ? maskSecret(apiKey) : "",
    };
    return acc;
  }, {});
}

async function ensureParentDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export function createWorkflowStore(options = {}) {
  const storePath = path.resolve(
    options.storePath || path.join(process.cwd(), "server-data", "workflow-store.json"),
  );
  const maxTasks = Number(options.maxTasks || 500);
  let writeChain = Promise.resolve();

  async function loadStore() {
    try {
      const raw = await fs.readFile(storePath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        version: 1,
        sessions: parsed?.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
        tasks: parsed?.tasks && typeof parsed.tasks === "object" ? parsed.tasks : {},
      };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return cloneDefaultStore();
      }
      throw error;
    }
  }

  function queueWrite(mutator) {
    writeChain = writeChain.then(async () => {
      const store = await loadStore();
      const next = (await mutator(store)) || store;
      await ensureParentDir(storePath);
      await fs.writeFile(storePath, JSON.stringify(next, null, 2), "utf8");
      return next;
    });
    return writeChain;
  }

  async function findSessionByToken(token) {
    const value = String(token || "").trim();
    if (!value) return null;
    const store = await loadStore();
    const session = Object.values(store.sessions).find((item) => item?.token === value);
    return session || null;
  }

  async function createOrReuseSession(existingToken) {
    const found = await findSessionByToken(existingToken);
    if (found) {
      await queueWrite((store) => {
        const current = store.sessions[found.clientId];
        if (!current) return store;
        current.updatedAt = new Date().toISOString();
        return store;
      });
      return {
        ...found,
        updatedAt: new Date().toISOString(),
      };
    }

    const clientId = crypto.randomUUID();
    const token = `wf_${crypto.randomBytes(24).toString("hex")}`;
    const now = new Date().toISOString();
    await queueWrite((store) => {
      store.sessions[clientId] = {
        clientId,
        token,
        createdAt: now,
        updatedAt: now,
        config: {},
      };
      return store;
    });
    return {
      clientId,
      token,
      createdAt: now,
      updatedAt: now,
      config: {},
    };
  }

  async function touchSession(clientId) {
    return queueWrite((store) => {
      const session = store.sessions[clientId];
      if (!session) return store;
      session.updatedAt = new Date().toISOString();
      return store;
    });
  }

  async function saveSessionConfig(clientId, partialConfig) {
    const normalized = normalizeSessionConfig(partialConfig);
    return queueWrite((store) => {
      const session = store.sessions[clientId];
      if (!session) throw new Error("Workflow session not found");
      session.config = {
        ...(session.config || {}),
        ...normalized,
      };
      session.updatedAt = new Date().toISOString();
      return store;
    }).then((store) => store.sessions[clientId]);
  }

  async function clearSessionConfig(clientId) {
    return queueWrite((store) => {
      const session = store.sessions[clientId];
      if (!session) throw new Error("Workflow session not found");
      session.config = {};
      session.updatedAt = new Date().toISOString();
      return store;
    }).then((store) => store.sessions[clientId]);
  }

  async function createTask(session, payload) {
    const taskId = crypto.randomUUID();
    const now = new Date().toISOString();
    await queueWrite((store) => {
      store.tasks[taskId] = {
        id: taskId,
        sessionId: session.clientId,
        status: "queued",
        createdAt: now,
        updatedAt: now,
        payload,
        response: null,
        error: null,
      };

      const taskEntries = Object.entries(store.tasks).sort(
        (a, b) => new Date(b[1].updatedAt).getTime() - new Date(a[1].updatedAt).getTime(),
      );
      taskEntries.slice(maxTasks).forEach(([id]) => {
        delete store.tasks[id];
      });

      return store;
    });
    return {
      id: taskId,
      sessionId: session.clientId,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      payload,
      response: null,
      error: null,
    };
  }

  async function updateTask(taskId, patch) {
    return queueWrite((store) => {
      const task = store.tasks[taskId];
      if (!task) throw new Error("Workflow task not found");
      Object.assign(task, patch, {
        updatedAt: new Date().toISOString(),
      });
      return store;
    }).then((store) => store.tasks[taskId]);
  }

  async function readTask(taskId) {
    const store = await loadStore();
    return store.tasks[taskId] || null;
  }

  async function listTasks(clientId, limit = 20) {
    const store = await loadStore();
    return Object.values(store.tasks)
      .filter((task) => task.sessionId === clientId)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, Math.max(1, Number(limit) || 20));
  }

  function summarizeSession(session) {
    return {
      clientId: session.clientId,
      token: session.token,
      tokenMasked: maskSecret(session.token),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      hasCustomConfig: Object.keys(session.config || {}).length > 0,
      configSummary: buildConfigSummary(session.config || {}),
    };
  }

  return {
    storePath,
    maskSecret,
    buildConfigSummary,
    normalizeSessionConfig,
    findSessionByToken,
    createOrReuseSession,
    touchSession,
    saveSessionConfig,
    clearSessionConfig,
    createTask,
    updateTask,
    readTask,
    listTasks,
    summarizeSession,
  };
}
