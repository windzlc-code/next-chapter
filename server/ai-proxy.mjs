import http from "node:http";
import { Readable } from "node:stream";
import { URL } from "node:url";

const PORT = Number(process.env.AI_PROXY_PORT || 3001);
const HOST = process.env.AI_PROXY_HOST || "127.0.0.1";
const REQUEST_TIMEOUT_MS = Number(process.env.AI_PROXY_TIMEOUT_MS || 300000);

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
    endpoint: process.env.JIMENG_ENDPOINT || "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
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

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function toNodeStream(stream) {
  if (!stream) return null;
  return Readable.fromWeb(stream);
}

function buildUpstreamUrl(provider, requestUrl) {
  const target = PROVIDERS[provider];
  const base = String(target.endpoint || "").trim().replace(/\/+$/, "");
  const suffix = requestUrl.pathname.replace(/^\/api\/proxy\/[^/]+/, "");
  const path = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `${base}${path}${requestUrl.search || ""}`;
}

function buildUpstreamHeaders(req, provider) {
  const headers = {};
  for (const [rawKey, rawValue] of Object.entries(req.headers)) {
    const key = rawKey.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(key)) continue;
    if (key === "authorization") continue;
    if (typeof rawValue === "undefined") continue;
    headers[rawKey] = rawValue;
  }

  const { apiKey, authScheme } = PROVIDERS[provider];
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

const server = http.createServer(async (req, res) => {
  const method = String(req.method || "GET").toUpperCase();
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

  if (requestUrl.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }

  const match = requestUrl.pathname.match(/^\/api\/proxy\/([^/]+)(?:\/.*)?$/);
  if (!match) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const provider = match[1];
  if (!Object.prototype.hasOwnProperty.call(PROVIDERS, provider)) {
    sendJson(res, 400, { error: `Unsupported provider: ${provider}` });
    return;
  }

  if (!PROVIDERS[provider].apiKey) {
    sendJson(res, 503, { error: `Server API key not configured for provider: ${provider}` });
    return;
  }

  const upstreamUrl = buildUpstreamUrl(provider, requestUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const hasBody = !["GET", "HEAD"].includes(method);
    const upstream = await fetch(upstreamUrl, {
      method,
      headers: buildUpstreamHeaders(req, provider),
      body: hasBody ? req : undefined,
      duplex: hasBody ? "half" : undefined,
      signal: controller.signal,
      redirect: "manual",
    });

    res.statusCode = upstream.status;
    copyResponseHeaders(upstream, res);

    const responseBody = toNodeStream(upstream.body);
    if (!responseBody) {
      res.end();
      return;
    }

    responseBody.on("error", (error) => {
      if (!res.headersSent) {
        sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
      } else {
        res.destroy(error);
      }
    });
    responseBody.pipe(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) {
      sendJson(res, 502, { error: message });
    } else {
      res.end();
    }
  } finally {
    clearTimeout(timer);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[ai-proxy] listening on http://${HOST}:${PORT}`);
});
