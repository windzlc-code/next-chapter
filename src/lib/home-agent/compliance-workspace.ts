import { saveAs } from "file-saver";
import { generateId } from "@/lib/generate-id";
import {
  createEmptyComplianceWorkspace,
  type ComplianceReviewMode,
  type ComplianceRevisionPacket,
  type ComplianceRiskLevel,
  type ComplianceStrictness,
  type ComplianceWorkspace,
  type ComplianceWorkspaceModel,
  type ComplianceWorkspaceRiskPhrase,
  type ComplianceWorkspaceRiskSpan,
  type ComplianceWorkspaceTableSnapshot,
  type DramaProject,
} from "@/types/drama";

const DEFAULT_MODEL: ComplianceWorkspaceModel = "gemini-3.1-pro-preview";
const CJK_SEGMENT_LIMIT = 10_000;
const LATIN_SEGMENT_LIMIT = 25_000;

export const COMPLIANCE_MODEL_OPTIONS: Array<{ value: ComplianceWorkspaceModel; label: string }> = [
  { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
  { value: "gemini-3-pro-preview", label: "Gemini 3 Pro" },
  { value: "gemini-3-flash-preview", label: "Gemini 3 Flash" },
];

export const COMPLIANCE_STRICTNESS_CONFIG: Record<
  ComplianceStrictness,
  { label: string; desc: string; promptSuffix: string }
> = {
  standard: { label: "标准", desc: "常规合规检查", promptSuffix: "" },
  strict: {
    label: "严格",
    desc: "提高敏感度，标记更多潜在风险",
    promptSuffix: [
      "## 严格模式要求",
      "- 对任何可能引发争议的内容保持高度敏感",
      "- 即使是暗示性的违规内容也要标记",
      "- 对边缘案例采取保守态度，宁可错标也不漏标",
    ].join("\n"),
  },
  extreme: {
    label: "极严格",
    desc: "最大化风险识别",
    promptSuffix: [
      "## 极严格模式要求",
      "- 零容忍策略：任何可能违规的内容必须标记",
      "- 对隐喻、暗示、双关等间接表达保持最高警惕",
      "- 即使只有轻微违规可能性的内容也要标记",
      "- 优先保护平台安全，宁可过度标记也不遗漏",
    ].join("\n"),
  },
};

function isModel(value: string | null | undefined): value is ComplianceWorkspaceModel {
  return COMPLIANCE_MODEL_OPTIONS.some((option) => option.value === value);
}

function isCjk(text: string): boolean {
  const sample = text.slice(0, 2000);
  const count = (sample.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  return count / Math.max(sample.length, 1) > 0.15;
}

function normalizeRiskLevel(value: unknown): ComplianceRiskLevel {
  return value === "red" || value === "high" || value === "info" ? value : "info";
}

export function normalizeComplianceWorkspace(
  workspace: ComplianceWorkspace | null | undefined,
): ComplianceWorkspace {
  const base = createEmptyComplianceWorkspace();
  if (!workspace || typeof workspace !== "object") return base;
  const history = Array.isArray(workspace.history)
    ? workspace.history.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    ...base,
    sourceText: typeof workspace.sourceText === "string" ? workspace.sourceText : "",
    paletteText: typeof workspace.paletteText === "string" ? workspace.paletteText : "",
    reviewMode: workspace.reviewMode === "script" ? "script" : "text",
    strictness:
      workspace.strictness === "strict" || workspace.strictness === "extreme"
        ? workspace.strictness
        : "standard",
    model: isModel(workspace.model) ? workspace.model : DEFAULT_MODEL,
    tableSnapshot: normalizeTableSnapshot(workspace.tableSnapshot),
    riskPhrases: Array.isArray(workspace.riskPhrases)
      ? workspace.riskPhrases
          .filter((phrase) => phrase && typeof phrase === "object" && typeof phrase.text === "string")
          .map((phrase) => ({
            id: typeof phrase.id === "string" && phrase.id.trim() ? phrase.id : generateId(),
            level: normalizeRiskLevel(phrase.level),
            text: phrase.text,
            reason: typeof phrase.reason === "string" ? phrase.reason : "",
            segmentIndex:
              typeof phrase.segmentIndex === "number" && Number.isFinite(phrase.segmentIndex)
                ? phrase.segmentIndex
                : 0,
            replacement: typeof phrase.replacement === "string" ? phrase.replacement : undefined,
            status: phrase.status === "resolved" ? "resolved" : "pending",
          }))
      : [],
    riskSpans: Array.isArray(workspace.riskSpans)
      ? workspace.riskSpans
          .filter(
            (span): span is ComplianceWorkspaceRiskSpan =>
              Boolean(span) &&
              typeof span.start === "number" &&
              typeof span.end === "number" &&
              Number.isFinite(span.start) &&
              Number.isFinite(span.end) &&
              span.end > span.start,
          )
          .map((span) => ({ ...span, level: normalizeRiskLevel(span.level) }))
      : [],
    phraseReplacements:
      workspace.phraseReplacements && typeof workspace.phraseReplacements === "object"
        ? Object.fromEntries(
            Object.entries(workspace.phraseReplacements).filter(
              ([key, value]) => typeof key === "string" && typeof value === "string",
            ),
          )
        : {},
    segments: Array.isArray(workspace.segments)
      ? workspace.segments
          .filter((segment) => segment && typeof segment === "object" && typeof segment.content === "string")
          .map((segment) => ({
            index:
              typeof segment.index === "number" && Number.isFinite(segment.index) ? segment.index : 0,
            content: segment.content,
            report: typeof segment.report === "string" ? segment.report : "",
            status:
              segment.status === "processing" || segment.status === "done" || segment.status === "failed"
                ? segment.status
                : "pending",
            reviewedAt: typeof segment.reviewedAt === "string" ? segment.reviewedAt : null,
            riskCount:
              typeof segment.riskCount === "number" && Number.isFinite(segment.riskCount)
                ? segment.riskCount
                : undefined,
          }))
      : [],
    progress:
      workspace.progress && typeof workspace.progress === "object"
        ? {
            current:
              typeof workspace.progress.current === "number" && Number.isFinite(workspace.progress.current)
                ? workspace.progress.current
                : 0,
            total:
              typeof workspace.progress.total === "number" && Number.isFinite(workspace.progress.total)
                ? workspace.progress.total
                : 0,
            completed:
              typeof workspace.progress.completed === "number" && Number.isFinite(workspace.progress.completed)
                ? workspace.progress.completed
                : 0,
            failed:
              typeof workspace.progress.failed === "number" && Number.isFinite(workspace.progress.failed)
                ? workspace.progress.failed
                : 0,
            status:
              workspace.progress.status === "processing" ||
              workspace.progress.status === "done" ||
              workspace.progress.status === "failed"
                ? workspace.progress.status
                : "idle",
            updatedAt:
              typeof workspace.progress.updatedAt === "string" ? workspace.progress.updatedAt : null,
          }
        : base.progress,
    latestReview:
      workspace.latestReview &&
      typeof workspace.latestReview === "object" &&
      typeof workspace.latestReview.reviewedAt === "string"
        ? {
            reviewedAt: workspace.latestReview.reviewedAt,
            segmentCount:
              typeof workspace.latestReview.segmentCount === "number" &&
              Number.isFinite(workspace.latestReview.segmentCount)
                ? workspace.latestReview.segmentCount
                : 0,
            sourceLength:
              typeof workspace.latestReview.sourceLength === "number" &&
              Number.isFinite(workspace.latestReview.sourceLength)
                ? workspace.latestReview.sourceLength
                : 0,
            reportLength:
              typeof workspace.latestReview.reportLength === "number" &&
              Number.isFinite(workspace.latestReview.reportLength)
                ? workspace.latestReview.reportLength
                : 0,
            skippedAt:
              typeof workspace.latestReview.skippedAt === "string"
                ? workspace.latestReview.skippedAt
                : null,
          }
        : null,
    exportMeta:
      workspace.exportMeta && typeof workspace.exportMeta === "object"
        ? {
            lastExportedAt:
              typeof workspace.exportMeta.lastExportedAt === "string"
                ? workspace.exportMeta.lastExportedAt
                : null,
            lastExportFormat:
              workspace.exportMeta.lastExportFormat === "xlsx" ||
              workspace.exportMeta.lastExportFormat === "docx"
                ? workspace.exportMeta.lastExportFormat
                : null,
            lastExportFileName:
              typeof workspace.exportMeta.lastExportFileName === "string"
                ? workspace.exportMeta.lastExportFileName
                : null,
          }
        : null,
    history,
    historyIndex:
      typeof workspace.historyIndex === "number" && Number.isFinite(workspace.historyIndex)
        ? Math.min(workspace.historyIndex, history.length - 1)
        : history.length - 1,
    dialogueReviewEnabled: Boolean(workspace.dialogueReviewEnabled),
    dialogueOverLimitLineIndexes: Array.isArray(workspace.dialogueOverLimitLineIndexes)
      ? workspace.dialogueOverLimitLineIndexes.filter(
          (value): value is number => typeof value === "number" && Number.isFinite(value),
        )
      : [],
    lastImportedFileName:
      typeof workspace.lastImportedFileName === "string" ? workspace.lastImportedFileName : null,
    lastImportedAt: typeof workspace.lastImportedAt === "string" ? workspace.lastImportedAt : null,
  };
}

function normalizeTableSnapshot(
  snapshot: ComplianceWorkspaceTableSnapshot | null | undefined,
): ComplianceWorkspaceTableSnapshot | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const normalizeRows = (rows: unknown) =>
    Array.isArray(rows)
      ? rows.map((row) =>
          Array.isArray(row)
            ? row.map((cell) =>
                typeof cell === "string" || typeof cell === "number" || cell == null ? cell : String(cell),
              )
            : [],
        )
      : [];
  return {
    headers: Array.isArray(snapshot.headers)
      ? snapshot.headers.filter((entry): entry is string => typeof entry === "string")
      : [],
    rows: normalizeRows(snapshot.rows),
    fileName: typeof snapshot.fileName === "string" ? snapshot.fileName : "compliance-table.xlsx",
    sheetName: typeof snapshot.sheetName === "string" ? snapshot.sheetName : undefined,
    originalData: normalizeRows(snapshot.originalData),
  };
}

export function buildComplianceSourceText(
  project: DramaProject,
  input: Record<string, unknown> = {},
): string {
  if (typeof input.sourceText === "string" && input.sourceText.trim()) return input.sourceText;
  const workspace = normalizeComplianceWorkspace(project.complianceWorkspace);
  if (workspace.sourceText.trim()) return workspace.sourceText;
  if (!project.episodes.length) return "";
  return project.episodes
    .sort((a, b) => a.number - b.number)
    .map((episode) => `第${episode.number}集 ${episode.title}\n${episode.content}`)
    .join("\n\n---\n\n");
}

export function splitComplianceSourceText(text: string): string[] {
  const normalized = text.replace(/\r/g, "").trim();
  if (!normalized) return [];
  const maxSize = isCjk(normalized) ? CJK_SEGMENT_LIMIT : LATIN_SEGMENT_LIMIT;
  if (normalized.length <= maxSize) return [normalized];
  const segments: string[] = [];
  let remaining = normalized;
  while (remaining.length > 0) {
    if (remaining.length <= maxSize) {
      segments.push(remaining);
      break;
    }
    let splitIndex = remaining.lastIndexOf("\n\n", maxSize);
    if (splitIndex < maxSize * 0.5) splitIndex = remaining.lastIndexOf("\n", maxSize);
    if (splitIndex < maxSize * 0.5) splitIndex = maxSize;
    segments.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trimStart();
  }
  return segments.filter(Boolean);
}

export function buildCompliancePrompt(
  sourceText: string,
  reviewMode: ComplianceReviewMode,
  strictness: ComplianceStrictness,
): string {
  const suffix = COMPLIANCE_STRICTNESS_CONFIG[strictness].promptSuffix;
  return reviewMode === "script"
    ? [
        "你是一位资深的短剧内容合规审核专家，执行最彻底的合规审查。",
        "你需要同时检查文字违规和画面/情节层面的违规风险。",
        "",
        "## 待审脚本",
        sourceText,
        "",
        "---",
        suffix,
        "",
        "## 审核要求",
        "1. 检查激烈冲突、侵权、敏感亲密、不良行为、未成年人相关等风险。",
        "2. 只标记动作、画面、情节段落，不要标记角色对白和音效行。",
        "3. 输出完整风险片段，便于高亮定位和单条改写。",
        "",
        "## 输出格式",
        "1. 合规总评",
        "2. 文字违规检查",
        "3. 画面/情节违规检查",
        "4. 风险汇总",
        "5. 修改建议",
        "",
        "风险标记必须使用以下格式：",
        "- ⛔【完整风险片段】原因：...",
        "- ⚠️【完整风险片段】原因：...",
        "- ℹ️【完整风险片段】原因：...",
        "",
        "使用 Markdown 输出。",
      ].join("\n")
    : [
        "你是一位资深的短剧内容合规审核专家，精通各类内容监管法规与平台规范。",
        "",
        "## 待审内容",
        sourceText,
        "",
        "---",
        suffix,
        "",
        "## 审核要求",
        "请从激烈冲突、版权、敏感亲密内容三个维度进行合规审查。",
        "只标记动作、画面、情节段落，不要标记角色对白和音效行。",
        "",
        "## 输出格式",
        "1. 合规总评",
        "2. 激烈冲突检查",
        "3. 版权问题排查",
        "4. 敏感内容检查",
        "5. 问题清单汇总",
        "6. 修改建议",
        "",
        "风险标记必须使用以下格式：",
        "- ⛔【完整风险片段】原因：...",
        "- ⚠️【完整风险片段】原因：...",
        "- ℹ️【完整风险片段】原因：...",
        "",
        "使用 Markdown 输出。",
      ].join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findRiskRanges(source: string, phrase: string): Array<[number, number]> {
  const trimmed = phrase.trim();
  if (!trimmed) return [];
  const exact: Array<[number, number]> = [];
  let from = 0;
  while (from < source.length) {
    const index = source.indexOf(trimmed, from);
    if (index < 0) break;
    exact.push([index, index + trimmed.length]);
    from = index + trimmed.length;
  }
  if (exact.length) return exact;
  const pattern = escapeRegExp(trimmed).replace(/\s+/g, "\\s+");
  try {
    const regexp = new RegExp(pattern, "g");
    const ranges: Array<[number, number]> = [];
    let match: RegExpExecArray | null = null;
    while ((match = regexp.exec(source)) !== null) {
      ranges.push([match.index, match.index + match[0].length]);
    }
    return ranges;
  } catch {
    return [];
  }
}

export function extractComplianceRiskPhrases(report: string): ComplianceWorkspaceRiskPhrase[] {
  return report
    .replace(/\r/g, "")
    .split("\n")
    .map((line, index): ComplianceWorkspaceRiskPhrase | null => {
      const match = line.match(/(⛔|⚠️|ℹ️)\s*【([\s\S]+?)】(?:\s*原因[:：]\s*(.*))?/);
      if (!match) return null;
      return {
        id: `risk-${generateId()}`,
        level: match[1] === "⛔" ? "red" : match[1] === "⚠️" ? "high" : "info",
        text: match[2].trim(),
        reason: match[3]?.trim() || "",
        segmentIndex: index,
        status: "pending" as const,
      };
    })
    .filter((phrase): phrase is ComplianceWorkspaceRiskPhrase => Boolean(phrase));
}

export function locateComplianceRiskSpans(
  sourceText: string,
  phrases: ComplianceWorkspaceRiskPhrase[],
): ComplianceWorkspaceRiskSpan[] {
  const priority = { red: 3, high: 2, info: 1 } as const;
  const spans = phrases.flatMap((phrase) =>
    findRiskRanges(sourceText, phrase.text).map(([start, end]) => ({
      start,
      end,
      level: phrase.level,
    })),
  );
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: ComplianceWorkspaceRiskSpan[] = [];
  spans.forEach((span) => {
    const prev = merged[merged.length - 1];
    if (!prev || span.start > prev.end) {
      merged.push({ ...span });
      return;
    }
    prev.end = Math.max(prev.end, span.end);
    if (priority[span.level] > priority[prev.level]) prev.level = span.level;
  });
  return merged;
}

function splitDialogue(line: string): { prefix: string; content: string } | null {
  const match = line.match(/^([^\s:：]{1,12}[:：]\s*)([\s\S]+)$/);
  return match ? { prefix: match[1], content: match[2] } : null;
}

function countDialogueWords(line: string): number {
  const content = splitDialogue(line)?.content.trim() || line.trim();
  if (!content) return 0;
  if (isCjk(content)) return (content.match(/[\u4e00-\u9fff]/g) || []).length;
  return content.split(/\s+/).filter(Boolean).length;
}

export function deriveDialogueOverLimitLineIndexes(text: string, enabled: boolean): number[] {
  if (!enabled) return [];
  return text.replace(/\r/g, "").split("\n").reduce<number[]>((acc, line, index) => {
    if (!splitDialogue(line)) return acc;
    const wordCount = countDialogueWords(line);
    if (wordCount >= (isCjk(line) ? 36 : 24)) acc.push(index);
    return acc;
  }, []);
}

function pushHistory(workspace: ComplianceWorkspace, value: string): Pick<ComplianceWorkspace, "history" | "historyIndex"> {
  const base = normalizeComplianceWorkspace(workspace);
  const nextHistory = base.history.slice(0, Math.max(base.historyIndex + 1, 0));
  if (!nextHistory.length || nextHistory[nextHistory.length - 1] !== value) nextHistory.push(value);
  return {
    history: nextHistory.slice(-20),
    historyIndex: Math.min(nextHistory.length - 1, 19),
  };
}

export function deriveComplianceRevisionPackets(
  riskPhrases: ComplianceWorkspaceRiskPhrase[],
  replacements: Record<string, string> = {},
): ComplianceRevisionPacket[] {
  return riskPhrases.map((phrase) => ({
    id: `compliance-revision-${phrase.id}`,
    issueTitle: phrase.text.slice(0, 40) || "合规风险片段",
    riskLevel: phrase.level === "red" ? "high" : phrase.level === "high" ? "medium" : "low",
    recommendation: phrase.reason || "建议按平台规范弱化该段表达。",
    sourceQuote: phrase.text,
    status: phrase.status === "resolved" ? "resolved" : "pending",
    workspaceRiskId: phrase.id,
    replacement: replacements[phrase.id] ?? phrase.replacement,
    segmentIndex: phrase.segmentIndex,
    originalSnippet: phrase.text,
  }));
}

export function resolveComplianceStatus(project: DramaProject): "reviewed" | "skipped" | "pending" {
  if (project.complianceSkippedAt) return "skipped";
  if (project.complianceReport.trim()) return "reviewed";
  return "pending";
}

export async function executeComplianceReview(params: {
  sourceText: string;
  workspace: ComplianceWorkspace;
  reviewMode: ComplianceReviewMode;
  strictness: ComplianceStrictness;
  model: ComplianceWorkspaceModel;
  generateSegment: (prompt: string) => Promise<string>;
  onProgress?: (workspace: ComplianceWorkspace) => void;
}): Promise<{ report: string; workspace: ComplianceWorkspace; revisionPackets: ComplianceRevisionPacket[] }> {
  const sourceText = params.sourceText.replace(/\r/g, "").trim();
  const segments = splitComplianceSourceText(sourceText);
  if (!segments.length) throw new Error("缺少待审文本，无法启动完整版合规审核。");
  const base = normalizeComplianceWorkspace(params.workspace);
  let workspace = normalizeComplianceWorkspace({
    ...base,
    sourceText,
    reviewMode: params.reviewMode,
    strictness: params.strictness,
    model: params.model,
    progress: {
      current: 0,
      total: segments.length,
      completed: 0,
      failed: 0,
      status: "processing",
      updatedAt: new Date().toISOString(),
    },
    segments: segments.map((segment, index) => ({
      index,
      content: segment,
      report: "",
      status: "pending",
      reviewedAt: null,
      riskCount: 0,
    })),
  });
  params.onProgress?.(workspace);
  const reports: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    workspace = normalizeComplianceWorkspace({
      ...workspace,
      progress: {
        ...(workspace.progress ?? {
          current: 0,
          total: segments.length,
          completed: 0,
          failed: 0,
          status: "idle" as const,
          updatedAt: null,
        }),
        current: index + 1,
        updatedAt: new Date().toISOString(),
      },
      segments: workspace.segments.map((segment) =>
        segment.index === index ? { ...segment, status: "processing" } : segment,
      ),
    });
    params.onProgress?.(workspace);
    const report = await params.generateSegment(
      buildCompliancePrompt(segments[index], params.reviewMode, params.strictness),
    );
    reports.push(report);
    const riskCount = extractComplianceRiskPhrases(report).length;
    workspace = normalizeComplianceWorkspace({
      ...workspace,
      progress: {
        ...(workspace.progress ?? {
          current: 0,
          total: segments.length,
          completed: 0,
          failed: 0,
          status: "idle" as const,
          updatedAt: null,
        }),
        completed: index + 1,
        status: index === segments.length - 1 ? "done" : "processing",
        updatedAt: new Date().toISOString(),
      },
      segments: workspace.segments.map((segment) =>
        segment.index === index
          ? {
              ...segment,
              report,
              status: "done",
              reviewedAt: new Date().toISOString(),
              riskCount,
            }
          : segment,
      ),
    });
    params.onProgress?.(workspace);
  }
  const report =
    reports.length === 1
      ? reports[0]
      : reports.map((segmentReport, index) => `## 分段 ${index + 1}/${reports.length}\n${segmentReport}`).join("\n\n");
  const riskPhrases = extractComplianceRiskPhrases(report);
  const paletteText = base.paletteText.trim() || sourceText;
  const history = pushHistory(base, paletteText);
  const nextWorkspace = normalizeComplianceWorkspace({
    ...workspace,
    paletteText,
    riskPhrases,
    riskSpans: locateComplianceRiskSpans(sourceText, riskPhrases),
    phraseReplacements: {},
    latestReview: {
      reviewedAt: new Date().toISOString(),
      segmentCount: segments.length,
      sourceLength: sourceText.length,
      reportLength: report.length,
      skippedAt: null,
    },
    history: history.history,
    historyIndex: history.historyIndex,
    dialogueOverLimitLineIndexes: deriveDialogueOverLimitLineIndexes(sourceText, base.dialogueReviewEnabled),
  });
  return {
    report,
    workspace: nextWorkspace,
    revisionPackets: deriveComplianceRevisionPackets(riskPhrases),
  };
}

function replaceFirst(source: string, target: string, replacement: string): string {
  if (!target) return source;
  const index = source.indexOf(target);
  return index < 0 ? source : `${source.slice(0, index)}${replacement}${source.slice(index + target.length)}`;
}

export function applyComplianceReplacement(params: {
  workspace: ComplianceWorkspace;
  riskId: string;
  replacement: string;
}): ComplianceWorkspace {
  const workspace = normalizeComplianceWorkspace(params.workspace);
  const phrase = workspace.riskPhrases.find((entry) => entry.id === params.riskId);
  if (!phrase || !params.replacement.trim()) return workspace;
  const nextPalette = replaceFirst(
    workspace.paletteText || workspace.sourceText,
    phrase.text,
    params.replacement.trim(),
  );
  const history = pushHistory(workspace, nextPalette);
  return normalizeComplianceWorkspace({
    ...workspace,
    paletteText: nextPalette,
    phraseReplacements: { ...workspace.phraseReplacements, [params.riskId]: params.replacement.trim() },
    riskPhrases: workspace.riskPhrases.map((entry) =>
      entry.id === params.riskId ? { ...entry, replacement: params.replacement.trim(), status: "resolved" } : entry,
    ),
    history: history.history,
    historyIndex: history.historyIndex,
  });
}

export function applyComplianceUndo(workspace: ComplianceWorkspace): ComplianceWorkspace {
  const normalized = normalizeComplianceWorkspace(workspace);
  if (normalized.historyIndex <= 0) return normalized;
  return normalizeComplianceWorkspace({
    ...normalized,
    paletteText: normalized.history[normalized.historyIndex - 1] ?? normalized.paletteText,
    historyIndex: normalized.historyIndex - 1,
  });
}

export function applyComplianceRedo(workspace: ComplianceWorkspace): ComplianceWorkspace {
  const normalized = normalizeComplianceWorkspace(workspace);
  if (normalized.historyIndex >= normalized.history.length - 1) return normalized;
  return normalizeComplianceWorkspace({
    ...normalized,
    paletteText: normalized.history[normalized.historyIndex + 1] ?? normalized.paletteText,
    historyIndex: normalized.historyIndex + 1,
  });
}

export async function parseComplianceImportFile(file: File): Promise<{
  sourceText: string;
  tableSnapshot: ComplianceWorkspaceTableSnapshot | null;
}> {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "xlsx" || extension === "xls" || extension === "csv") {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const sheetName = workbook.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(workbook.Sheets[sheetName], {
      header: 1,
      raw: false,
    });
    const headers = rows[0]?.map((cell) => String(cell ?? "")) ?? [];
    return {
      sourceText: rows
        .map((row) => row.map((cell) => String(cell ?? "")).join("\t").trim())
        .filter(Boolean)
        .join("\n"),
      tableSnapshot: {
        headers,
        rows: rows.slice(1),
        fileName: file.name,
        sheetName,
        originalData: rows,
      },
    };
  }
  if (extension === "txt" || extension === "pdf" || extension === "docx" || extension === "doc") {
    const { parseDocument } = await import("@/lib/document-parser");
    return { sourceText: await parseDocument(file), tableSnapshot: null };
  }
  throw new Error(`不支持的导入文件类型: .${extension}`);
}

export async function exportCompliancePaletteAsDocx(params: {
  dramaTitle: string;
  sourceText: string;
  paletteText: string;
  riskPhrases: ComplianceWorkspaceRiskPhrase[];
}): Promise<string> {
  const fileName = `合规审核_调色盘对比_${new Date().toISOString().slice(0, 10)}.docx`;

  // 构建调色盘文本的颜色标注段落
  const { Document, HeadingLevel, Packer, Paragraph, TextRun } = await import("docx");

  type ColorSpan = { start: number; end: number; color: string };
  const colorSpans: ColorSpan[] = [];
  const occupied = new Set<number>();
  const levelColor: Record<string, string> = { red: "FF4444", high: "FF8C00", info: "FFB800" };

  for (const phrase of params.riskPhrases) {
    const searchText = phrase.status === "resolved" && phrase.replacement ? phrase.replacement : phrase.text;
    if (!searchText) continue;
    const ranges = findRiskRanges(params.paletteText, searchText);
    for (const [start, end] of ranges) {
      let overlaps = false;
      for (let i = start; i < end; i++) { if (occupied.has(i)) { overlaps = true; break; } }
      if (overlaps) continue;
      for (let i = start; i < end; i++) occupied.add(i);
      colorSpans.push({ start, end, color: phrase.status === "resolved" ? "22C55E" : (levelColor[phrase.level] ?? "FFB800") });
    }
  }
  colorSpans.sort((a, b) => a.start - b.start);

  function buildColoredParagraphs(text: string) {
    const paragraphs = [];
    let lineStart = 0;
    const lines = text.split("\n");
    for (const line of lines) {
      const lineEnd = lineStart + line.length;
      const runs = [];
      let pos = lineStart;
      for (const span of colorSpans) {
        if (span.end <= lineStart || span.start >= lineEnd) continue;
        const sStart = Math.max(span.start, lineStart);
        const sEnd = Math.min(span.end, lineEnd);
        if (sStart > pos) runs.push(new TextRun(text.slice(pos, sStart)));
        runs.push(new TextRun({ text: text.slice(sStart, sEnd), color: span.color, underline: {} }));
        pos = sEnd;
      }
      if (pos < lineEnd) runs.push(new TextRun(text.slice(pos, lineEnd)));
      paragraphs.push(new Paragraph({ children: runs.length ? runs : [new TextRun(line)] }));
      lineStart = lineEnd + 1; // +1 for the "\n"
    }
    return paragraphs;
  }

  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun(`合规调色盘对比 - ${params.dramaTitle || "剧本"}`)],
        }),
        new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("风险清单")] }),
        ...params.riskPhrases.map((phrase) =>
          new Paragraph({ children: [new TextRun({ text: `${phrase.level.toUpperCase()} ${phrase.text}${phrase.reason ? ` - ${phrase.reason}` : ""}`, color: levelColor[phrase.level] ?? "FFB800" })] }),
        ),
        new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("原始文本")] }),
        ...params.sourceText.split("\n").map((line) => new Paragraph({ children: [new TextRun(line)] })),
        new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("调色盘文本")] }),
        ...buildColoredParagraphs(params.paletteText),
      ],
    }],
  });
  saveAs(await Packer.toBlob(doc), fileName);
  return fileName;
}

export async function exportCompliancePaletteAsXlsx(params: {
  dramaTitle: string;
  tableSnapshot: ComplianceWorkspaceTableSnapshot;
  riskPhrases: ComplianceWorkspaceRiskPhrase[];
}): Promise<string> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([params.tableSnapshot.headers, ...params.tableSnapshot.rows]),
    params.tableSnapshot.sheetName || "审查文本",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(
      params.riskPhrases.map((phrase) => ({
        level: phrase.level,
        text: phrase.text,
        reason: phrase.reason,
        replacement: phrase.replacement ?? "",
        status: phrase.status,
      })),
    ),
    "风险清单",
  );
  const fileName = `${(params.dramaTitle || "剧本").slice(0, 30)}_合规审核_${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(workbook, fileName);
  return fileName;
}
