# Next Chapter Mobile Workflow API

Base URL:

- Production: `http://47.243.99.2`

Authentication:

- Create a workflow token with `POST /api/workflow/session`
- Pass the token in `X-Workflow-Token`
- Raw proxy requests may still work with server-side default keys, but mobile apps should always attach the workflow token for consistent behavior with WebUI sessions

## 1. Design Goal

This API layer is intended to let mobile apps reuse the same upstream model channels as the current WebUI:

- Text chat
- Image generation
- Video generation
- User-scoped provider configuration
- Async task submission and polling
- Raw proxy passthrough for WebUI-like requests
- Asset upload for image-to-image and image-to-video workflows

If the mobile app needs the closest behavior to WebUI, prefer `Raw Proxy Mode`.
If the mobile app needs a stable async contract, prefer `Unified Task API`.

## 2. Create Session

`POST /api/workflow/session`

Request body:

```json
{}
```

Response:

```json
{
  "session": {
    "clientId": "9c2b5a55-2d8a-4b30-8f24-5dc9f1f0a111",
    "token": "wf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "tokenMasked": "wf_x***xxxx",
    "cookieName": "workflow_token",
    "createdAt": "2026-05-06T10:00:00.000Z",
    "updatedAt": "2026-05-06T10:00:00.000Z",
    "hasCustomConfig": false,
    "baseUrl": "http://47.243.99.2",
    "configSummary": {}
  }
}
```

## 3. User Provider Config

### 3.1 Save Config

`PUT /api/workflow/config`

Headers:

- `X-Workflow-Token: wf_xxx`

Request body:

```json
{
  "geminiEndpoint": "https://api.tu-zi.com/v1beta",
  "geminiKey": "your-gemini-key",
  "gptEndpoint": "https://api.tu-zi.com/v1",
  "gptKey": "your-gpt-key",
  "claudeEndpoint": "https://api.tu-zi.com/v1",
  "claudeKey": "your-claude-key",
  "grokEndpoint": "https://api.tu-zi.com/v1",
  "grokKey": "your-grok-key",
  "seedreamEndpoint": "https://api.tu-zi.com/v1beta",
  "seedreamKey": "your-seedream-key",
  "jimengEndpoint": "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
  "jimengKey": "your-jimeng-key",
  "tuziEndpoint": "https://api.tuziapi.com",
  "tuziKey": "your-sora-key"
}
```

### 3.2 Read Config Summary

`GET /api/workflow/config`

### 3.3 Clear Config

`DELETE /api/workflow/config`

## 4. Asset Upload

This endpoint is recommended when the mobile app needs an HTTP-accessible image URL for:

- image-to-image
- image-to-video
- storyboard references
- reusable remote assets

### 4.1 Upload Asset

`POST /api/workflow/assets`

Headers:

- `X-Workflow-Token: wf_xxx`
- `Content-Type: application/json`

JSON example:

```json
{
  "folder": "references",
  "fileName": "hero-frame.png",
  "mimeType": "image/png",
  "dataUrl": "data:image/png;base64,iVBORw0KGgoAAA..."
}
```

Response:

```json
{
  "asset": {
    "id": "3c7ac98c-77e3-4483-a4a0-0c60b8f0f13d",
    "fileName": "hero-frame-3c7ac98c-77e3-4483-a4a0-0c60b8f0f13d.png",
    "mimeType": "image/png",
    "size": 283920,
    "url": "http://47.243.99.2/workflow-assets/9c2b5a55-2d8a-4b30-8f24-5dc9f1f0a111/references/hero-frame-3c7ac98c-77e3-4483-a4a0-0c60b8f0f13d.png",
    "relativePath": "references/hero-frame-3c7ac98c-77e3-4483-a4a0-0c60b8f0f13d.png"
  }
}
```

The returned `asset.url` can be passed into later image/video requests as `imageUrl`, `input_reference`, or provider-specific reference fields.

## 5. Raw Proxy Mode

This is the closest mode to the current WebUI. The server injects the correct upstream key based on the workflow token and provider configuration.

Headers:

- `X-Workflow-Token: wf_xxx`

Common routes:

- GPT text chat: `POST /api/proxy/gpt/v1/chat/completions`
- Claude text chat: `POST /api/proxy/claude/v1/messages`
- Grok text chat: `POST /api/proxy/grok/v1/chat/completions`
- Gemini text/image: `POST /api/proxy/gemini/v1beta/models/{model}:generateContent`
- Seedream image: `POST /api/proxy/seedream/v1beta/models/{model}:generateImages`
- Jimeng / Ark video: `POST /api/proxy/jimeng`
- Tuzi / Sora task submit: `POST /api/proxy/tuzi/doubao/api/v3/contents/generations/tasks`

### 5.1 Streaming

If the mobile app needs the same streaming behavior as WebUI text chat, use raw proxy mode directly against the upstream streaming route.

Examples:

- GPT/Grok stream: `POST /api/proxy/gpt/v1/chat/completions` with `"stream": true`
- Claude stream: `POST /api/proxy/claude/v1/messages` with provider-native streaming fields
- Gemini SSE stream: `POST /api/proxy/gemini/v1beta/models/{model}:streamGenerateContent?alt=sse`

## 6. Unified Task API

This is recommended for mobile clients that prefer a stable async task contract.

### 6.1 Create Task

`POST /api/workflow/tasks`

Headers:

- `X-Workflow-Token: wf_xxx`

### Text Example

```json
{
  "provider": "gpt",
  "method": "POST",
  "path": "/chat/completions",
  "body": {
    "model": "gpt-5.4-mini",
    "messages": [
      { "role": "system", "content": "You are a helpful assistant." },
      { "role": "user", "content": "Write a short trailer outline." }
    ]
  }
}
```

### Image Example

```json
{
  "provider": "seedream",
  "method": "POST",
  "path": "/v1beta/models/doubao-seedream-5-0-250821:generateImages",
  "body": {
    "prompt": "A cinematic poster, warm sunset, sci-fi city."
  }
}
```

### Video Example

```json
{
  "type": "video",
  "provider": "jimeng",
  "method": "POST",
  "path": "",
  "body": {
    "model": "doubao-seedance-1-5-pro_720p",
    "prompt": "A slow cinematic shot of a neon street after rain.",
    "imageUrl": "http://47.243.99.2/workflow-assets/.../references/hero-frame.png"
  },
  "poll": {
    "pathTemplate": "/{task_id}",
    "statusField": "status",
    "completedStatuses": ["succeeded", "success", "completed", "done"],
    "failedStatuses": ["failed", "error", "cancelled"],
    "intervalMs": 5000,
    "timeoutMs": 600000
  }
}
```

Response:

```json
{
  "task": {
    "id": "4e5547a9-277d-4fa3-bf22-86e95fc5ea5d",
    "status": "queued",
    "createdAt": "2026-05-06T10:05:00.000Z",
    "updatedAt": "2026-05-06T10:05:00.000Z",
    "payload": {},
    "remoteTaskId": null,
    "response": null,
    "error": null
  }
}
```

### 6.2 Query Task

`GET /api/workflow/tasks/{taskId}`

Headers:

- `X-Workflow-Token: wf_xxx`

Completed example:

```json
{
  "task": {
    "id": "4e5547a9-277d-4fa3-bf22-86e95fc5ea5d",
    "status": "completed",
    "createdAt": "2026-05-06T10:05:00.000Z",
    "updatedAt": "2026-05-06T10:06:12.000Z",
    "payload": {},
    "remoteTaskId": "upstream-task-123",
    "response": {
      "initial": {},
      "final": {}
    },
    "error": null
  }
}
```

### 6.3 Cancel Task

`DELETE /api/workflow/tasks/{taskId}`

Headers:

- `X-Workflow-Token: wf_xxx`

This will:

- cancel local polling
- mark the workflow task as `cancelled`
- try to forward an upstream cancel request for supported long-running video tasks

### 6.4 List Recent Tasks

`GET /api/workflow/tasks?limit=20`

## 7. Health Check

`GET /healthz`

Response:

```text
ok
```

## 8. WebUI Consistency Notes

What is already aligned with WebUI:

- same upstream provider families
- same raw proxy passthrough strategy
- same per-user provider config model
- same text/image/video task execution direction

What still differs from some desktop-only WebUI behavior:

- Electron local file storage paths are not exposed directly to mobile
- Dreamina CLI desktop execution is still a local desktop capability, not a public HTTP API mode
- WebUI-internal workflow actions are not all exposed as external mobile endpoints

## 9. Recommendations

- Use `Raw Proxy Mode` for text chat and any request that should behave exactly like WebUI
- Use `Unified Task API` for image/video tasks that need polling
- Upload reference images first with `POST /api/workflow/assets`, then pass the returned `asset.url`
- Keep `X-Workflow-Token` on every mobile request
- Do not expose upstream provider keys in the mobile app package
