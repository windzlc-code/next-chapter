# Next Chapter Mobile Workflow API

Base URL:

- Production: `http://47.243.99.2`

Authentication:

- Create a workflow token with `POST /api/workflow/session`
- Pass the token in `X-Workflow-Token`

## 1. Create Session

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

## 2. Save User Provider Config

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
  "jimengEndpoint": "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
  "jimengKey": "your-jimeng-key",
  "tuziEndpoint": "https://api.tuziapi.com",
  "tuziKey": "your-sora-key"
}
```

## 3. Raw Proxy Mode

This is the closest mode to the current WebUI.

Headers:

- `X-Workflow-Token: wf_xxx`

Examples:

- GPT text chat:
  `POST /api/proxy/gpt/v1/chat/completions`
- Claude text chat:
  `POST /api/proxy/claude/v1/messages`
- Gemini:
  `POST /api/proxy/gemini/v1beta/models/gemini-3-pro:generateContent`
- Seedream image:
  `POST /api/proxy/seedream/v1beta/models/{model}:generateImages`
- Seedance video:
  `POST /api/proxy/jimeng`

The server will inject the correct upstream API key based on the workflow token.

## 4. Unified Task API

This is recommended for mobile apps.

### 4.1 Create Task

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
  "provider": "gpt",
  "method": "POST",
  "path": "/images/generations",
  "body": {
    "model": "gpt-image-2",
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
    "prompt": "A slow cinematic shot of a neon street after rain."
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
    "response": null,
    "error": null
  }
}
```

### 4.2 Query Task

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
    "response": {
      "initial": {},
      "final": {}
    },
    "error": null
  }
}
```

### 4.3 List Recent Tasks

`GET /api/workflow/tasks?limit=20`

## 5. Health Check

`GET /healthz`

Response:

```text
ok
```

## Notes

- `X-Workflow-Token` is the external app access token. Do not expose upstream provider keys in the app.
- `Raw Proxy Mode` is best when the app already knows the exact upstream request shape.
- `Unified Task API` is better when the app needs a stable async task model for text, image, and video generation.
