import fs from "node:fs";
import path from "node:path";

import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

const DEFAULT_BASE_URL = "http://47.243.99.2";
const DEFAULT_OUTPUT = path.join(process.env.USERPROFILE || process.env.HOME || ".", "Desktop", "Next-Chapter-Mobile-API.docx");
const PAGE_WIDTH = 12240;
const PAGE_HEIGHT = 15840;
const MARGIN = 1440;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const BORDER = { style: BorderStyle.SINGLE, size: 1, color: "D0D7DE" };
const BORDERS = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };

function readArg(flag, fallback = "") {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

function p(text, options = {}) {
  return new Paragraph({
    spacing: { after: options.after ?? 120 },
    heading: options.heading,
    alignment: options.alignment,
    children: [
      new TextRun({
        text,
        bold: options.bold,
        size: options.size ?? 22,
        font: options.font ?? "Arial",
      }),
    ],
  });
}

function codeBlock(text) {
  return new Paragraph({
    spacing: { after: 140 },
    shading: { fill: "F6F8FA" },
    border: {
      top: BORDER,
      bottom: BORDER,
      left: BORDER,
      right: BORDER,
    },
    children: [
      new TextRun({
        text,
        font: "Consolas",
        size: 20,
      }),
    ],
  });
}

function cell(text, width, options = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders: BORDERS,
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text,
            bold: options.bold,
            size: 21,
            font: "Arial",
          }),
        ],
      }),
    ],
  });
}

function endpointTable(rows) {
  const col1 = 2300;
  const col2 = 2800;
  const col3 = CONTENT_WIDTH - col1 - col2;
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: [col1, col2, col3],
    rows: [
      new TableRow({
        children: [
          cell("Method", col1, { bold: true }),
          cell("Path", col2, { bold: true }),
          cell("Purpose", col3, { bold: true }),
        ],
      }),
      ...rows.map((row) =>
        new TableRow({
          children: [cell(row.method, col1), cell(row.path, col2), cell(row.purpose, col3)],
        }),
      ),
    ],
  });
}

async function main() {
  const baseUrl = readArg("--base-url", DEFAULT_BASE_URL);
  const outputPath = readArg("--output", DEFAULT_OUTPUT);

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
            margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
          },
        },
        children: [
          p("Next Chapter Mobile Workflow API", {
            heading: HeadingLevel.TITLE,
            bold: true,
            size: 36,
            alignment: AlignmentType.CENTER,
            after: 220,
          }),
          p(`Base URL: ${baseUrl}`, {
            alignment: AlignmentType.CENTER,
            size: 22,
            after: 360,
          }),
          p("Overview", { heading: HeadingLevel.HEADING_1, bold: true, size: 30 }),
          p("This document exposes the mobile-facing HTTP API for the current project. The mobile app can either call the same provider proxy paths used by the WebUI, or use the unified workflow task API for stable asynchronous execution."),
          p("Authentication", { heading: HeadingLevel.HEADING_1, bold: true, size: 30 }),
          p("1. Call POST /api/workflow/session to create a workflow token."),
          p("2. Pass the token in the X-Workflow-Token header on every mobile request."),
          p("3. Do not place upstream provider keys in the app package."),
          p("Core Endpoints", { heading: HeadingLevel.HEADING_1, bold: true, size: 30 }),
          endpointTable([
            { method: "POST", path: "/api/workflow/session", purpose: "Create a mobile app session token." },
            { method: "GET", path: "/api/workflow/session", purpose: "Read the current session summary." },
            { method: "PUT", path: "/api/workflow/config", purpose: "Save per-user provider endpoints and API keys." },
            { method: "GET", path: "/api/workflow/config", purpose: "Read masked provider config summary." },
            { method: "POST", path: "/api/workflow/tasks", purpose: "Submit a text, image, video, or generic upstream task." },
            { method: "GET", path: "/api/workflow/tasks/{taskId}", purpose: "Query a single task result." },
            { method: "GET", path: "/api/workflow/tasks?limit=20", purpose: "List recent tasks for the current token." },
            { method: "POST", path: "/api/proxy/{provider}/...", purpose: "Raw proxy mode, closest to current WebUI behavior." },
            { method: "GET", path: "/healthz", purpose: "Health check." },
          ]),
          p("Raw Proxy Mode", { heading: HeadingLevel.HEADING_1, bold: true, size: 30 }),
          p("Use this mode when the mobile app already knows the exact upstream request format. The server injects the correct provider API key according to the workflow token."),
          p("Examples:", { bold: true }),
          p("POST /api/proxy/gpt/chat/completions"),
          p("POST /api/proxy/claude/chat/completions"),
          p("POST /api/proxy/gemini/models/gemini-3-pro:generateContent"),
          p("POST /api/proxy/seedream/models/{model}:generateImages"),
          p("POST /api/proxy/jimeng"),
          p("Unified Task API", { heading: HeadingLevel.HEADING_1, bold: true, size: 30 }),
          p("Use this mode when the mobile app needs stable asynchronous task semantics for text, image, and video generation."),
          p("Create Session Example", { heading: HeadingLevel.HEADING_2, bold: true, size: 26 }),
          codeBlock(`POST ${baseUrl}/api/workflow/session\n{}\n`),
          p("Save Provider Config Example", { heading: HeadingLevel.HEADING_2, bold: true, size: 26 }),
          codeBlock(`PUT ${baseUrl}/api/workflow/config\nX-Workflow-Token: wf_xxx\n{\n  "geminiEndpoint": "https://api.tu-zi.com/v1beta",\n  "geminiKey": "your-gemini-key",\n  "gptEndpoint": "https://api.tu-zi.com/v1",\n  "gptKey": "your-gpt-key",\n  "jimengEndpoint": "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",\n  "jimengKey": "your-jimeng-key"\n}`),
          p("Text Task Example", { heading: HeadingLevel.HEADING_2, bold: true, size: 26 }),
          codeBlock(`POST ${baseUrl}/api/workflow/tasks\nX-Workflow-Token: wf_xxx\n{\n  "provider": "gpt",\n  "method": "POST",\n  "path": "/chat/completions",\n  "body": {\n    "model": "gpt-5.4-mini",\n    "messages": [\n      { "role": "system", "content": "You are a helpful assistant." },\n      { "role": "user", "content": "Write a short trailer outline." }\n    ]\n  }\n}`),
          p("Image Task Example", { heading: HeadingLevel.HEADING_2, bold: true, size: 26 }),
          codeBlock(`POST ${baseUrl}/api/workflow/tasks\nX-Workflow-Token: wf_xxx\n{\n  "provider": "gpt",\n  "method": "POST",\n  "path": "/images/generations",\n  "body": {\n    "model": "gpt-image-2",\n    "prompt": "A cinematic poster, warm sunset, sci-fi city."\n  }\n}`),
          p("Video Task Example", { heading: HeadingLevel.HEADING_2, bold: true, size: 26 }),
          codeBlock(`POST ${baseUrl}/api/workflow/tasks\nX-Workflow-Token: wf_xxx\n{\n  "type": "video",\n  "provider": "jimeng",\n  "method": "POST",\n  "path": "",\n  "body": {\n    "model": "doubao-seedance-1-5-pro_720p",\n    "prompt": "A slow cinematic shot of a neon street after rain."\n  },\n  "poll": {\n    "pathTemplate": "/{task_id}",\n    "statusField": "status",\n    "completedStatuses": ["succeeded", "success", "completed", "done"],\n    "failedStatuses": ["failed", "error", "cancelled"],\n    "intervalMs": 5000,\n    "timeoutMs": 600000\n  }\n}`),
          p("Task Query Example", { heading: HeadingLevel.HEADING_2, bold: true, size: 26 }),
          codeBlock(`GET ${baseUrl}/api/workflow/tasks/{taskId}\nX-Workflow-Token: wf_xxx`),
          p("Integration Notes", { heading: HeadingLevel.HEADING_1, bold: true, size: 30 }),
          p("1. For mobile apps, prefer the unified task API when the request is long-running or needs result polling."),
          p("2. For requests that already match the WebUI upstream shape, use raw proxy mode."),
          p("3. The workflow token is the external access credential. Rotate or replace it if it is shared too broadly."),
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
