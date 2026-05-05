import http from "node:http";
import { Readable } from "node:stream";
import { URL } from "node:url";

import { createWorkflowStore } from "./workflow-store.mjs";

const PORT = Number(process.env.AI_PROXY_PORT || 3001);
const HOST = process.env.AI_PROXY_HOST || "127.0.0.1";
const REQUEST_TIMEOUT_MS = Number(process.env.AI_PROXY_TIMEOUT_MS || 300000);
const WORKFLOW_COOKIE_NAME = process.env.WORKFLOW_COOKIE_NAME || "workflow_token";
const WORKFLOW_TASK_TIMEOUT_MS = Number(process.env.WORKFLOW_TASK_TIMEOUT_MS || 900000);
const WORKFLOW_STORE = createWorkflowStore({
  storePath: process.env.WORKFLOW_STORE_PATH,
  maxTasks: Number(process.env.WORKFLOW_MAX_TASKS || 500),
});

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-workflow-token",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
};

const PROVIDERS = {
  gemini: {
    endpoint: process.env.GEMINI_ENDPOINT || "https://api.tu-zi.com/v1beta",
    apiKey: process.env.GEMINI_API_KEY || "",
    authScheme: "Bearer",
  },
  gpt: {
    endpoint: process.env.GPT_ENDPOINT || "https://api.tu-zi.com/v1",
    apiKey: process.env.GPT_API_KEY || process.env.GEMINI_API_KEY || "",
    authScheme: "Bearer",
  },
  claude: {
    endpoint: process.env.CLAUDE_ENDPOINT || "https://api.tu-zi.com/v1",
    apiKey: process.env.CLAUDE_API_KEY || process.env.GEMINI_API_KEY || "",
    authScheme: "Bearer",
  },
  grok: {
    endpoint: process.env.GROK_ENDPOINT || "https://api.tu-zi.com/v1",
    apiKey: process.env.GROK_API_KEY || process.env.GEMINI_API_KEY || "",
    authScheme: "Bearer",
  },
  seedream: {
    endpoint: process.env.SEEDREAM_ENDPOINT || "https://api.tu-zi.com/v1beta",
    apiKey: process.env.SEEDREAM_API_KEY || process.env.GEMINI_API_KEY || "",
    authScheme: "Bearer",
  },
  jimeng: {
    endpoint:
      process.env.JIMENG_ENDPOINT ||
      "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
    apiKey: process.env.JIMENG_API_KEY || process.env.GEMINI_API_KEY || "",
    authScheme: "Bearer",
  },
  tuzi: {
    endpoint: process.env.TUZI_ENDPOINT || "https://api.tuziapi.com",
    apiKey: process.env.TUZI_API_KEY || "",
    authScheme: "Bearer",
  },
};

const HOP_BY_HOP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

const PROVIDER_FIELD_MAP = {
  gemini: { endpoint: "geminiEndpoint", apiKey: "geminiKey" },
  gpt: { endpoint: "gptEndpoint", apiKey: "gptKey" },
  claude: { endpoint: "claudeEndpoint", apiKey: "claudeKey" },
  grok: { endpoint: "grokEndpoint", apiKey: "grokKey" },
  seedream: { endpoint: "seedreamEndpoint", apiKey: "seedreamKey" },
  jimeng: { endpoint: "jimengEndpoint", apiKey: "jimengKey" },
  tuzi: { endpoint: "tuziEndpoint", apiKey: "tuziKey" },
};

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, statusCode, text, extraHeaders = {}) {
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

function toNodeStream(stream) {
  if (!stream) return null;
  return Readable.fromWeb(stream);
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || "");
  return raw.split(";").reduce((acc, entry) => {
    const [name, ...rest] = entry.trim().split("=");
    if (!name) return acc;
    acc[name] = decodeURIComponent(rest.join("=") || "");
    return acc;
  }, {});
}

function resolveWorkflowToken(req) {
  const headerValue = String(req.headers["x-workflow-token"] || "").trim();
  if (headerValue) return headerValue;
  const cookies = parseCookies(req);
  return String(cookies[WORKFLOW_COOKIE_NAME] || "").trim();
}

function buildCookie(token) {
  return `${WORKFLOW_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
}

function sanitizeHeaders(rawHeaders) {
  const headers = {};
  for (const [key, value] of Object.entries(rawHeaders || {})) {
    const normalizedKey = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalizedKey)) continue;
    if (normalizedKey === "authorization") continue;
    if (normalizedKey === "cookie") continue;
    if (typeof value === "undefined") continue;
    headers[key] = value;
  }
  return headers;
}

function trimTrailingSlash(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function isArkJimengEndpoint(value) {
  const endpoint = trimTrailingSlash(value);
  if (!endpoint) return false;
  return (
    /\/contents\/generations\/tasks$/i.test(endpoint) ||
    /\/api\/v3$/i.test(endpoint) ||
    /ark\.cn-beijing\.volces\.com/i.test(endpoint)
  );
}

function resolveProviderTarget(provider, session) {
  const base = PROVIDERS[provider];
  const fields = PROVIDER_FIELD_MAP[provider];
  const config = session?.config || {};
  const geminiEndpoint = String(config.geminiEndpoint || "").trim() || PROVIDERS.gemini.endpoint;
  const geminiKey = String(config.geminiKey || "").trim() || PROVIDERS.gemini.apiKey;
  const endpoint =
    String(config[fields.endpoint] || "").trim() ||
    (provider === "gemini" ? geminiEndpoint : geminiEndpoint || base.endpoint) ||
    base.endpoint;
  let apiKey = String(config[fields.apiKey] || "").trim();

  if (!apiKey) {
    if (provider === "jimeng" && isArkJimengEndpoint(endpoint)) {
      apiKey = base.apiKey;
    } else {
      apiKey = geminiKey || base.apiKey;
    }
  }

  return {
    endpoint,
    apiKey,
    authScheme: base.authScheme,
  };
}

function buildUpstreamUrl(baseEndpoint, pathName = "", search = "") {
  const trimmedBase = trimTrailingSlash(baseEndpoint);
  const suffix = String(pathName || "").trim();
  if (!suffix) {
    return `${trimmedBase}${search || ""}`;
  }
  if (/^https?:\/\//i.test(suffix)) {
    return suffix;
  }
  const normalizedPath = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `${trimmedBase}${normalizedPath}${search || ""}`;
}

function buildProxyUpstreamUrl(provider, requestUrl, session) {
  const target = resolveProviderTarget(provider, session);
  const suffix = requestUrl.pathname.replace(/^\/api\/proxy\/[^/]+/, "");
  const pathName = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return {
    target,
    url: buildUpstreamUrl(target.endpoint, pathName, requestUrl.search || ""),
  };
}

function buildUpstreamHeaders(req, provider, session) {
  const headers = sanitizeHeaders(req.headers);
  const { apiKey, authScheme } = resolveProviderTarget(provider, session);
  if (apiKey) {
    headers.Authorization = `${authScheme} ${apiKey}`;
  }
  return headers;
}

function copyResponseHeaders(upstream, res) {
  for (const [key, value] of upstream.headers.entries()) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    if (key.toLowerCase() === "content-length") continue;
    res.setHeader(key, value);
  }
}

function buildPublicBaseUrl(req) {
  const protocol = String(req.headers["x-forwarded-proto"] || "http");
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "127.0.0.1");
  return `${protocol}://${host}`;
}

async function readRequestBody(req, options = {}) {
  const limit = Number(options.limit || 5 * 1024 * 1024);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new Error("Request body too large");
    }
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (contentType.includes("application/json")) {
    if (!buffer.length) return {};
    return JSON.parse(buffer.toString("utf8"));
  }
  if (contentType.startsWith("text/")) {
    return buffer.toString("utf8");
  }
  return buffer;
}

function buildTaskPayloadBody(payload, headers) {
  if (payload === undefined || payload === null) {
    return undefined;
  }
  if (Buffer.isBuffer(payload) || payload instanceof Uint8Array) {
    return payload;
  }
  if (typeof payload === "string") {
    return payload;
  }
  if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
    headers["content-type"] = "application/json; charset=utf-8";
  }
  return JSON.stringify(payload);
}

async function parseUpstreamBody(response) {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return await response.text();
    }
  }
  return await response.text();
}

function toSerializableHeaders(headers) {
  const next = {};
  for (const [key, value] of headers.entries()) {
    next[key] = value;
  }
  return next;
}

async function performWorkflowRequest(session, requestSpec) {
  const provider = String(requestSpec.provider || "").trim();
  if (!PROVIDERS[provider]) {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  const target = resolveProviderTarget(provider, session);
  if (!target.apiKey) {
    throw new Error(`No API key configured for provider: ${provider}`);
  }

  const headers = sanitizeHeaders(requestSpec.headers);
  headers.Authorization = `${target.authScheme} ${target.apiKey}`;
  const method = String(requestSpec.method || "POST").toUpperCase();
  const query =
    requestSpec.query && typeof requestSpec.query === "object"
      ? new URLSearchParams(
          Object.entries(requestSpec.query).reduce((acc, [key, value]) => {
            if (value === undefined || value === null) return acc;
            acc[key] = String(value);
            return acc;
          }, {}),
        ).toString()
      : "";
  const url = buildUpstreamUrl(target.endpoint, requestSpec.path || "", query ? `?${query}` : "");
  const controller = new AbortController();
  const timeoutMs = Number(requestSpec.timeoutMs || REQUEST_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: ["GET", "HEAD"].includes(method)
        ? undefined
        : buildTaskPayloadBody(requestSpec.body, headers),
      signal: controller.signal,
      redirect: "manual",
    });
    const body = await parseUpstreamBody(response);
    const summary = {
      request: {
        provider,
        method,
        url,
      },
      response: {
        status: response.status,
        ok: response.ok,
        headers: toSerializableHeaders(response.headers),
        body,
      },
    };

    if (!response.ok) {
      const error = new Error(`Upstream request failed with status ${response.status}`);
      error.summary = summary;
      throw error;
    }

    return summary;
  } finally {
    clearTimeout(timer);
  }
}

function readNestedValue(input, pathName) {
  const path = String(pathName || "").trim();
  if (!path) return undefined;
  return path.split(".").reduce((acc, key) => {
    if (!acc || typeof acc !== "object") return undefined;
    return acc[key];
  }, input);
}

function buildDefaultPollSpec(payload) {
  if (payload?.type !== "video" || payload?.wait === false) {
    return null;
  }
  return {
    pathTemplate: "/{task_id}",
    intervalMs: 5000,
    timeoutMs: 600000,
    statusField: "status",
    completedStatuses: ["succeeded", "success", "completed", "done"],
    failedStatuses: ["failed", "error", "cancelled"],
  };
}

function renderTemplate(template, values) {
  return String(template || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => String(values[key] || ""));
}

async function maybePollWorkflowRequest(session, payload, initialResult) {
  const poll = payload?.poll || buildDefaultPollSpec(payload);
  if (!poll) return { final: initialResult };

  const responseBody = initialResult?.response?.body;
  const taskId = String(responseBody?.task_id || responseBody?.id || "").trim();
  if (!taskId) {
    throw new Error("Polling was requested, but the upstream response did not include task_id");
  }

  const completedStatuses = new Set(
    (Array.isArray(poll.completedStatuses) ? poll.completedStatuses : ["succeeded", "success", "completed", "done"])
      .map((value) => String(value).toLowerCase()),
  );
  const failedStatuses = new Set(
    (Array.isArray(poll.failedStatuses) ? poll.failedStatuses : ["failed", "error", "cancelled"])
      .map((value) => String(value).toLowerCase()),
  );
  const statusField = String(poll.statusField || "status");
  const intervalMs = Math.max(1000, Number(poll.intervalMs || 5000));
  const timeoutMs = Math.max(intervalMs, Number(poll.timeoutMs || WORKFLOW_TASK_TIMEOUT_MS));
  const startedAt = Date.now();
  let latest = initialResult;

  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    latest = await performWorkflowRequest(session, {
      provider: payload.provider,
      method: poll.method || "GET",
      path: renderTemplate(poll.pathTemplate || "/{task_id}", {
        task_id: taskId,
        id: taskId,
      }),
      query: poll.query,
      headers: poll.headers,
      body: poll.body,
      timeoutMs: poll.requestTimeoutMs,
    });
    const statusValue = String(readNestedValue(latest.response.body, statusField) || "").trim().toLowerCase();
    if (completedStatuses.has(statusValue)) {
      return { initial: initialResult, final: latest };
    }
    if (failedStatuses.has(statusValue)) {
      const error = new Error(`Workflow polling ended with status: ${statusValue}`);
      error.summary = { initial: initialResult, final: latest };
      throw error;
    }
  }

  const timeoutError = new Error("Workflow polling timed out");
  timeoutError.summary = { initial: initialResult, final: latest };
  throw timeoutError;
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      message: error.message,
      summary: error.summary || null,
    };
  }
  return {
    message: String(error),
    summary: null,
  };
}

function sanitizeTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    payload: task.payload,
    response: task.response,
    error: task.error,
  };
}

async function resolveWorkflowSession(req) {
  const token = resolveWorkflowToken(req);
  if (!token) return null;
  const session = await WORKFLOW_STORE.findSessionByToken(token);
  if (session) {
    await WORKFLOW_STORE.touchSession(session.clientId);
  }
  return session;
}

async function requireWorkflowSession(req, res) {
  const session = await resolveWorkflowSession(req);
  if (!session) {
    sendJson(res, 401, {
      error: "Workflow session not found. Create one with POST /api/workflow/session first.",
    });
    return null;
  }
  return session;
}

async function handleWorkflowApi(req, res, requestUrl) {
  if (req.method === "OPTIONS") {
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (requestUrl.pathname === "/api/workflow/session" && req.method === "POST") {
    const session = await WORKFLOW_STORE.createOrReuseSession(resolveWorkflowToken(req));
    sendJson(
      res,
      201,
      {
        session: {
          ...WORKFLOW_STORE.summarizeSession(session),
          cookieName: WORKFLOW_COOKIE_NAME,
          baseUrl: buildPublicBaseUrl(req),
        },
      },
      {
        "set-cookie": buildCookie(session.token),
      },
    );
    return true;
  }

  if (requestUrl.pathname === "/api/workflow/session" && req.method === "GET") {
    const session = await resolveWorkflowSession(req);
    if (!session) {
      sendJson(res, 404, { session: null });
      return true;
    }
    sendJson(res, 200, {
      session: {
        ...WORKFLOW_STORE.summarizeSession(session),
        cookieName: WORKFLOW_COOKIE_NAME,
        baseUrl: buildPublicBaseUrl(req),
      },
    });
    return true;
  }

  if (requestUrl.pathname === "/api/workflow/config") {
    const session = await requireWorkflowSession(req, res);
    if (!session) return true;

    if (req.method === "GET") {
      sendJson(res, 200, {
        config: WORKFLOW_STORE.summarizeSession(session).configSummary,
      });
      return true;
    }

    if (req.method === "PUT") {
      const payload = await readRequestBody(req);
      const updated = await WORKFLOW_STORE.saveSessionConfig(session.clientId, payload);
      sendJson(res, 200, {
        session: {
          ...WORKFLOW_STORE.summarizeSession(updated),
          cookieName: WORKFLOW_COOKIE_NAME,
          baseUrl: buildPublicBaseUrl(req),
        },
      });
      return true;
    }

    if (req.method === "DELETE") {
      const updated = await WORKFLOW_STORE.clearSessionConfig(session.clientId);
      sendJson(res, 200, {
        session: {
          ...WORKFLOW_STORE.summarizeSession(updated),
          cookieName: WORKFLOW_COOKIE_NAME,
          baseUrl: buildPublicBaseUrl(req),
        },
      });
      return true;
    }
  }

  if (requestUrl.pathname === "/api/workflow/tasks" && req.method === "GET") {
    const session = await requireWorkflowSession(req, res);
    if (!session) return true;
    const limit = Number(requestUrl.searchParams.get("limit") || 20);
    const tasks = await WORKFLOW_STORE.listTasks(session.clientId, limit);
    sendJson(res, 200, { tasks: tasks.map(sanitizeTask) });
    return true;
  }

  if (requestUrl.pathname === "/api/workflow/tasks" && req.method === "POST") {
    const session = await requireWorkflowSession(req, res);
    if (!session) return true;
    const payload = await readRequestBody(req);
    const task = await WORKFLOW_STORE.createTask(session, payload);
    void (async () => {
      try {
        await WORKFLOW_STORE.updateTask(task.id, { status: "running", error: null });
        const initialResult = await performWorkflowRequest(session, payload);
        const result = await maybePollWorkflowRequest(session, payload, initialResult);
        await WORKFLOW_STORE.updateTask(task.id, {
          status: "completed",
          response: result,
          error: null,
        });
      } catch (error) {
        await WORKFLOW_STORE.updateTask(task.id, {
          status: "failed",
          error: serializeError(error),
        });
      }
    })();
    sendJson(res, 202, { task: sanitizeTask(task) });
    return true;
  }

  const taskMatch = requestUrl.pathname.match(/^\/api\/workflow\/tasks\/([0-9a-f-]+)$/i);
  if (taskMatch && req.method === "GET") {
    const session = await requireWorkflowSession(req, res);
    if (!session) return true;
    const task = await WORKFLOW_STORE.readTask(taskMatch[1]);
    if (!task || task.sessionId !== session.clientId) {
      sendJson(res, 404, { error: "Workflow task not found" });
      return true;
    }
    sendJson(res, 200, { task: sanitizeTask(task) });
    return true;
  }

  return false;
}

async function handleProxy(req, res, requestUrl) {
  const match = requestUrl.pathname.match(/^\/api\/proxy\/([^/]+)(?:\/.*)?$/);
  if (!match) return false;

  const provider = match[1];
  if (!Object.prototype.hasOwnProperty.call(PROVIDERS, provider)) {
    sendJson(res, 400, { error: `Unsupported provider: ${provider}` });
    return true;
  }

  const session = await resolveWorkflowSession(req);
  const { target, url } = buildProxyUpstreamUrl(provider, requestUrl, session);
  if (!target.apiKey) {
    sendJson(res, 503, { error: `Server API key not configured for provider: ${provider}` });
    return true;
  }

  const method = String(req.method || "GET").toUpperCase();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const hasBody = !["GET", "HEAD"].includes(method);
    const upstream = await fetch(url, {
      method,
      headers: buildUpstreamHeaders(req, provider, session),
      body: hasBody ? req : undefined,
      duplex: hasBody ? "half" : undefined,
      signal: controller.signal,
      redirect: "manual",
    });

    res.statusCode = upstream.status;
    Object.entries(CORS_HEADERS).forEach(([key, value]) => res.setHeader(key, value));
    copyResponseHeaders(upstream, res);

    const responseBody = toNodeStream(upstream.body);
    if (!responseBody) {
      res.end();
      return true;
    }

    responseBody.on("error", (error) => {
      if (!res.headersSent) {
        sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
      } else {
        res.destroy(error);
      }
    });
    responseBody.pipe(res);
    return true;
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
    } else {
      res.end();
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

  try {
    if (requestUrl.pathname === "/healthz") {
      sendText(res, 200, "ok");
      return;
    }

    if (await handleWorkflowApi(req, res, requestUrl)) {
      return;
    }

    if (await handleProxy(req, res, requestUrl)) {
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[ai-proxy] listening on http://${HOST}:${PORT}`);
});
