import fs from "node:fs";
import path from "node:path";

import {
  AlignmentType,
  BorderStyle,
  Document,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

const DEFAULT_BASE_URL = "http://47.243.99.2";
const DEFAULT_OUTPUT = path.join(
  process.env.USERPROFILE || process.env.HOME || ".",
  "Desktop",
  "Next-Chapter-\u79fb\u52a8\u7aefAPI\u4e2d\u6587\u8bf4\u660e.docx",
);

const PAGE_WIDTH = 12240;
const PAGE_HEIGHT = 15840;
const MARGIN = 1440;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const FONT = "Microsoft YaHei";
const BORDER = { style: BorderStyle.SINGLE, size: 1, color: "D0D7DE" };
const BORDERS = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };

function readArg(flag, fallback = "") {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

function paragraph(text, options = {}) {
  return new Paragraph({
    alignment: options.alignment,
    spacing: {
      before: options.before ?? 0,
      after: options.after ?? 120,
    },
    children: [
      new TextRun({
        text,
        font: options.font ?? FONT,
        size: options.size ?? 22,
        bold: options.bold ?? false,
        color: options.color,
      }),
    ],
  });
}

function heading(text) {
  return paragraph(text, {
    size: 30,
    bold: true,
    before: 180,
    after: 120,
  });
}

function codeBlock(text) {
  return new Paragraph({
    spacing: { before: 40, after: 160 },
    shading: { fill: "F6F8FA", type: ShadingType.CLEAR },
    border: BORDERS,
    children: [
      new TextRun({
        text,
        font: "Consolas",
        size: 18,
      }),
    ],
  });
}

function tableCell(text, width, options = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders: BORDERS,
    shading: options.shading
      ? { fill: options.shading, type: ShadingType.CLEAR }
      : undefined,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [
      new Paragraph({
        spacing: { after: 0 },
        children: [
          new TextRun({
            text,
            font: FONT,
            size: 20,
            bold: options.bold ?? false,
            color: options.color,
          }),
        ],
      }),
    ],
  });
}

function endpointTable(rows) {
  const methodWidth = 1500;
  const pathWidth = 3800;
  const purposeWidth = CONTENT_WIDTH - methodWidth - pathWidth;
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: [methodWidth, pathWidth, purposeWidth],
    rows: [
      new TableRow({
        children: [
          tableCell("\u65b9\u6cd5", methodWidth, {
            bold: true,
            shading: "DCEAF7",
            color: "1F2937",
          }),
          tableCell("\u8def\u5f84", pathWidth, {
            bold: true,
            shading: "DCEAF7",
            color: "1F2937",
          }),
          tableCell("\u7528\u9014\u8bf4\u660e", purposeWidth, {
            bold: true,
            shading: "DCEAF7",
            color: "1F2937",
          }),
        ],
      }),
      ...rows.map((row) =>
        new TableRow({
          children: [
            tableCell(row.method, methodWidth),
            tableCell(row.path, pathWidth),
            tableCell(row.purpose, purposeWidth),
          ],
        }),
      ),
    ],
  });
}

async function main() {
  const baseUrl = readArg("--base-url", DEFAULT_BASE_URL);
  const outputPath = readArg("--output", DEFAULT_OUTPUT);

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: {
            font: FONT,
            size: 22,
          },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
            margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
          },
        },
        children: [
          paragraph("Next Chapter \u79fb\u52a8\u7aef API \u4e2d\u6587\u8bf4\u660e", {
            alignment: AlignmentType.CENTER,
            size: 36,
            bold: true,
            after: 180,
          }),
          paragraph(`\u516c\u7f51\u5730\u5740\uff1a${baseUrl}`, {
            alignment: AlignmentType.CENTER,
            size: 22,
            color: "374151",
            after: 320,
          }),

          heading("\u4e00\u3001\u6587\u6863\u76ee\u6807"),
          paragraph(
            "\u672c\u6587\u6863\u7528\u4e8e\u7ed9\u79fb\u52a8\u7aef App\u3001\u5916\u5305\u5f00\u53d1\u3001\u8054\u8c03\u4eba\u5458\u4f7f\u7528\uff0c\u76ee\u6807\u662f\u8ba9\u79fb\u52a8\u7aef\u53ef\u4ee5\u590d\u7528\u5f53\u524d WebUI \u5df2\u7ecf\u63a5\u901a\u7684\u6a21\u578b\u901a\u9053\u4e0e\u5de5\u4f5c\u6d41\u80fd\u529b\u3002",
          ),
          paragraph(
            "\u5f53\u524d\u5df2\u7ecf\u652f\u6301\uff1a\u4f1a\u8bdd token\u3001\u7528\u6237\u81ea\u5df1\u7684 provider \u914d\u7f6e\u3001\u539f\u59cb\u4ee3\u7406\u6a21\u5f0f\u3001\u7edf\u4e00\u4efb\u52a1\u6a21\u5f0f\u3001\u7d20\u6750\u4e0a\u4f20\u3001\u4efb\u52a1\u53d6\u6d88\u3001\u5065\u5eb7\u68c0\u67e5\u3002",
          ),

          heading("\u4e8c\u3001\u63a5\u5165\u5efa\u8bae"),
          paragraph("1. \u5982\u679c\u8981\u6700\u5927\u9650\u5ea6\u4fdd\u6301\u4e0e WebUI \u4e00\u81f4\uff0c\u4f18\u5148\u4f7f\u7528\u539f\u59cb\u4ee3\u7406\u6a21\u5f0f `/api/proxy/*`\u3002"),
          paragraph("2. \u5982\u679c\u66f4\u5173\u6ce8\u79fb\u52a8\u7aef\u7684\u7a33\u5b9a\u6027\u4e0e\u5f02\u6b65\u8f6e\u8be2\u4f53\u9a8c\uff0c\u4f18\u5148\u4f7f\u7528 `/api/workflow/tasks`\u3002"),
          paragraph("3. \u5982\u679c\u662f\u56fe\u751f\u56fe\u6216\u56fe\u751f\u89c6\u9891\u573a\u666f\uff0c\u5efa\u8bae\u5148\u4e0a\u4f20\u7d20\u6750\uff0c\u518d\u5728\u4efb\u52a1\u8bf7\u6c42\u91cc\u5f15\u7528 `asset.url`\u3002"),

          heading("\u4e09\u3001\u9274\u6743\u8bf4\u660e"),
          paragraph("1. \u5148\u8c03\u7528 `POST /api/workflow/session` \u521b\u5efa\u4f1a\u8bdd\u3002"),
          paragraph("2. \u670d\u52a1\u7aef\u4f1a\u8fd4\u56de workflow token\u3002"),
          paragraph("3. \u540e\u7eed\u8bf7\u6c42\u90fd\u5e26 `X-Workflow-Token: wf_xxx`\u3002"),
          paragraph("4. \u4e0d\u8981\u628a\u4e0a\u6e38\u771f\u5b9e API Key \u5199\u8fdb App \u5305\u4f53\uff0c\u7edf\u4e00\u901a\u8fc7\u672c\u670d\u52a1\u8f6c\u53d1\u3002"),

          heading("\u56db\u3001\u6838\u5fc3\u63a5\u53e3\u603b\u89c8"),
          endpointTable([
            { method: "POST", path: "/api/workflow/session", purpose: "\u521b\u5efa\u4f1a\u8bdd\u5e76\u83b7\u53d6 workflow token" },
            { method: "GET", path: "/api/workflow/session", purpose: "\u8bfb\u53d6\u5f53\u524d\u4f1a\u8bdd\u6458\u8981\u4fe1\u606f" },
            { method: "PUT", path: "/api/workflow/config", purpose: "\u4fdd\u5b58\u7528\u6237\u81ea\u5df1\u7684 provider endpoint \u548c key" },
            { method: "GET", path: "/api/workflow/config", purpose: "\u8bfb\u53d6 provider \u914d\u7f6e\u6458\u8981" },
            { method: "DELETE", path: "/api/workflow/config", purpose: "\u6e05\u7a7a\u5f53\u524d\u4f1a\u8bdd\u7684\u914d\u7f6e" },
            { method: "POST", path: "/api/workflow/assets", purpose: "\u4e0a\u4f20\u79fb\u52a8\u7aef\u7d20\u6750\uff0c\u8fd4\u56de\u53ef\u8bbf\u95ee\u7684 asset.url" },
            { method: "POST", path: "/api/workflow/tasks", purpose: "\u63d0\u4ea4\u6587\u672c\u3001\u751f\u56fe\u3001\u751f\u89c6\u9891\u7b49\u5f02\u6b65\u4efb\u52a1" },
            { method: "GET", path: "/api/workflow/tasks", purpose: "\u8bfb\u53d6\u5f53\u524d token \u4e0b\u7684\u4efb\u52a1\u5217\u8868" },
            { method: "GET", path: "/api/workflow/tasks/{taskId}", purpose: "\u67e5\u8be2\u5355\u4e2a\u4efb\u52a1\u72b6\u6001\u548c\u7ed3\u679c" },
            { method: "DELETE", path: "/api/workflow/tasks/{taskId}", purpose: "\u53d6\u6d88\u672c\u5730\u8f6e\u8be2\u4efb\u52a1\uff0c\u5e76\u5c1d\u8bd5\u53d6\u6d88\u4e0a\u6e38\u957f\u4efb\u52a1" },
            { method: "POST", path: "/api/proxy/{provider}/...", purpose: "\u539f\u59cb\u4ee3\u7406\u6a21\u5f0f\uff0c\u6700\u63a5\u8fd1 WebUI \u771f\u5b9e\u8c03\u7528" },
            { method: "GET", path: "/healthz", purpose: "\u5065\u5eb7\u68c0\u67e5" },
          ]),

          heading("\u4e94\u3001\u4f1a\u8bdd\u63a5\u53e3"),
          paragraph("\u63a5\u53e3\uff1aPOST /api/workflow/session", { bold: true, after: 60 }),
          codeBlock(`POST ${baseUrl}/api/workflow/session
Content-Type: application/json

{}`),
          paragraph("\u8fd4\u56de\u793a\u4f8b\uff1a", { bold: true, after: 60 }),
          codeBlock(`{
  "session": {
    "clientId": "9c2b5a55-2d8a-4b30-8f24-5dc9f1f0a111",
    "token": "wf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "tokenMasked": "wf_x***xxxx",
    "cookieName": "workflow_token",
    "createdAt": "2026-05-06T10:00:00.000Z",
    "updatedAt": "2026-05-06T10:00:00.000Z",
    "hasCustomConfig": false,
    "baseUrl": "${baseUrl}",
    "configSummary": {}
  }
}`),

          heading("\u516d\u3001\u7528\u6237\u81ea\u5b9a\u4e49\u901a\u9053\u914d\u7f6e"),
          paragraph("\u63a5\u53e3\uff1aPUT /api/workflow/config", { bold: true, after: 60 }),
          codeBlock(`PUT ${baseUrl}/api/workflow/config
Content-Type: application/json
X-Workflow-Token: wf_xxx

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
}`),
          paragraph("\u8bf4\u660e\uff1a\u79fb\u52a8\u7aef\u7528\u6237\u53ef\u4ee5\u628a\u81ea\u5df1\u7684\u5bf9\u8bdd\u3001\u751f\u56fe\u3001\u751f\u89c6\u9891\u901a\u9053\u5199\u5165\u4f1a\u8bdd\u7ea7\u522b\u914d\u7f6e\uff0c\u4e0d\u5f71\u54cd\u5176\u4ed6\u7528\u6237\u3002"),

          heading("\u4e03\u3001\u7d20\u6750\u4e0a\u4f20"),
          paragraph("\u63a5\u53e3\uff1aPOST /api/workflow/assets", { bold: true, after: 60 }),
          paragraph("\u9002\u7528\u573a\u666f\uff1a\u79fb\u52a8\u7aef\u9700\u8981\u5148\u4e0a\u4f20\u53c2\u8003\u56fe\uff0c\u7136\u540e\u628a\u8fd4\u56de\u7684 `asset.url` \u4f20\u7ed9\u751f\u56fe\u6216\u751f\u89c6\u9891\u63a5\u53e3\u3002"),
          codeBlock(`POST ${baseUrl}/api/workflow/assets
Content-Type: application/json
X-Workflow-Token: wf_xxx

{
  "folder": "references",
  "fileName": "hero-frame.png",
  "mimeType": "image/png",
  "dataUrl": "data:image/png;base64,iVBORw0KGgoAAA..."
}`),
          paragraph("\u8fd4\u56de\u793a\u4f8b\uff1a", { bold: true, after: 60 }),
          codeBlock(`{
  "asset": {
    "id": "3c7ac98c-77e3-4483-a4a0-0c60b8f0f13d",
    "fileName": "hero-frame-3c7ac98c-77e3-4483-a4a0-0c60b8f0f13d.png",
    "mimeType": "image/png",
    "size": 283920,
    "url": "${baseUrl}/workflow-assets/9c2b5a55-2d8a-4b30-8f24-5dc9f1f0a111/references/hero-frame-3c7ac98c-77e3-4483-a4a0-0c60b8f0f13d.png",
    "relativePath": "references/hero-frame-3c7ac98c-77e3-4483-a4a0-0c60b8f0f13d.png"
  }
}`),

          heading("\u516b\u3001\u539f\u59cb\u4ee3\u7406\u6a21\u5f0f"),
          paragraph("\u8fd9\u4e00\u6a21\u5f0f\u662f\u76ee\u524d\u4e0e WebUI \u6700\u4e00\u81f4\u7684\u63a5\u5165\u65b9\u5f0f\u3002\u670d\u52a1\u7aef\u4f1a\u6839\u636e workflow token \u548c provider \u914d\u7f6e\u81ea\u52a8\u6ce8\u5165\u4e0a\u6e38 key\u3002"),
          paragraph("\u5e38\u89c1\u4ee3\u7406\u8def\u5f84\uff1a", { bold: true, after: 60 }),
          paragraph("1. GPT \u5bf9\u8bdd\uff1aPOST /api/proxy/gpt/v1/chat/completions"),
          paragraph("2. Claude \u5bf9\u8bdd\uff1aPOST /api/proxy/claude/v1/messages"),
          paragraph("3. Grok \u5bf9\u8bdd\uff1aPOST /api/proxy/grok/v1/chat/completions"),
          paragraph("4. Gemini \u6587\u672c/\u56fe\u50cf\uff1aPOST /api/proxy/gemini/v1beta/models/{model}:generateContent"),
          paragraph("5. Seedream \u751f\u56fe\uff1aPOST /api/proxy/seedream/v1beta/models/{model}:generateImages"),
          paragraph("6. Jimeng / Ark \u751f\u89c6\u9891\uff1aPOST /api/proxy/jimeng"),
          paragraph("7. Tuzi / Sora 2 \u751f\u89c6\u9891\u4efb\u52a1\uff1aPOST /api/proxy/tuzi/doubao/api/v3/contents/generations/tasks"),
          paragraph("\u6d41\u5f0f\u5bf9\u8bdd\u8bf4\u660e\uff1a", { bold: true, after: 60 }),
          paragraph("1. GPT / Grok \u53ef\u4ee5\u76f4\u63a5\u8d70 chat completions\uff0cbody \u4e2d\u5e26 `stream: true`\u3002"),
          paragraph("2. Claude \u8d70 provider \u81ea\u5df1\u7684 streaming \u8bf7\u6c42\u5f62\u6001\u3002"),
          paragraph("3. Gemini SSE \u53ef\u4ee5\u8d70 `:streamGenerateContent?alt=sse`\u3002"),

          heading("\u4e5d\u3001\u7edf\u4e00\u4efb\u52a1\u63a5\u53e3"),
          paragraph("\u63a5\u53e3\uff1aPOST /api/workflow/tasks", { bold: true, after: 60 }),
          paragraph("\u8fd9\u4e00\u6a21\u5f0f\u9002\u5408\u79fb\u52a8\u7aef\u7684\u5f02\u6b65\u4efb\u52a1\u6d41\u3002\u63d0\u4ea4\u540e\u4f1a\u8fd4\u56de taskId\uff0cApp \u518d\u8f6e\u8be2\u4efb\u52a1\u72b6\u6001\u3002"),
          paragraph("1. \u6587\u672c\u4efb\u52a1\u793a\u4f8b", { bold: true, after: 60 }),
          codeBlock(`POST ${baseUrl}/api/workflow/tasks
Content-Type: application/json
X-Workflow-Token: wf_xxx

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
}`),
          paragraph("2. \u751f\u56fe\u4efb\u52a1\u793a\u4f8b", { bold: true, after: 60 }),
          codeBlock(`POST ${baseUrl}/api/workflow/tasks
Content-Type: application/json
X-Workflow-Token: wf_xxx

{
  "provider": "seedream",
  "method": "POST",
  "path": "/v1beta/models/doubao-seedream-5-0-250821:generateImages",
  "body": {
    "prompt": "A cinematic poster, warm sunset, sci-fi city."
  }
}`),
          paragraph("3. \u751f\u89c6\u9891\u4efb\u52a1\u793a\u4f8b", { bold: true, after: 60 }),
          codeBlock(`POST ${baseUrl}/api/workflow/tasks
Content-Type: application/json
X-Workflow-Token: wf_xxx

{
  "type": "video",
  "provider": "jimeng",
  "method": "POST",
  "path": "",
  "body": {
    "model": "doubao-seedance-1-5-pro_720p",
    "prompt": "A slow cinematic shot of a neon street after rain.",
    "imageUrl": "${baseUrl}/workflow-assets/.../references/hero-frame.png"
  },
  "poll": {
    "pathTemplate": "/{task_id}",
    "statusField": "status",
    "completedStatuses": ["succeeded", "success", "completed", "done"],
    "failedStatuses": ["failed", "error", "cancelled"],
    "intervalMs": 5000,
    "timeoutMs": 600000
  }
}`),

          heading("\u5341\u3001\u4efb\u52a1\u67e5\u8be2\u4e0e\u53d6\u6d88"),
          paragraph("\u67e5\u8be2\u63a5\u53e3\uff1aGET /api/workflow/tasks/{taskId}", { bold: true, after: 60 }),
          codeBlock(`GET ${baseUrl}/api/workflow/tasks/{taskId}
X-Workflow-Token: wf_xxx`),
          paragraph("\u53d6\u6d88\u63a5\u53e3\uff1aDELETE /api/workflow/tasks/{taskId}", { bold: true, after: 60 }),
          codeBlock(`DELETE ${baseUrl}/api/workflow/tasks/{taskId}
X-Workflow-Token: wf_xxx`),
          paragraph("\u53d6\u6d88\u80fd\u529b\u8bf4\u660e\uff1a\u8be5\u63a5\u53e3\u4f1a\u5148\u505c\u6b62\u672c\u5730 polling\uff0c\u7136\u540e\u5c1d\u8bd5\u5411\u4e0a\u6e38\u89c6\u9891\u4efb\u52a1\u53d1\u8d77 cancel \u8bf7\u6c42\u3002"),

          heading("\u5341\u4e00\u3001\u5065\u5eb7\u68c0\u67e5"),
          codeBlock(`GET ${baseUrl}/healthz

ok`),

          heading("\u5341\u4e8c\u3001\u4e0e WebUI \u7684\u4e00\u81f4\u6027\u8bf4\u660e"),
          paragraph("1. \u76ee\u524d\u5df2\u7ecf\u5bf9\u9f50\u7684\u662f\uff1aprovider \u901a\u9053\u3001\u539f\u59cb\u4ee3\u7406\u7b56\u7565\u3001\u7528\u6237\u914d\u7f6e\u6a21\u578b\u3001\u6587\u672c/\u56fe\u50cf/\u89c6\u9891\u4efb\u52a1\u65b9\u5411\u3002"),
          paragraph("2. \u79fb\u52a8\u7aef\u4e0d\u4f1a\u76f4\u63a5\u66b4\u9732 Electron \u672c\u5730\u8def\u5f84\uff0c\u800c\u662f\u4f7f\u7528 HTTP \u7d20\u6750 URL \u66ff\u4ee3\u3002"),
          paragraph("3. Dreamina CLI \u76ee\u524d\u4ecd\u7136\u662f\u684c\u9762\u7aef\u80fd\u529b\uff0c\u8fd8\u6ca1\u6709\u4f5c\u4e3a\u516c\u5171 HTTP \u6a21\u5f0f\u5bf9\u5916\u5f00\u653e\u3002"),
          paragraph("4. \u5982\u679c\u79fb\u52a8\u7aef\u60f3\u8981\u4e0e WebUI \u6700\u4e00\u81f4\uff0c\u6587\u672c\u5bf9\u8bdd\u548c streaming \u5efa\u8bae\u4f18\u5148\u8d70 `/api/proxy/*`\u3002"),

          heading("\u5341\u4e09\u3001\u5f53\u524d\u5efa\u8bae"),
          paragraph("1. \u5bf9\u8bdd\u529f\u80fd\uff1a\u4f18\u5148\u8d70 Raw Proxy Mode\u3002"),
          paragraph("2. \u751f\u56fe/\u751f\u89c6\u9891\uff1a\u5148\u4e0a\u4f20\u7d20\u6750\uff0c\u518d\u8d70 Unified Task API\u3002"),
          paragraph("3. \u6240\u6709\u79fb\u52a8\u7aef\u8bf7\u6c42\u90fd\u5e26 `X-Workflow-Token`\u3002"),
          paragraph("4. \u4e0d\u8981\u628a\u4e0a\u6e38 provider \u771f\u5b9e key \u4e0b\u53d1\u5230 App \u7aef\u3002"),
        ],
      },
    ],
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
  console.log(`Generated: ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
