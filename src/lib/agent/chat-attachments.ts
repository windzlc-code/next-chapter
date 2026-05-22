import { parseComplianceImportFile } from "@/lib/home-agent/compliance-workspace";
import type { ContentBlock, InputFileBlock, InputImageBlock, InputVideoBlock } from "./types";

export type ChatAttachmentKind = "image" | "video" | "document" | "text" | "binary";

export type ChatAttachmentWorkflowAction =
  | "generate_project_image"
  | "generate_video_reference_assets"
  | "generate_storyboard_frames"
  | "generate_video_assets"
  | "generate_segment_video"
  | "replace_segment_video";

export type ChatAttachmentRegenerateMode = "generate" | "redo-and-generate";

export interface ChatAttachmentVersion {
  id: string;
  fileName: string;
  label?: string;
  localPath?: string;
  previewUrl?: string;
  createdAt: string;
}

export interface ChatAttachmentGenerationContext {
  action: ChatAttachmentWorkflowAction;
  projectId?: string;
  targetId?: string;
  regenerateMode?: ChatAttachmentRegenerateMode;
}

export interface ChatAttachment {
  id: string;
  fileName: string;
  /** 素材库规范标签，如"角色 · 主角 · 版本01"，优先于 fileName 展示 */
  label?: string;
  mimeType: string;
  size: number;
  kind: ChatAttachmentKind;
  localPath?: string;
  base64?: string;
  extractedText?: string;
  previewUrl?: string;
  fallbackDigest?: string;
  /** 图片生成中占位符，尚未有真实 URL */
  pending?: boolean;
  cancelled?: boolean;
  /** 生成失败的占位符，保留卡片但显示失败原因 */
  failed?: boolean;
  failureReason?: string;
  /** 生成占位符的宽高比，如 "16:9"、"9:16"、"1:1" */
  aspectRatio?: string;
  history?: ChatAttachmentVersion[];
  generationContext?: ChatAttachmentGenerationContext;
}

export interface ModelInputCapabilities {
  supportsImageInput: boolean;
  supportsVideoInput: boolean;
  supportsGenericFileContext: boolean;
}

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "json",
  "yaml",
  "yml",
  "xml",
  "csv",
  "tsv",
  "log",
  "py",
  "ts",
  "tsx",
  "js",
  "jsx",
  "html",
  "css",
  "sql",
]);

const DOCUMENT_EXTENSIONS = new Set(["pdf", "docx", "xlsx", "xls", "doc", "csv"]);
const IMAGE_MIME_PREFIX = "image/";
const VIDEO_MIME_PREFIX = "video/";
const VIDEO_FRAME_PERCENTAGES = [0, 15, 30, 50, 70, 90];
const GENERIC_FILE_BASE64_LIMIT = 10 * 1024 * 1024;
const VIDEO_BASE64_LIMIT = 30 * 1024 * 1024;

function getExtension(fileName: string): string {
  const ext = fileName.split(".").pop()?.trim().toLowerCase();
  return ext || "";
}

function maybeGetFilePath(file: File): string | undefined {
  const localPath = (file as File & { path?: string }).path;
  return typeof localPath === "string" && localPath.trim() ? localPath : undefined;
}

function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType === "application/x-yaml"
  );
}

function classifyAttachmentKind(file: File): ChatAttachmentKind {
  const mimeType = String(file.type || "").toLowerCase();
  const extension = getExtension(file.name);

  if (mimeType.startsWith(IMAGE_MIME_PREFIX)) return "image";
  if (mimeType.startsWith(VIDEO_MIME_PREFIX)) return "video";
  if (TEXT_EXTENSIONS.has(extension) || isTextMimeType(mimeType)) return "text";
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
  return "binary";
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function fileToBase64(file: File): Promise<string> {
  return arrayBufferToBase64(await file.arrayBuffer());
}

function truncate(value: string, max = 12_000): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

function isLocalAttachmentPreviewPath(value: string | undefined): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  return value.startsWith("file://") || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function toRenderableLocalAttachmentPreviewUrl(localPath: string | undefined): string | undefined {
  if (!isLocalAttachmentPreviewPath(localPath)) return undefined;
  if (!localPath) return undefined;
  if (localPath.startsWith("file://")) return localPath;
  if (/^\\\\/.test(localPath)) {
    return `file:${localPath.replace(/\\/g, "/")}`;
  }
  return `file:///${localPath.replace(/\\/g, "/")}`;
}

export function resolvePersistedAttachmentPreviewUrl(
  attachment: Pick<ChatAttachment, "kind" | "localPath" | "previewUrl">,
): string | undefined {
  const previewUrl =
    typeof attachment.previewUrl === "string" && attachment.previewUrl.trim()
      ? attachment.previewUrl
      : undefined;
  const localPreviewUrl =
    attachment.kind === "image" || attachment.kind === "video"
      ? toRenderableLocalAttachmentPreviewUrl(attachment.localPath)
      : undefined;

  if (!previewUrl) {
    return localPreviewUrl;
  }

  if (previewUrl.startsWith("data:")) {
    return localPreviewUrl ?? previewUrl;
  }

  return previewUrl;
}

export function inferModelInputCapabilities(params: {
  provider?: string;
  model?: string;
}): ModelInputCapabilities {
  const provider = String(params.provider || "").toLowerCase();
  const model = String(params.model || "").toLowerCase();
  const resolvedProvider =
    provider ||
    (model.startsWith("gemini-")
      ? "gemini"
      : model.startsWith("claude-")
        ? "claude"
        : model.startsWith("gpt-")
          ? "gpt"
          : model.startsWith("grok-")
            ? "grok"
            : "");

  switch (resolvedProvider) {
    case "gemini":
      return {
        supportsImageInput: true,
        supportsVideoInput: true,
        supportsGenericFileContext: true,
      };
    case "claude":
      return {
        supportsImageInput: true,
        supportsVideoInput: false,
        supportsGenericFileContext: false,
      };
    default:
      return {
        supportsImageInput: false,
        supportsVideoInput: false,
        supportsGenericFileContext: false,
      };
  }
}

export function buildAttachmentFallbackDigest(file: File, localPath?: string): string {
  const extension = getExtension(file.name);
  const modifiedAt = Number.isFinite(file.lastModified) && file.lastModified > 0
    ? new Date(file.lastModified).toISOString()
    : "unknown";

  return [
    `文件名: ${file.name}`,
    `MIME: ${file.type || "application/octet-stream"}`,
    `大小: ${file.size} bytes`,
    `扩展名: ${extension || "(none)"}`,
    `修改时间: ${modifiedAt}`,
    ...(localPath ? [`本地路径: ${localPath}`] : []),
  ].join("\n");
}

async function extractTextContent(file: File, kind: ChatAttachmentKind): Promise<string | undefined> {
  try {
    if (kind === "text") {
      return truncate(await file.text());
    }

    if (kind === "document") {
      const parsed = await parseComplianceImportFile(file);
      return truncate(parsed.sourceText);
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export async function prepareChatAttachment(file: File): Promise<ChatAttachment> {
  const kind = classifyAttachmentKind(file);
  const localPath = maybeGetFilePath(file);
  const mimeType = String(file.type || "").toLowerCase();
  const previewUrl =
    kind === "image" || kind === "video" || mimeType.startsWith("audio/")
      ? URL.createObjectURL(file)
      : undefined;

  const shouldInlineBase64 =
    kind === "image" ||
    (kind === "video" && file.size <= VIDEO_BASE64_LIMIT) ||
    ((kind === "document" || kind === "binary") && file.size <= GENERIC_FILE_BASE64_LIMIT);

  const [extractedText, base64] = await Promise.all([
    extractTextContent(file, kind),
    shouldInlineBase64 ? fileToBase64(file).catch(() => undefined) : Promise.resolve(undefined),
  ]);

  const fallbackDigest = buildAttachmentFallbackDigest(file, localPath);

  return {
    id: crypto.randomUUID(),
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    kind,
    localPath,
    base64,
    extractedText,
    previewUrl,
    fallbackDigest,
  };
}

export async function prepareChatAttachments(files: File[]): Promise<ChatAttachment[]> {
  return Promise.all(files.map((file) => prepareChatAttachment(file)));
}

export function stripAttachmentPayloadForHistory(attachment: ChatAttachment): ChatAttachment {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    label: attachment.label,
    mimeType: attachment.mimeType,
    size: attachment.size,
    kind: attachment.kind,
    localPath: attachment.localPath,
    previewUrl: resolvePersistedAttachmentPreviewUrl(attachment),
    extractedText: attachment.extractedText ? truncate(attachment.extractedText, 4_000) : undefined,
    fallbackDigest: attachment.fallbackDigest,
    history: attachment.history?.map((entry) => ({
      id: entry.id,
      fileName: entry.fileName,
      label: entry.label,
      localPath: entry.localPath,
      previewUrl: resolvePersistedAttachmentPreviewUrl({
        kind: attachment.kind,
        localPath: entry.localPath,
        previewUrl: entry.previewUrl,
      }),
      createdAt: entry.createdAt,
    })),
    generationContext: attachment.generationContext
      ? {
          action: attachment.generationContext.action,
          projectId: attachment.generationContext.projectId,
          targetId: attachment.generationContext.targetId,
          regenerateMode: attachment.generationContext.regenerateMode,
        }
      : undefined,
  };
}

function buildFileContextText(attachment: ChatAttachment): string {
  const sections = [
    `附件: ${attachment.fileName}`,
    `类型: ${attachment.mimeType}`,
    `大小: ${attachment.size} bytes`,
  ];

  if (attachment.extractedText?.trim()) {
    sections.push(`提取文本:\n${truncate(attachment.extractedText, 8_000)}`);
  } else if (attachment.fallbackDigest?.trim()) {
    sections.push(`元信息摘要:\n${attachment.fallbackDigest}`);
  }

  return sections.join("\n");
}

async function buildVideoFallbackBlocks(attachment: ChatAttachment): Promise<ContentBlock[]> {
  const localPath = attachment.localPath;
  const extractFrames = window.electronAPI?.media?.extractVideoFrames;
  const readBase64 = window.electronAPI?.storage?.readBase64;

  if (!localPath || !extractFrames || !readBase64) {
    return [
      {
        type: "input_file",
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
        size: attachment.size,
        localPath: attachment.localPath,
        fallbackDigest:
          attachment.fallbackDigest ||
          `视频 ${attachment.fileName} 当前无法原生读取，仅能基于文件元信息判断。`,
      } satisfies InputFileBlock,
    ];
  }

  try {
    const result = await extractFrames({
      filePath: localPath,
      framePercents: VIDEO_FRAME_PERCENTAGES,
    });
    if (!result?.ok || !result.framePaths?.length) {
      throw new Error(result?.error || "no frames extracted");
    }

    const frameBlocks = await Promise.all(
      result.framePaths.map(async (framePath) => {
        const base64Result = await readBase64(framePath);
        if (!base64Result?.ok || !base64Result.exists || !base64Result.base64) {
          return null;
        }
        return {
          type: "input_image",
          fileName: `${attachment.fileName} frame`,
          mimeType: base64Result.mimeType || "image/jpeg",
          base64: base64Result.base64,
          localPath: framePath,
        } satisfies InputImageBlock;
      }),
    );

    const validFrames = frameBlocks.filter(Boolean) as InputImageBlock[];
    if (!validFrames.length) {
      throw new Error("frames extracted but could not be read");
    }

    return [
      {
        type: "text",
        text: `视频 ${attachment.fileName} 已回退为关键帧图像输入，因为当前模型或通道不支持原生视频输入。`,
      },
      ...validFrames,
    ];
  } catch {
    return [
      {
        type: "input_file",
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
        size: attachment.size,
        localPath: attachment.localPath,
        fallbackDigest:
          attachment.fallbackDigest ||
          `视频 ${attachment.fileName} 当前无法原生读取，也无法完成抽帧，仅能基于元信息判断。`,
      } satisfies InputFileBlock,
    ];
  }
}

export async function buildMessageInputFromAttachments(params: {
  prompt: string;
  attachments: ChatAttachment[];
  capabilities: ModelInputCapabilities;
}): Promise<ContentBlock[]> {
  const { prompt, attachments, capabilities } = params;
  const normalizedPrompt = prompt.trim() || "请先分析这些附件内容，并给出当前最合适的下一步建议。";
  const blocks: ContentBlock[] = [{ type: "text", text: normalizedPrompt }];

  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      if (capabilities.supportsImageInput && attachment.base64) {
        blocks.push({
          type: "input_image",
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          base64: attachment.base64,
          localPath: attachment.localPath,
          previewUrl: attachment.previewUrl,
          alt: attachment.fileName,
        } satisfies InputImageBlock);
      } else {
        blocks.push({ type: "text", text: buildFileContextText(attachment) });
      }
      continue;
    }

    if (attachment.kind === "video") {
      if (capabilities.supportsVideoInput && attachment.base64) {
        blocks.push({
          type: "input_video",
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          base64: attachment.base64,
          localPath: attachment.localPath,
          previewUrl: attachment.previewUrl,
          fallbackText: attachment.fallbackDigest,
        } satisfies InputVideoBlock);
      } else {
        blocks.push(...(await buildVideoFallbackBlocks(attachment)));
      }
      continue;
    }

    blocks.push({
      type: "input_file",
      mimeType: attachment.mimeType,
      fileName: attachment.fileName,
      size: attachment.size,
      extension: getExtension(attachment.fileName),
      base64: capabilities.supportsGenericFileContext ? attachment.base64 : undefined,
      localPath: attachment.localPath,
      extractedText: attachment.extractedText,
      fallbackDigest: attachment.fallbackDigest,
    } satisfies InputFileBlock);
  }

  return blocks;
}
