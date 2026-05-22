import * as React from "react";
import ReactDOM from "react-dom";
import { useTheme } from "next-themes";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  Copy,
  Download,
  FileText,
  GitBranch,
  Languages,
  Loader2,
  Maximize2,
  PencilLine,
  PlayCircle,
  RotateCcw,
  Square,
  Wrench,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/hooks/use-toast";
import { buildReviewPrompt } from "@/lib/drama-prompts";
import type { EpisodeQualityReviewResult } from "@/types/drama";
import { callGeminiStream } from "@/lib/gemini-client";
import {
  buildOutlineBatchRangeLabel,
  isNonChineseText,
  sanitizeMermaidCode,
} from "@/lib/home-agent/script-artifact-helpers";
import { findRiskRanges } from "@/lib/home-agent/compliance-workspace";
import type {
  ConversationArtifact,
  ConversationArtifactEditorField,
  ConversationProjectSnapshot,
} from "@/lib/home-agent/types";
import { resolveScriptWorkflowStage } from "./home-agent-project-questions";
import type { ComplianceRevisionPacket, ComplianceWorkspaceRiskPhrase } from "@/types/drama";
import { cn } from "@/lib/utils";

const { useCallback, useEffect, useMemo, useRef, useState } = React;

// 平滑动画进度条 hook，参考 Automatic-script/StepOutlines.tsx
function useAnimatedProgress(ceilPercent: number, floorPercent: number, hasProcessing: boolean) {
  const [display, setDisplay] = useState(0);
  const rafRef = useRef<number>();
  const lastTimeRef = useRef(performance.now());
  const prevCeilRef = useRef(ceilPercent);
  const displayRef = useRef(0);
  const ceilDropped = ceilPercent < prevCeilRef.current;

  useEffect(() => { prevCeilRef.current = ceilPercent; }, [ceilPercent]);
  useEffect(() => { displayRef.current = display; }, [display]);

  useEffect(() => {
    const isSettled = (value: number) => {
      const target = !hasProcessing && !ceilDropped ? floorPercent : Math.max(0, ceilPercent - 0.1);
      return Math.abs(value - target) <= 0.1;
    };

    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = undefined;
    }
    if (isSettled(displayRef.current)) {
      return;
    }

    lastTimeRef.current = performance.now();
    const tick = (now: number) => {
      const dt = (now - lastTimeRef.current) / 1000;
      lastTimeRef.current = now;
      let nextValue = displayRef.current;
      setDisplay((prev) => {
        const hardCap = Math.max(0, ceilPercent - 0.1);
        if (!hasProcessing && !ceilDropped) {
          if (prev > floorPercent) {
            const rollSpeed = Math.max(1, (prev - floorPercent) * 0.08) * 12;
            nextValue = Math.max(prev - rollSpeed * dt, floorPercent);
            displayRef.current = nextValue;
            return nextValue;
          }
          nextValue = floorPercent;
          displayRef.current = nextValue;
          return nextValue;
        }
        if (prev > hardCap) {
          const rollSpeed = Math.max(1, (prev - hardCap) * 0.08) * 12;
          nextValue = Math.max(prev - rollSpeed * dt, hardCap);
          displayRef.current = nextValue;
          return nextValue;
        }
        const base = Math.max(prev, floorPercent);
        const gap = hardCap - base;
        if (gap <= 0) {
          nextValue = hardCap;
          displayRef.current = nextValue;
          return nextValue;
        }
        const chunkRange = ceilPercent - floorPercent;
        const baseSpeed = chunkRange > 0 ? chunkRange / 75 : 0.2;
        const ratio = gap / (chunkRange || 1);
        const speed = baseSpeed * Math.max(0.05, ratio);
        nextValue = Math.min(base + speed * dt, hardCap);
        displayRef.current = nextValue;
        return nextValue;
      });
      if (isSettled(nextValue)) {
        rafRef.current = undefined;
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = undefined;
      }
    };
  }, [ceilPercent, floorPercent, hasProcessing, ceilDropped]);

  useEffect(() => {
    setDisplay((prev) => {
      const nextValue = Math.max(prev, floorPercent);
      displayRef.current = nextValue;
      return nextValue;
    });
  }, [floorPercent]);
  return Math.round(display * 10) / 10;
}

type DirectoryEntryPayload = Extract<
  NonNullable<ConversationArtifact["payload"]>,
  { type: "directory+stats" }
>["entries"][number];

type OutlineEntryPayload = Extract<
  NonNullable<ConversationArtifact["payload"]>,
  { type: "outlines+batchProgress" }
>["entries"][number];

type EpisodeBatchEntryPayload = Extract<
  NonNullable<ConversationArtifact["payload"]>,
  { type: "episodes+batchProgress" }
>["entries"][number];

type EpisodeInsightEntry = Pick<
  DirectoryEntryPayload & OutlineEntryPayload,
  "number" | "hookType" | "isKey" | "isClimax" | "isPaywall" | "emotionLevel"
>;

const TRANSLATION_CACHE_KEY = "storyforge-script-artifact-translation-cache-v1";
const MAX_CACHE_ENTRIES = 30;
const LINES_PER_BATCH = 200;
const PRIMARY_KINDS = new Set([
  "setup",
  "reference",
  "plan",
  "characters",
  "directory",
  "outline",
  "episode",
  "episode-review",
  "compliance",
  "export",
]);

function isVideoScriptArtifact(artifact: ConversationArtifact): boolean {
  return artifact.kind === "plan" && artifact.label.trim() === "视频脚本";
}

function resolveVisibleVideoArtifactStage(
  stage: string | null | undefined,
): "脚本拆解" | "角色与场景" | "分镜图生成" | "视频生成" | "预览与导出" {
  switch (String(stage || "").trim()) {
    case "角色与场景":
      return "角色与场景";
    case "分镜图生成":
    case "分镜批次":
    case "镜头指令包":
      return "分镜图生成";
    case "视频生成":
    case "视频提示词":
    case "生成中":
      return "视频生成";
    case "预览与导出":
    case "审阅与修复":
      return "预览与导出";
    case "脚本拆解":
    default:
      return "脚本拆解";
  }
}

const DIMENSION_LABELS: Record<string, string> = {
  rhythm: "节奏",
  satisfaction: "爽点",
  dialogue: "台词",
  format: "格式",
  continuity: "连贯性",
};

function getGradeColor(grade: string): string {
  if (grade === "卓越") return "text-green-400";
  if (grade === "优良") return "text-blue-400";
  if (grade === "合格") return "text-yellow-600 dark:text-yellow-400";
  if (grade === "需改进") return "text-orange-600 dark:text-orange-400";
  return "text-red-600 dark:text-red-400";
}

/** 从 marketLabel 反推 targetMarket code */
function resolveTargetMarket(marketLabel: string): string {
  const map: Record<string, string> = {
    "中国大陆": "cn",
    "日本": "jp",
    "欧美": "west",
    "韩国": "kr",
    "东南亚": "sea",
  };
  return map[marketLabel] ?? "cn";
}

// ─── 单集审查内容组件 ────────────────────────────────────────────────────────
function SingleReviewContent({
  reviewResult,
  reviewEpNum,
  onArtifactAction,
  onClose,
}: {
  reviewResult: EpisodeQualityReviewResult;
  reviewEpNum: number | null;
  onArtifactAction?: (value: string, label: string, input?: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const dims = ["rhythm", "satisfaction", "dialogue", "format", "continuity"] as const;

  return (
    <div className="space-y-3 text-xs">
      {/* 总分 */}
      <div className="flex items-baseline gap-1.5">
        <span className={`text-base font-bold tabular-nums ${getGradeColor(reviewResult.grade)}`}>{reviewResult.total}</span>
        <span className="text-muted-foreground">/50</span>
        <span className={`font-semibold ${getGradeColor(reviewResult.grade)}`}>· {reviewResult.grade}</span>
      </div>

      {/* 五维评分 */}
      <div className="space-y-1">
        {dims.map((d) => {
          const val = reviewResult.scores[d];
          if (!val) return null;
          return (
            <div key={d} className="flex items-start gap-2">
              <span className="w-14 shrink-0 text-muted-foreground">{DIMENSION_LABELS[d]}</span>
              <span className="shrink-0 font-mono text-muted-foreground">{val.score}/10</span>
              <span className="text-muted-foreground/60 leading-relaxed">{val.comment}</span>
            </div>
          );
        })}
      </div>

      {/* 亮点 */}
      {reviewResult.highlights.length > 0 && (
        <div className="space-y-0.5">
          <p className="text-muted-foreground">✨ 亮点</p>
          {reviewResult.highlights.map((h, i) => (
            <div key={i} className="flex gap-1.5 text-muted-foreground"><span className="shrink-0">·</span><span>{h}</span></div>
          ))}
        </div>
      )}

      {/* 问题 */}
      {reviewResult.issues.length > 0 && (
        <div className="space-y-0.5">
          <p className="text-muted-foreground">⚠ 问题</p>
          {reviewResult.issues.map((issue, i) => (
            <div key={i} className="flex gap-1.5">
              <span className="shrink-0">{issue.level}</span>
              <span className="text-muted-foreground">{issue.description}</span>
            </div>
          ))}
        </div>
      )}

      {/* 建议 */}
      {reviewResult.suggestions.length > 0 && (
        <div className="space-y-0.5">
          <p className="text-muted-foreground">💡 建议</p>
          {reviewResult.suggestions.map((s, i) => (
            <div key={i} className="flex gap-1.5">
              <span className="shrink-0 text-muted-foreground">{i + 1}.</span>
              <span className="text-muted-foreground">{s}</span>
            </div>
          ))}
        </div>
      )}

      {/* 一键修复 */}
      {(reviewResult.issues.length > 0 || reviewResult.suggestions.length > 0) && onArtifactAction && reviewEpNum != null && (
        <button
          type="button"
          className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground/80"
          onClick={() => {
            const parts: string[] = [];
            if (reviewResult.issues.length > 0) {
              parts.push("【质量审查发现的问题】");
              reviewResult.issues.forEach((issue) => parts.push(`${issue.level} ${issue.description}`));
            }
            if (reviewResult.suggestions.length > 0) {
              parts.push("【修订建议】");
              reviewResult.suggestions.forEach((s, i) => parts.push(`${i + 1}. ${s}`));
            }
            const lowScores = Object.entries(reviewResult.scores)
              .filter(([, val]) => val.score <= 6)
              .map(([key, val]) => `${DIMENSION_LABELS[key] || key}（${val.score}/10）：${val.comment}`);
            if (lowScores.length > 0) { parts.push("【需重点提升的维度】"); parts.push(...lowScores); }
            onClose();
            onArtifactAction(
              `script:episode-review:repair:${reviewEpNum}`,
              `一键修复第 ${reviewEpNum} 集`,
              { episodeNumber: reviewEpNum, instruction: parts.join("\n") },
            );
          }}
        >
          <Wrench className="h-3 w-3" />
          一键修复（基于审查结果重写）
        </button>
      )}
    </div>
  );
}

// ─── 批量审查内容组件 ────────────────────────────────────────────────────────
function BatchReviewContent({
  batchReviewResults,
  onArtifactAction,
  onClose,
}: {
  batchReviewResults: Map<number, EpisodeQualityReviewResult>;
  onArtifactAction?: (value: string, label: string, input?: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const entries = [...batchReviewResults.entries()].sort(([a], [b]) => a - b);
  const dims = ["rhythm", "satisfaction", "dialogue", "format", "continuity"] as const;
  const avgTotal = entries.reduce((sum, [, r]) => sum + r.total, 0) / entries.length;
  const dimAvg: Record<string, number> = {};
  dims.forEach((d) => { dimAvg[d] = entries.reduce((sum, [, r]) => sum + (r.scores[d]?.score || 0), 0) / entries.length; });
  const lowestEp = entries.reduce((min, curr) => curr[1].total < min[1].total ? curr : min);
  const highestEp = entries.reduce((max, curr) => curr[1].total > max[1].total ? curr : max);
  const avgGrade = avgTotal >= 45 ? "卓越" : avgTotal >= 38 ? "优良" : avgTotal >= 30 ? "合格" : avgTotal >= 25 ? "需改进" : "需重写";
  const epsWithIssues = entries.filter(([, r]) => r.issues.length > 0);

  return (
    <div className="space-y-3 text-xs">
      {/* 总分概览 */}
      <div className="flex items-baseline gap-3">
        <span className={`text-base font-bold tabular-nums ${getGradeColor(avgGrade)}`}>{avgTotal.toFixed(1)}</span>
        <span className={`font-semibold ${getGradeColor(avgGrade)}`}>· {avgGrade}</span>
        <span className="text-muted-foreground">均分</span>
        <span className="text-muted-foreground/60">·</span>
        <span className="text-emerald-600 dark:text-emerald-400">{highestEp[1].total}</span>
        <span className="text-muted-foreground">最高（第{highestEp[0]}集）</span>
        <span className="text-muted-foreground/60">·</span>
        <span className="text-orange-600 dark:text-orange-400">{lowestEp[1].total}</span>
        <span className="text-muted-foreground">最低（第{lowestEp[0]}集）</span>
      </div>

      {/* 五维平均 */}
      <div className="space-y-1">
        <p className="text-muted-foreground">五维平均</p>
        {dims.map((d) => (
          <div key={d} className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-muted-foreground">{DIMENSION_LABELS[d]}</span>
            <span className="font-mono text-muted-foreground">{dimAvg[d].toFixed(1)}/10</span>
          </div>
        ))}
      </div>

      {/* 各集明细 */}
      <div className="space-y-0.5">
        <p className="text-muted-foreground">各集评分</p>
        {entries.map(([epNum, r]) => (
          <div key={epNum} className="flex items-center gap-2">
            <span className="w-10 shrink-0 text-muted-foreground">第{epNum}集</span>
            <span className={`font-mono font-semibold ${getGradeColor(r.grade)}`}>{r.total}</span>
            <span className={`${getGradeColor(r.grade)}`}>{r.grade}</span>
          </div>
        ))}
      </div>

      {/* 有问题的集数 */}
      {epsWithIssues.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-muted-foreground">⚠ 问题集数（{epsWithIssues.length}）</p>
          {epsWithIssues.map(([epNum, r]) => (
            <div key={epNum} className="space-y-0.5">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">第 {epNum} 集 · {r.grade} · {r.total}分</span>
                {onArtifactAction && (
                  <button
                    type="button"
                    className="flex items-center gap-1 text-muted-foreground hover:text-foreground/70 transition-colors"
                    onClick={() => {
                      const parts = ["【质量审查发现的问题】", ...r.issues.map((i) => `${i.level} ${i.description}`), ...r.suggestions.map((s, idx) => `${idx + 1}. ${s}`)];
                      onClose();
                      onArtifactAction(`script:episode-review:repair:${epNum}`, `修复第 ${epNum} 集`, { episodeNumber: epNum, instruction: parts.join("\n") });
                    }}
                  >
                    <Wrench className="h-3 w-3" />修复
                  </button>
                )}
              </div>
              {r.issues.map((issue, i) => (
                <div key={i} className="flex gap-1.5 pl-2">
                  <span className="shrink-0">{issue.level}</span>
                  <span className="text-muted-foreground">{issue.description}</span>
                </div>
              ))}
            </div>
          ))}
          {onArtifactAction && (
            <button
              type="button"
              className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground/80"
              onClick={() => {
                const toFix = entries.filter(([, r]) => r.total < 38 || r.issues.some((i) => i.level === "⛔")).slice(0, 1);
                if (!toFix.length) { toast({ title: "所有集数质量达标" }); return; }
                const [epNum, result] = toFix[0];
                const parts = ["【批量审查发现的问题】", ...result.issues.map((i) => `${i.level} ${i.description}`), ...result.suggestions.map((s, idx) => `${idx + 1}. ${s}`)];
                onClose();
                onArtifactAction(`script:episode-review:repair:${epNum}`, `一键修复第 ${epNum} 集`, { episodeNumber: epNum, instruction: parts.join("\n") });
                toast({ title: `开始修复第 ${epNum} 集` });
              }}
            >
              <Wrench className="h-3 w-3" />一键修复最差集
            </button>
          )}
        </div>
      )}
    </div>
  );
}

type Props = {
  snapshot?: ConversationProjectSnapshot | null;
  trackClassName?: string;
  onArtifactAction?: (
    value: string,
    label: string,
    input?: Record<string, unknown>,
  ) => void;
  onSaveArtifactText?: (
    field: ConversationArtifactEditorField,
    label: string,
    text: string,
  ) => void | Promise<void>;
  onRelationshipDiagramCollapsedChange?: (collapsed: boolean) => void | Promise<void>;
  /** 外部触发批量质量审查 Dialog（计数器变化时触发） */
  directBatchReviewTrigger?: { count: number };
  /** 外部触发单集质量自检 Dialog */
  directSingleReviewTrigger?: { count: number; epNum: number };
  /** Keep artifacts available as review input without rendering their normal cards. */
  reviewWorkspaceOnly?: boolean;
};

function hashText(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return hash.toString(36);
}

function readTranslationCache(): Record<string, string[]> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(TRANSLATION_CACHE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function writeTranslationCache(cache: Record<string, string[]>): void {
  if (typeof window === "undefined") return;
  const trimmed = Object.fromEntries(Object.entries(cache).slice(-MAX_CACHE_ENTRIES));
  window.localStorage.setItem(TRANSLATION_CACHE_KEY, JSON.stringify(trimmed));
}

async function translateLines(lines: string[], signal: AbortSignal): Promise<string[]> {
  const model = window.localStorage.getItem("decompose-model") || "gemini-3.1-pro-preview";
  const prompt = [
    "Translate the following lines into Simplified Chinese.",
    "Return the translated lines only.",
    "Keep the same line order and preserve blank lines.",
    "",
    lines.join("\n"),
  ].join("\n");

  const output = await callGeminiStream(
    model,
    [{ role: "user", parts: [{ text: prompt }] }],
    () => {},
    { maxOutputTokens: 8192 },
    signal,
  );

  const translated = output.replace(/\r/g, "").split("\n");
  return lines.map((line, index) => translated[index] ?? line);
}

function useTextTranslation(text: string) {
  const key = useMemo(() => hashText(text), [text]);
  const abortRef = useRef<AbortController | null>(null);
  const resumeRef = useRef<{ lines: string[]; startBatch: number } | null>(null);
  const [translated, setTranslated] = useState<string[] | null>(null);
  const [showTranslation, setShowTranslation] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  useEffect(() => {
    const cached = readTranslationCache()[key];
    setTranslated(cached ?? null);
    setShowTranslation(false);
    setIsTranslating(false);
    setProgress({ done: 0, total: 0 });
    resumeRef.current = null;
    abortRef.current = null;
  }, [key]);

  const run = useCallback(
    async (startBatch: number, seed: string[]) => {
      const sourceLines = text.split("\n");
      const totalBatches = Math.max(1, Math.ceil(sourceLines.length / LINES_PER_BATCH));
      const result = [...seed];
      const controller = new AbortController();

      abortRef.current = controller;
      setIsTranslating(true);
      setShowTranslation(true);
      setProgress({ done: startBatch, total: totalBatches });

      try {
        for (let batchIndex = startBatch; batchIndex < totalBatches; batchIndex += 1) {
          const start = batchIndex * LINES_PER_BATCH;
          const end = Math.min(start + LINES_PER_BATCH, sourceLines.length);
          const translatedBatch = await translateLines(
            sourceLines.slice(start, end),
            controller.signal,
          );
          translatedBatch.forEach((line, offset) => {
            result[start + offset] = line;
          });
          setTranslated([...result]);
          setProgress({ done: batchIndex + 1, total: totalBatches });
        }

        const cache = readTranslationCache();
        cache[key] = result;
        writeTranslationCache(cache);
        resumeRef.current = null;
      } catch {
        const completed = result.some((line) => line.trim())
          ? Math.max(startBatch, Math.floor(result.filter(Boolean).length / LINES_PER_BATCH))
          : startBatch;
        resumeRef.current = { lines: [...result], startBatch: completed };
        setTranslated(result.some(Boolean) ? [...result] : null);
      } finally {
        setIsTranslating(false);
        abortRef.current = null;
      }
    },
    [key, text],
  );

  const toggle = useCallback(async () => {
    if (showTranslation) {
      setShowTranslation(false);
      return;
    }
    if (translated?.length) {
      setShowTranslation(true);
      return;
    }
    await run(0, new Array(text.split("\n").length).fill(""));
  }, [run, showTranslation, text, translated]);

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const resume = useCallback(async () => {
    if (!resumeRef.current) return;
    await run(resumeRef.current.startBatch, resumeRef.current.lines);
  }, [run]);

  return {
    canResume: !isTranslating && Boolean(resumeRef.current),
    displayText: showTranslation && translated?.length ? translated.join("\n") : text,
    isTranslating,
    progress,
    resume,
    showTranslation,
    stop,
    toggle,
  };
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <span className="text-sm text-foreground/80">
      <span className="text-xs text-muted-foreground">{label}：</span>
      {value}
    </span>
  );
}

function StatusBadge({
  children,
  tone = "default",
  className,
}: {
  children: React.ReactNode;
  tone?: "default" | "success" | "warning" | "danger";
  className?: string;
}) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "border text-[11px]",
        tone === "default" && "border-border bg-muted/30 text-foreground/80",
        tone === "success" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        tone === "warning" && "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        tone === "danger" && "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
        className,
      )}
    >
      {children}
    </Badge>
  );
}

type HookVisual = {
  label: string;
  accentClassName: string;
  softClassName: string;
  badgeClassName: string;
  dotClassName: string;
};

type RhythmSegment = {
  key: "opening" | "build" | "storm" | "finale";
  label: string;
  count: number;
  start: number;
  end: number;
  accentClassName: string;
  softClassName: string;
  badgeClassName: string;
};

const RHYTHM_SEGMENT_BLUEPRINT = [
  {
    key: "opening",
    label: "起势段",
    ratio: 0.15,
    accentClassName: "bg-sky-400",
    softClassName: "bg-sky-500/12",
    badgeClassName: "border-sky-400/20 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  {
    key: "build",
    label: "蓄升段",
    ratio: 0.3,
    accentClassName: "bg-emerald-400",
    softClassName: "bg-emerald-500/12",
    badgeClassName: "border-emerald-400/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  {
    key: "storm",
    label: "风暴段",
    ratio: 0.35,
    accentClassName: "bg-amber-400",
    softClassName: "bg-amber-500/12",
    badgeClassName: "border-amber-400/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  {
    key: "finale",
    label: "决战段",
    ratio: 0.2,
    accentClassName: "bg-rose-400",
    softClassName: "bg-rose-500/12",
    badgeClassName: "border-rose-400/20 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  },
] as const;

function normalizeHookTypeLabel(value: string | undefined): string {
  const normalized = (value || "未标注")
    .trim()
    .replace(/\s+/g, "")
    .replace(/钩子$/u, "钩");

  if (!normalized) return "未标注";
  return /钩$/u.test(normalized) ? normalized : `${normalized}钩`;
}

function getHookVisual(hookType: string | undefined): HookVisual {
  const label = normalizeHookTypeLabel(hookType);

  if (/情绪/u.test(label)) {
    return {
      label,
      accentClassName: "bg-violet-400",
      softClassName: "bg-violet-500/12",
      badgeClassName: "border-violet-400/20 bg-violet-500/10 text-violet-700 dark:text-violet-300",
      dotClassName: "bg-violet-400",
    };
  }

  if (/危机/u.test(label)) {
    return {
      label,
      accentClassName: "bg-rose-400",
      softClassName: "bg-rose-500/12",
      badgeClassName: "border-rose-400/20 bg-rose-500/10 text-rose-700 dark:text-rose-300",
      dotClassName: "bg-rose-400",
    };
  }

  if (/悬念/u.test(label)) {
    return {
      label,
      accentClassName: "bg-amber-300",
      softClassName: "bg-amber-500/12",
      badgeClassName: "border-amber-400/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      dotClassName: "bg-amber-300",
    };
  }

  if (/信息/u.test(label)) {
    return {
      label,
      accentClassName: "bg-cyan-400",
      softClassName: "bg-cyan-500/12",
      badgeClassName: "border-cyan-400/20 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
      dotClassName: "bg-cyan-400",
    };
  }

  if (/反转/u.test(label)) {
    return {
      label,
      accentClassName: "bg-indigo-400",
      softClassName: "bg-indigo-500/12",
      badgeClassName: "border-indigo-400/20 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
      dotClassName: "bg-indigo-400",
    };
  }

  return {
    label,
    accentClassName: "bg-slate-400",
    softClassName: "bg-slate-500/12",
    badgeClassName: "border-border bg-muted/30 text-foreground/80",
    dotClassName: "bg-slate-400",
  };
}

function buildHookDistribution(entries: EpisodeInsightEntry[]) {
  const total = Math.max(entries.length, 1);
  const counter = new Map<string, number>();

  entries.forEach((entry) => {
    const label = normalizeHookTypeLabel(entry.hookType);
    counter.set(label, (counter.get(label) ?? 0) + 1);
  });

  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({
      ...getHookVisual(label),
      count,
      percentage: Math.round((count / total) * 100),
    }));
}

function buildRhythmSegments(totalEpisodes: number): RhythmSegment[] {
  if (!totalEpisodes) return [];

  const rawCounts = RHYTHM_SEGMENT_BLUEPRINT.map((segment) => totalEpisodes * segment.ratio);
  const counts = rawCounts.map((value) => Math.floor(value));
  let remaining = totalEpisodes - counts.reduce((sum, value) => sum + value, 0);

  if (totalEpisodes >= RHYTHM_SEGMENT_BLUEPRINT.length) {
    counts.forEach((count, index) => {
      if (count === 0) {
        counts[index] = 1;
        remaining -= 1;
      }
    });
  }

  const priorities = rawCounts
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);

  let pointer = 0;
  while (remaining > 0 && priorities.length) {
    counts[priorities[pointer % priorities.length].index] += 1;
    remaining -= 1;
    pointer += 1;
  }

  while (remaining < 0) {
    const removalTarget =
      [...counts.entries()]
        .reverse()
        .find(([, count]) => count > 1)?.[0] ?? counts.findIndex((count) => count > 0);

    if (removalTarget < 0) break;
    counts[removalTarget] -= 1;
    remaining += 1;
  }

  let cursor = 1;
  return RHYTHM_SEGMENT_BLUEPRINT.map((segment, index) => {
    const count = counts[index];
    const start = count > 0 ? cursor : 0;
    const end = count > 0 ? cursor + count - 1 : 0;
    cursor += count;
    return {
      key: segment.key,
      label: segment.label,
      count,
      start,
      end,
      accentClassName: segment.accentClassName,
      softClassName: segment.softClassName,
      badgeClassName: segment.badgeClassName,
    };
  }).filter((segment) => segment.count > 0);
}

function getRhythmSegmentForEpisode(episodeNumber: number, segments: RhythmSegment[]) {
  return segments.find(
    (segment) => episodeNumber >= segment.start && episodeNumber <= segment.end,
  );
}

function getEmotionLevel(entry: Pick<EpisodeInsightEntry, "emotionLevel">): number {
  return Math.min(5, Math.max(1, entry.emotionLevel ?? 3));
}

function getEmotionBarVisual(entry: EpisodeInsightEntry) {
  if (entry.isClimax) {
    return {
      fillClassName: "bg-rose-400/90",
      borderClassName: "border-rose-300/60",
    };
  }

  if (entry.isPaywall) {
    return {
      fillClassName: "bg-amber-400/90",
      borderClassName: "border-amber-300/60",
    };
  }

  if (entry.isKey) {
    return {
      fillClassName: "bg-yellow-300/90",
      borderClassName: "border-yellow-200/60",
    };
  }

  const hookVisual = getHookVisual(entry.hookType);

  if (hookVisual.label.includes("情绪")) {
    return {
      fillClassName: "bg-violet-400/85",
      borderClassName: "border-violet-300/50",
    };
  }

  if (hookVisual.label.includes("危机")) {
    return {
      fillClassName: "bg-rose-400/85",
      borderClassName: "border-rose-300/50",
    };
  }

  if (hookVisual.label.includes("悬念")) {
    return {
      fillClassName: "bg-amber-300/85",
      borderClassName: "border-amber-300/50",
    };
  }

  if (hookVisual.label.includes("信息")) {
    return {
      fillClassName: "bg-cyan-400/85",
      borderClassName: "border-cyan-300/50",
    };
  }

  if (hookVisual.label.includes("反转")) {
    return {
      fillClassName: "bg-indigo-400/85",
      borderClassName: "border-indigo-300/50",
    };
  }

  return {
    fillClassName: "bg-slate-400/85",
    borderClassName: "border-slate-300/50",
  };
}

function DistributionRow({
  label,
  countLabel,
  detailLabel,
  percentage,
  accentClassName,
  softClassName,
}: {
  label: string;
  countLabel: string;
  detailLabel: string;
  percentage: number;
  accentClassName: string;
  softClassName: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-foreground/80">{label}</span>
        <span className="text-[11px] text-muted-foreground">{`${detailLabel} · ${countLabel}`}</span>
      </div>
      <div className={cn("h-2 overflow-hidden rounded-full", softClassName)}>
        <div
          className={cn("h-full rounded-full", accentClassName)}
          style={{ width: `${Math.max(percentage, 6)}%` }}
        />
      </div>
    </div>
  );
}

function SectionPanel({
  icon,
  title,
  caption,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  caption?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[20px] border border-border/60 bg-card/80 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          {icon}
          <span>{title}</span>
        </div>
        {caption ? <span className="text-[11px] text-muted-foreground">{caption}</span> : null}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function EmotionWaveChart({ entries }: { entries: EpisodeInsightEntry[] }) {
  const midEntry = entries[Math.floor((entries.length - 1) / 2)];
  const chartHeight = 118;

  return (
    <div className="grid grid-cols-[16px_minmax(0,1fr)] gap-2.5">
      <div className="flex flex-col justify-between text-[10px] text-muted-foreground" style={{ height: `${chartHeight}px` }}>
        <span>5</span>
        <span>3</span>
        <span>1</span>
      </div>
      <div className="space-y-2">
        <div className="relative overflow-hidden rounded-[18px] border border-border/60 bg-muted/20 px-2 py-2.5" style={{ height: `${chartHeight}px` }}>
          <div className="pointer-events-none absolute inset-x-2 inset-y-2.5 flex flex-col justify-between">
            {[0, 1, 2].map((index) => (
              <div key={index} className="h-px w-full border-t border-dashed border-border/60" />
            ))}
          </div>
          <div className="relative flex h-full items-end gap-0.5">
            {entries.map((entry) => {
              const level = getEmotionLevel(entry);
              const visual = getEmotionBarVisual(entry);
              return (
                <div key={entry.number} className="relative flex min-w-0 flex-1 items-end justify-center">
                  <div className="pointer-events-none absolute inset-y-2 bottom-0 w-px bg-border/40" />
                  <div
                    className={cn(
                      "relative w-full max-w-[14px] rounded-[6px] border shadow-[0_6px_16px_rgba(15,23,42,0.18)]",
                      visual.fillClassName,
                      visual.borderClassName,
                    )}
                    style={{ height: `${20 + (level - 1) * 18}px` }}
                    title={`第 ${entry.number} 集 · ${normalizeHookTypeLabel(entry.hookType)} · 情绪 ${level}`}
                  />
                </div>
              );
            })}
          </div>
        </div>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>第1集</span>
          {midEntry ? <span>{`第${midEntry.number}集`}</span> : null}
          <span>{`第${entries[entries.length - 1]?.number ?? 0}集`}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-yellow-300" />
            关键集
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-rose-400" />
            高潮卡点
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-amber-400" />
            付费卡点
          </span>
        </div>
      </div>
    </div>
  );
}

function EpisodeInsightBadges({
  entry,
  rhythmSegments,
}: {
  entry: EpisodeInsightEntry;
  rhythmSegments: RhythmSegment[];
}) {
  const hookVisual = getHookVisual(entry.hookType);
  const rhythmSegment = getRhythmSegmentForEpisode(entry.number, rhythmSegments);
  const emotionLevel = getEmotionLevel(entry);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusBadge className={hookVisual.badgeClassName}>{hookVisual.label}</StatusBadge>
      {rhythmSegment ? (
        <StatusBadge className={rhythmSegment.badgeClassName}>{rhythmSegment.label}</StatusBadge>
      ) : null}
      <StatusBadge className="border-border bg-muted/30 text-foreground/80">{`情绪 ${emotionLevel}`}</StatusBadge>
      {entry.isKey ? <StatusBadge className="border-yellow-400/20 bg-yellow-500/10 text-yellow-100">关键集</StatusBadge> : null}
      {entry.isClimax ? <StatusBadge tone="danger">高潮</StatusBadge> : null}
      {entry.isPaywall ? <StatusBadge className="border-amber-400/20 bg-amber-500/10 text-amber-700 dark:text-amber-300">付费点</StatusBadge> : null}
    </div>
  );
}

function ArtifactActions({
  artifact,
  onArtifactAction,
}: {
  artifact: ConversationArtifact;
  onArtifactAction?: (value: string, label: string, input?: Record<string, unknown>) => void;
}) {
  if (!artifact.actions?.length || !onArtifactAction) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-3 border-t border-border/60 pt-2">
      {artifact.actions.map((action) => (
        <button
          key={action.id}
          type="button"
          disabled={action.disabled}
          className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground/80 disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => onArtifactAction(action.value, action.label)}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

function stripSpecialBrackets(text: string): string {
  return text.replace(/[【】「」『』〖〗]/g, (m) => ({ '【': '[', '】': ']', '「': '"', '」': '"', '『': '"', '』': '"', '〖': '[', '〗': ']' }[m] ?? m));
}

function TextBlock({ text }: { text: string }) {
  const translation = useTextTranslation(text);
  const translatable = isNonChineseText(text);
  const displayText = translation.displayText;

  return (
    <div className="space-y-2">
      {translatable ? (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground/80" onClick={() => void translation.toggle()}>
            <Languages className="h-3 w-3" />
            {translation.showTranslation ? "原文" : "译文"}
          </button>
          {translation.isTranslating ? (
            <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground/80" onClick={translation.stop}>
              <Square className="h-3 w-3" />
              停止
            </button>
          ) : null}
          {translation.canResume ? (
            <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground/80" onClick={() => void translation.resume()}>
              <RotateCcw className="h-3 w-3" />
              继续
            </button>
          ) : null}
          {translation.progress.total ? (
            <span className="text-xs text-muted-foreground">{`${translation.progress.done}/${translation.progress.total}`}</span>
          ) : null}
        </div>
      ) : null}
      {translation.progress.total ? (
        <Progress
          value={(translation.progress.done / Math.max(translation.progress.total, 1)) * 100}
          className="h-0.5 bg-muted/60"
        />
      ) : null}
      <div className="prose prose-neutral dark:prose-invert prose-sm max-w-none text-foreground/80 [&_h1]:text-base [&_h1]:font-semibold [&_h1]:text-foreground [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-foreground [&_h3]:text-sm [&_h3]:font-medium [&_h3]:text-foreground/80 [&_p]:text-foreground/70 [&_p]:leading-relaxed [&_li]:text-foreground/70 [&_strong]:text-foreground [&_strong]:font-medium [&_table]:border-collapse [&_th]:border [&_th]:border-border [&_th]:bg-muted/40 [&_th]:px-2 [&_th]:py-1 [&_th]:text-foreground/80 [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:text-foreground/70 [&_tr:hover_td]:bg-muted/20">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripSpecialBrackets(displayText)}</ReactMarkdown>
      </div>
    </div>
  );
}

function MermaidDiagram({ simpleCode, detailedCode, isDark, lightboxOpen, onCloseLightbox, externalMode, onModeChange }: {
  simpleCode: string;
  detailedCode?: string;
  isDark: boolean;
  lightboxOpen?: boolean;
  onCloseLightbox?: () => void;
  externalMode?: "simple" | "detailed";
  onModeChange?: (mode: "simple" | "detailed") => void;
}) {
  const hasDetailed = Boolean(detailedCode?.trim());
  // 内部维护模式状态，切换即时响应，不依赖父组件异步更新
  const [mode, setMode] = useState<"simple" | "detailed">(externalMode ?? "simple");
  const activeCode = mode === "detailed" && hasDetailed ? detailedCode! : simpleCode;

  // 同步外部模式变化（父组件持久化恢复时）
  useEffect(() => {
    if (externalMode && externalMode !== mode) setMode(externalMode);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalMode]);

  const switchMode = (next: "simple" | "detailed") => {
    setMode(next);
    onModeChange?.(next);
  };

  const [svgMap, setSvgMap] = useState<Record<string, string>>({});
  const [errorMap, setErrorMap] = useState<Record<string, string>>({});
  const svg = svgMap[activeCode] ?? "";
  const error = errorMap[activeCode] ?? "";

  useEffect(() => {
    // 已渲染过则跳过
    if (svgMap[activeCode]) return;
    let cancelled = false;

    async function renderMermaid() {
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "loose",
          theme: "base",
          themeVariables: isDark
            ? {
                background: "transparent",
                primaryColor: "#1e293b",
                primaryTextColor: "#e2e8f0",
                primaryBorderColor: "#334155",
                lineColor: "#64748b",
                secondaryColor: "#0f172a",
                tertiaryColor: "#1e293b",
                edgeLabelBackground: "#1e293b",
                clusterBkg: "#0f172a",
                titleColor: "#e2e8f0",
                nodeTextColor: "#e2e8f0",
                mainBkg: "#1e293b",
                nodeBorder: "#475569",
                clusterBorder: "#334155",
                defaultLinkColor: "#64748b",
                fontFamily: "inherit",
              }
            : {
                background: "transparent",
                primaryColor: "#f1f5f9",
                primaryTextColor: "#0f172a",
                primaryBorderColor: "#cbd5e1",
                lineColor: "#94a3b8",
                secondaryColor: "#f8fafc",
                tertiaryColor: "#f1f5f9",
                edgeLabelBackground: "#f8fafc",
                clusterBkg: "#f8fafc",
                titleColor: "#0f172a",
                nodeTextColor: "#0f172a",
                mainBkg: "#f1f5f9",
                nodeBorder: "#94a3b8",
                clusterBorder: "#cbd5e1",
                defaultLinkColor: "#94a3b8",
                fontFamily: "inherit",
              },
        });
        const rendered = await mermaid.render(`mermaid-${Date.now()}`, sanitizeMermaidCode(activeCode));
        if (!cancelled) {
          setSvgMap((m) => ({ ...m, [activeCode]: rendered.svg }));
          setErrorMap((m) => { const n = { ...m }; delete n[activeCode]; return n; });
        }
      } catch (reason) {
        if (!cancelled) {
          setErrorMap((m) => ({ ...m, [activeCode]: reason instanceof Error ? reason.message : "Mermaid 渲染失败" }));
        }
      }
    }

    void renderMermaid();
    return () => { cancelled = true; };
  // isDark 变化时清缓存重渲
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCode, isDark]);

  if (error) {
    return (
      <div className="space-y-2 rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-300">
        <div className="flex items-center gap-2 font-medium">
          <AlertTriangle className="h-4 w-4" />
          Mermaid 渲染失败，已回退为源码
        </div>
        <pre className="whitespace-pre-wrap text-xs">{sanitizeMermaidCode(activeCode)}</pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-border bg-muted/30 p-4 text-sm text-foreground/70">
        <Loader2 className="h-4 w-4 animate-spin" />
        关系图渲染中
      </div>
    );
  }

  return (
    <>
      {/* 内联视图：居中展示 */}
      <div className="overflow-auto rounded-xl border border-border bg-muted/20 p-3 flex justify-center [&_svg]:max-w-full [&_.label]:font-sans [&_text]:fill-foreground [&_.edgeLabel]:text-foreground/80"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {/* 灯箱弹窗 — portal 挂到 body 确保置顶 */}
      {lightboxOpen ? ReactDOM.createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 backdrop-blur-sm"
          onClick={onCloseLightbox}
          onWheel={(e) => {
            if (!hasDetailed) return;
            e.preventDefault();
            switchMode(e.deltaY > 0 ? "detailed" : "simple");
          }}
        >
          <div
            className="relative flex flex-col rounded-xl border border-border bg-background shadow-2xl"
            style={{ width: "min(92vw, 1100px)", height: "min(88vh, 820px)" }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 顶栏 */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
              <GitBranch className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs font-medium text-foreground/70">人物关系图</span>
              <div className="flex-1" />
              {hasDetailed ? (
                <>
                  <span className="text-[11px] text-muted-foreground/60 mr-1">滚轮切换</span>
                  <div className="flex items-center rounded border border-border overflow-hidden text-[11px]">
                    <button
                      type="button"
                      onClick={() => switchMode("simple")}
                      className={cn(
                        "px-2 py-0.5 transition-colors",
                        mode === "simple"
                          ? "bg-primary/15 text-primary font-medium"
                          : "text-muted-foreground hover:text-foreground/70",
                      )}
                    >
                      简单
                    </button>
                    <span className="w-px h-3 bg-border" />
                    <button
                      type="button"
                      onClick={() => switchMode("detailed")}
                      className={cn(
                        "px-2 py-0.5 transition-colors",
                        mode === "detailed"
                          ? "bg-primary/15 text-primary font-medium"
                          : "text-muted-foreground hover:text-foreground/70",
                      )}
                    >
                      详细
                    </button>
                  </div>
                </>
              ) : null}
              <button
                type="button"
                onClick={onCloseLightbox}
                className="ml-2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {/* 图表区域：居中展示 */}
            <div
              className="flex-1 overflow-auto p-4 flex justify-center items-start [&_svg]:max-w-full [&_svg]:h-auto [&_.label]:font-sans [&_text]:fill-foreground [&_.edgeLabel]:text-foreground/80"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

function buildEditableOutlineText(
  payload: Extract<
    NonNullable<ConversationArtifact["payload"]>,
    { type: "outlines+batchProgress" }
  >,
): string {
  if (payload.editorText?.trim()) {
    return payload.editorText.trim();
  }
  return buildEditableOutlineEntriesText(payload.entries);
}

function buildEditableOutlineEntriesText(entries: OutlineEntryPayload[]): string {
  return entries
    .map((entry) =>
      [`【第${entry.number}集细纲】`, `标题：${entry.title}`, entry.outline].join("\n").trim(),
    )
    .join("\n\n---\n\n");
}

function buildOutlineEntrySaveText(
  payload: Extract<
    NonNullable<ConversationArtifact["payload"]>,
    { type: "outlines+batchProgress" }
  >,
  episodeNumber: number,
  nextOutline: string,
): string {
  return buildEditableOutlineEntriesText(
    payload.entries.map((entry) =>
      entry.number === episodeNumber
        ? { ...entry, outline: nextOutline.trim() }
        : entry,
    ),
  );
}

function getOutlineEntryKey(artifactId: string, episodeNumber: number): string {
  return `${artifactId}:${episodeNumber}`;
}

function getEpisodeEntryKey(artifactId: string, episodeNumber: number): string {
  return `${artifactId}:episode:${episodeNumber}`;
}

function buildEditableCharactersText(
  payload: Extract<
    NonNullable<ConversationArtifact["payload"]>,
    { type: "characters+mermaid" }
  >,
): string {
  const body = payload.body.trim();
  const mermaid = payload.mermaidCode?.trim()
    ? `\n\n\`\`\`mermaid\n${payload.mermaidCode.trim()}\n\`\`\``
    : "";
  const detailed = payload.detailedMermaidCode?.trim()
    ? `\n\n\`\`\`mermaid-detailed\n${payload.detailedMermaidCode.trim()}\n\`\`\``
    : "";
  return `${body}${mermaid}${detailed}`.trim();
}

function getEditableArtifactText(artifact: ConversationArtifact): string {
  if (artifact.editor?.text?.trim()) {
    return artifact.editor.text.trim();
  }
  if (artifact.payload?.type === "outlines+batchProgress") {
    return buildEditableOutlineText(artifact.payload);
  }
  if (artifact.payload?.type === "characters+mermaid") {
    return artifact.content?.trim() || buildEditableCharactersText(artifact.payload);
  }
  return artifact.content?.trim() || artifact.summary || "";
}

type ComplianceSummaryTab = "report" | "palette";

const DIALOGUE_REVIEW_MARKER = "【对话审查】";

type AnnotatedSegment = {
  text: string;
  level: "red" | "high" | "info" | null;
  status: "resolved" | "pending" | null;
  dialogueReview?: boolean;
};

type ComplianceRepairRecord = {
  id: string;
  level: "red" | "high" | "info";
  originalText: string;
  replacement?: string;
};

function buildPaletteAnnotations(text: string, riskPhrases: ComplianceWorkspaceRiskPhrase[]): AnnotatedSegment[] {
  type Span = { start: number; end: number; level: "red" | "high" | "info"; status: "resolved" | "pending" };
  const spans: Span[] = [];
  const occupied = new Set<number>();

  for (const phrase of riskPhrases) {
    // resolved 且有 replacement → 在调色盘文本里找 replacement；否则找原始 text
    const searchText = phrase.status === "resolved" && phrase.replacement ? phrase.replacement : phrase.text;
    if (!searchText) continue;
    const ranges = findRiskRanges(text, searchText);
    for (const [start, end] of ranges) {
      let overlaps = false;
      for (let i = start; i < end; i++) { if (occupied.has(i)) { overlaps = true; break; } }
      if (overlaps) continue;
      for (let i = start; i < end; i++) occupied.add(i);
      spans.push({ start, end, level: phrase.level, status: phrase.status });
    }
  }

  spans.sort((a, b) => a.start - b.start);

  const segments: AnnotatedSegment[] = [];
  let pos = 0;
  for (const span of spans) {
    if (span.start > pos) segments.push({ text: text.slice(pos, span.start), level: null, status: null });
    segments.push({ text: text.slice(span.start, span.end), level: span.level, status: span.status });
    pos = span.end;
  }
  if (pos < text.length) segments.push({ text: text.slice(pos), level: null, status: null });
  return segments;
}

function splitDialogueReviewSegments(segments: AnnotatedSegment[]): AnnotatedSegment[] {
  return segments.flatMap((segment) => {
    if (!segment.text.includes(DIALOGUE_REVIEW_MARKER)) return [segment];
    const pieces: AnnotatedSegment[] = [];
    let remaining = segment.text;
    while (remaining.length > 0) {
      const markerIndex = remaining.indexOf(DIALOGUE_REVIEW_MARKER);
      if (markerIndex < 0) {
        pieces.push({ ...segment, text: remaining });
        break;
      }
      if (markerIndex > 0) {
        pieces.push({ ...segment, text: remaining.slice(0, markerIndex) });
      }
      pieces.push({
        ...segment,
        text: DIALOGUE_REVIEW_MARKER,
        dialogueReview: true,
      });
      remaining = remaining.slice(markerIndex + DIALOGUE_REVIEW_MARKER.length);
    }
    return pieces;
  });
}

function buildComplianceRepairRecords(
  packets: ComplianceRevisionPacket[],
  riskPhrases: ComplianceWorkspaceRiskPhrase[],
): ComplianceRepairRecord[] {
  const packetRecords = packets
    .filter((packet) => packet.status === "resolved")
    .map<ComplianceRepairRecord | null>((packet) => {
      const originalText = packet.originalSnippet ?? packet.sourceQuote ?? packet.issueTitle;
      if (!originalText?.trim()) return null;
      return {
        id: packet.id,
        level:
          packet.riskLevel === "high"
            ? "red"
            : packet.riskLevel === "medium"
              ? "high"
              : "info",
        originalText,
        replacement: packet.replacement?.trim() || undefined,
      };
    })
    .filter((record): record is ComplianceRepairRecord => Boolean(record));
  if (packetRecords.length) return packetRecords;
  return riskPhrases
    .filter((phrase) => phrase.status === "resolved")
    .map((phrase) => ({
      id: phrase.id,
      level: phrase.level,
      originalText: phrase.text,
      replacement: phrase.replacement?.trim() || undefined,
    }));
}

function PaletteAnnotated({ text, riskPhrases }: { text: string; riskPhrases: ComplianceWorkspaceRiskPhrase[] }) {
  const segments = splitDialogueReviewSegments(buildPaletteAnnotations(text, riskPhrases));
  return (
    <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/70">
      {segments.map((seg, i) => {
        if (seg.dialogueReview) {
          return (
            <span
              key={i}
              className="font-medium text-sky-700 dark:text-sky-300"
              title="对话审查"
            >
              {seg.text}
            </span>
          );
        }
        if (!seg.level) return <React.Fragment key={i}>{seg.text}</React.Fragment>;
        const colorClass =
          seg.status === "resolved"
            ? "underline decoration-emerald-500 text-emerald-700 dark:text-emerald-300"
            : seg.level === "red"
              ? "underline decoration-red-500 text-red-700 dark:text-red-300"
              : seg.level === "high"
                ? "underline decoration-orange-500 text-orange-700 dark:text-orange-300"
                : "underline decoration-yellow-500 text-yellow-700 dark:text-yellow-300";
        return <span key={i} className={colorClass} title={seg.status === "resolved" ? "已改写" : "风险片段"}>{seg.text}</span>;
      })}
    </p>
  );
}

function ComplianceSummaryContent({
  payload,
  onArtifactAction,
}: {
  payload: Extract<NonNullable<ConversationArtifact["payload"]>, { type: "complianceSummary" }>;
  onArtifactAction?: (value: string, label: string, input?: Record<string, unknown>) => void;
}) {
  const hasPalette = Boolean(payload.workspace.paletteText.trim());
  const hasDialogueReviewMarkers = payload.workspace.paletteText.includes(DIALOGUE_REVIEW_MARKER);
  const repairRecords = useMemo(
    () => buildComplianceRepairRecords(payload.packets, payload.workspace.riskPhrases),
    [payload.packets, payload.workspace.riskPhrases],
  );
  const [activeTab, setActiveTab] = useState<ComplianceSummaryTab>("report");

  return (
    <div className="space-y-3">
      {/* 指标行 */}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <Metric label="审核模式" value={payload.mode === "script" ? "剧情审核" : "文字审核"} />
        <Metric label="红线/高风险" value={`${payload.counts.redLine}/${payload.counts.highRisk}`} />
        <Metric label="建议项" value={payload.counts.suggestion} />
        <Metric label="待修订" value={payload.counts.pendingPackets} />
      </div>
      {/* 统计文本 */}
      <div className="space-y-1 text-xs text-muted-foreground">
        <p>{`严格度：${payload.strictness}`}</p>
        <p>{`风险片段：${payload.workspace.riskPhrases.filter((item) => item.status !== "resolved").length}/${payload.workspace.riskPhrases.length}`}</p>
        <p>
          {payload.workspace.progress
            ? `审核进度：${payload.workspace.progress.completed}/${payload.workspace.progress.total}`
            : payload.workspace.latestReview
              ? `最近一次切分：${payload.workspace.latestReview.segmentCount} 段`
              : "审核进度：未开始"}
        </p>
        <p>
          {payload.workspace.sourceText.trim()
            ? `待审文本 ${payload.workspace.sourceText.length.toLocaleString()} 字，调色盘 ${payload.workspace.paletteText.length.toLocaleString()} 字。`
            : "待审文本尚未准备好，可先导入文件或回填当前项目正文。"}
        </p>
        {payload.workspace.tableSnapshot ? (
          <p>{`表格快照 ${payload.workspace.tableSnapshot.rows.length} 行${payload.workspace.lastImportedFileName ? ` · ${payload.workspace.lastImportedFileName}` : ""}`}</p>
        ) : null}
        {payload.workspace.exportMeta?.lastExportFormat ? (
          <p>{`最近导出：${payload.workspace.exportMeta.lastExportFormat}${payload.workspace.exportMeta.lastExportFileName ? ` · ${payload.workspace.exportMeta.lastExportFileName}` : ""}`}</p>
        ) : null}
        {payload.skippedAt ? <p>{`本轮曾跳过合规：${payload.skippedAt}`}</p> : null}
      </div>
      {/* 选项卡 */}
      {(payload.report || hasPalette) ? (
        <div className="space-y-2">
          <div className="flex items-center bg-muted/30 rounded-md p-0.5 gap-0.5 w-fit">
            {payload.report ? (
              <button
                type="button"
                onClick={() => setActiveTab("report")}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${activeTab === "report" ? "bg-muted/60 text-foreground/80 font-medium" : "text-muted-foreground hover:text-foreground/70"}`}
              >
                合规审核报告
              </button>
            ) : null}
            {hasPalette ? (
              <button
                type="button"
                onClick={() => setActiveTab("palette")}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${activeTab === "palette" ? "bg-muted/60 text-foreground/80 font-medium" : "text-muted-foreground hover:text-foreground/70"}`}
              >
                调色盘文本对比
              </button>
            ) : null}
          </div>
          {activeTab === "report" && payload.report ? (
            <div className="space-y-2">
              <TextBlock text={payload.report} />
            </div>
          ) : null}
          {activeTab === "palette" && hasPalette ? (
            <div className="space-y-3">
              {payload.workspace.riskPhrases.length > 0 || hasDialogueReviewMarkers ? (
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span><span className="text-red-600 dark:text-red-400">▬</span> 红线</span>
                  <span><span className="text-orange-600 dark:text-orange-400">▬</span> 高风险</span>
                  <span><span className="text-yellow-600 dark:text-yellow-400">▬</span> 提示</span>
                  <span><span className="text-emerald-600 dark:text-emerald-400">▬</span> 已改写</span>
                  <span><span className="text-sky-600 dark:text-sky-400">▬</span> 对话审查</span>
                </div>
              ) : null}
              <PaletteAnnotated text={payload.workspace.paletteText} riskPhrases={payload.workspace.riskPhrases} />
            </div>
          ) : null}
        </div>
      ) : null}
      {repairRecords.length ? (
        <div className="space-y-2 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">
              修复记录
            </span>
            <span className="text-[11px] text-emerald-700/80 dark:text-emerald-300/80">
              {repairRecords.length} 条
            </span>
          </div>
          <div className="space-y-2">
            {repairRecords.map((record) => {
              const levelLabel =
                record.level === "red"
                  ? "红线"
                  : record.level === "high"
                    ? "高风险"
                    : "提示";
              const levelClass =
                record.level === "red"
                  ? "text-red-700 dark:text-red-300"
                  : record.level === "high"
                    ? "text-orange-700 dark:text-orange-300"
                    : "text-yellow-700 dark:text-yellow-300";
              return (
                <div
                  key={record.id}
                  className="space-y-1 rounded-md border border-white/[0.08] bg-black/10 px-2.5 py-2"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                    <span className={`font-medium ${levelClass}`}>{levelLabel}</span>
                    <span className="text-emerald-700 dark:text-emerald-300">
                      {record.replacement ? "已改写" : "已处理"}
                    </span>
                  </div>
                  <p className="text-xs leading-relaxed text-foreground/70">
                    <span className="text-muted-foreground">原文：</span>
                    {record.originalText}
                  </p>
                  {record.replacement ? (
                    <p className="text-xs leading-relaxed text-emerald-700 dark:text-emerald-300">
                      <span className="text-muted-foreground dark:text-emerald-300/80">改写：</span>
                      {record.replacement}
                    </p>
                  ) : (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      已标记为处理完成，当前风险不再进入待修列表。
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ArtifactCard({
  artifact,
  displayLabel,
  children,
  onArtifactAction,
  expanded,
  onToggle,
}: {
  artifact: ConversationArtifact;
  displayLabel?: string;
  children: React.ReactNode;
  onArtifactAction?: (value: string, label: string, input?: Record<string, unknown>) => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  const resolvedLabel = displayLabel ?? artifact.label;
  if (!expanded) {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-label="展开"
        className="flex w-full items-center gap-1.5 px-1 py-0.5 text-left transition-colors hover:text-foreground/80"
      >
        <ChevronDown className="h-5 w-5 shrink-0 -rotate-90 text-muted-foreground transition-transform duration-200" />
        <span className="text-sm font-medium text-foreground/70">{resolvedLabel}</span>
      </button>
    );
  }

  return (
    <div className="border-l border-border pl-3">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1.5 py-0.5 text-left"
        aria-label="收纳"
      >
        <ChevronDown className="h-5 w-5 shrink-0 text-muted-foreground transition-transform duration-200" />
        <span className="text-sm font-medium text-foreground/80">{resolvedLabel}</span>
      </button>
      <div className="mt-1.5 space-y-2 pb-1.5">
        {children}
        <ArtifactActions artifact={artifact} onArtifactAction={onArtifactAction} />
      </div>
    </div>
  );
}

function downloadMarkdown(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function statusTone(status: string): "default" | "success" | "warning" | "danger" {
  if (status === "done" || status === "resolved") return "success";
  if (status === "processing") return "warning";
  if (status === "failed" || status === "high") return "danger";
  return "default";
}

function issueTone(level: string): "default" | "warning" | "danger" {
  if (/blocking|fatal|red|红线|严重/i.test(level)) return "danger";
  if (/warning|high|risk|风险/i.test(level)) return "warning";
  return "default";
}

function isEmptyOutlinePlaceholderArtifact(artifact: ConversationArtifact): boolean {
  const payload = artifact.payload;
  return (
    artifact.kind === "outline" &&
    payload?.type === "outlines+batchProgress" &&
    payload.entries.length === 0
  );
}

function isRichEpisodePreviewArtifact(artifact: ConversationArtifact): boolean {
  return artifact.kind === "episode" && artifact.payload?.type === "episodes+batchProgress";
}

function getArtifactDisplayLabel(artifact: ConversationArtifact): string {
  if (artifact.payload?.type === "outlines+batchProgress") {
    return "单集细纲";
  }

  if (artifact.payload?.type === "episodes+batchProgress") {
    return "分集撰写";
  }

  return artifact.label;
}

// 细纲批次进度卡片（独立组件，可使用 hooks）
function OutlineBatchProgressCard({
  artifact,
  payload,
  displayLabel,
  onArtifactAction,
  expanded,
  onToggle,
  renderEditableBody,
  renderOutlineEntryCard,
}: {
  artifact: ConversationArtifact;
  payload: Extract<NonNullable<ConversationArtifact["payload"]>, { type: "outlines+batchProgress" }>;
  displayLabel: string;
  onArtifactAction?: (value: string, label: string, input?: Record<string, unknown>) => void;
  expanded: boolean;
  onToggle: () => void;
  renderEditableBody: (artifact: ConversationArtifact, body: React.ReactNode, opts?: { disableInlineEditor?: boolean }) => React.ReactNode;
  renderOutlineEntryCard: (artifact: ConversationArtifact, payload: Extract<NonNullable<ConversationArtifact["payload"]>, { type: "outlines+batchProgress" }>, entry: OutlineEntryPayload) => React.ReactNode;
}) {
  const [progressCollapsed, setProgressCollapsed] = useState(false);

  const batches = payload.batchProgress.batches;
  const doneBatches = batches.filter((b) => b.status === "done").length;
  const failedBatches = batches.filter((b) => b.status === "failed").length;
  const totalBatches = batches.length;
  const hasProcessing = batches.some((b) => b.status === "processing");
  const processingBatch = batches.find((b) => b.status === "processing");
  const nextBatch = batches.find((b) => b.status !== "done");

  const ceilPercent = totalBatches > 0
    ? Math.round(((doneBatches + (hasProcessing ? 1 : 0)) / totalBatches) * 100)
    : 0;
  const floorPercent = totalBatches > 0 ? Math.round((doneBatches / totalBatches) * 100) : 0;
  const animatedPercent = useAnimatedProgress(ceilPercent, floorPercent, hasProcessing);

  return (
    <ArtifactCard artifact={artifact} displayLabel={displayLabel} onArtifactAction={onArtifactAction} expanded={expanded} onToggle={onToggle}>
      {renderEditableBody(
        artifact,
        <div className="space-y-3">
          {/* 进度条区域 */}
          <div className="rounded border border-border bg-muted/30 p-3 space-y-2">
            {/* 标题行：状态 + 折叠箭头 */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                {processingBatch ? (
                  <span className="text-xs text-muted-foreground truncate">{`正在生成 ${buildOutlineBatchRangeLabel(processingBatch)}`}</span>
                ) : nextBatch ? (
                  <span className="text-xs text-muted-foreground truncate">{`下一批：${buildOutlineBatchRangeLabel(nextBatch)}`}</span>
                ) : (
                  <span className="text-xs text-muted-foreground">{`${doneBatches}/${totalBatches} 批次完成`}</span>
                )}
                {failedBatches > 0 && (
                  <span className="text-xs text-red-600 dark:text-red-400">{`${failedBatches} 批失败`}</span>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {processingBatch && (
                  <button
                    type="button"
                    className="text-xs text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 transition-colors"
                    onClick={() => onArtifactAction?.("script:outline-stop", "停止")}
                  >
                    停止
                  </button>
                )}
                {!hasProcessing && (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground/70 transition-colors"
                    onClick={() => onArtifactAction?.("script:outline-regenerate-all", "重新生成全部细纲")}
                  >
                    重新生成
                  </button>
                )}
                {onArtifactAction ? (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground/70 transition-colors"
                    onClick={() => onArtifactAction("script:step-enter-outlines", "打开细纲面板")}
                  >
                    {processingBatch ? "面板内继续处理" : "更多细纲选项"}
                  </button>
                ) : null}
                {false && onArtifactAction ? (
                  <button
                    type="button"
                    className="mt-1 flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground/80"
                    onClick={() => onArtifactAction("script:step-enter-episodes", "打开正文面板")}
                  >
                    <RotateCcw className="h-3 w-3" />
                    打开正文面板
                  </button>
                ) : null}
                {false && onArtifactAction ? (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground/70 transition-colors"
                    onClick={() => onArtifactAction("script:step-enter-outlines", "打开细纲面板")}
                  >
                    更多细纲选项
                  </button>
                ) : null}
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground/70 transition-colors p-0.5"
                  onClick={() => setProgressCollapsed((v) => !v)}
                  title={progressCollapsed ? "展开进度" : "收起进度"}
                >
                  <ChevronDown
                    className={`h-3.5 w-3.5 transition-transform duration-200 ${progressCollapsed ? "-rotate-90" : ""}`}
                  />
                </button>
              </div>
            </div>

            {/* 进度条 + 百分比 */}
            <div className="flex items-center gap-3">
              <Progress value={animatedPercent} className="h-1 flex-1 bg-muted/60" />
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {`${doneBatches}/${totalBatches} 批 · ${animatedPercent.toFixed(1)}%`}
              </span>
            </div>

            {/* 批次格子（可折叠） */}
            {!progressCollapsed && totalBatches > 0 && (
              <div className={`grid gap-1 ${totalBatches > 6 ? "grid-cols-4" : "grid-cols-3"}`}>
                {batches.map((batch) => (
                  <div
                    key={batch.index}
                    className={`flex items-center justify-center gap-1 rounded px-1.5 py-1 text-[10px] font-medium border transition-colors ${
                      batch.status === "done"
                        ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30"
                        : batch.status === "failed"
                        ? "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/30"
                        : batch.status === "processing"
                        ? "bg-blue-500/10 text-blue-400 border-blue-500/20 animate-pulse"
                        : "bg-muted/30 text-muted-foreground border-border"
                    }`}
                    title={batch.error || batch.label}
                  >
                    {batch.status === "processing" && <Loader2 className="h-2.5 w-2.5 animate-spin shrink-0" />}
                    <span className="truncate">{batch.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 细纲条目列表 */}
          {payload.entries.length ? (
            <div className="space-y-0.5">
              {payload.entries.map((entry) =>
                renderOutlineEntryCard(artifact, payload, entry),
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">当前批次还在生成中，已完成的单集细纲会按集数顺序出现在这里。</p>
          )}
        </div>,
        { disableInlineEditor: true },
      )}
    </ArtifactCard>
  );
}

export function ScriptArtifactPanel({
  snapshot,
  trackClassName,
  onArtifactAction,
  onSaveArtifactText,
  onRelationshipDiagramCollapsedChange,
  directBatchReviewTrigger,
  directSingleReviewTrigger,
  reviewWorkspaceOnly = false,
}: Props) {
  const [copiedExport, setCopiedExport] = useState(false);
  const [exportingDocx, setExportingDocx] = useState(false);
  const [expandedArtifactIds, setExpandedArtifactIds] = useState<string[]>([]);
  const [expandedOutlineEntryKeys, setExpandedOutlineEntryKeys] = useState<string[]>([]);
  const [expandedEpisodeEntryKeys, setExpandedEpisodeEntryKeys] = useState<string[]>([]);
  const [editingArtifactId, setEditingArtifactId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [savingArtifactId, setSavingArtifactId] = useState<string | null>(null);
  const [editingOutlineEntryKey, setEditingOutlineEntryKey] = useState<string | null>(null);
  const [outlineEntryDraft, setOutlineEntryDraft] = useState("");
  const [savingOutlineEntryKey, setSavingOutlineEntryKey] = useState<string | null>(null);
  const [outlineInstructionDrafts, setOutlineInstructionDrafts] = useState<Record<string, string>>({});
  const [collapsedDiagramArtifactIds, setCollapsedDiagramArtifactIds] = useState<string[]>([]);
  const [diagramModes, setDiagramModes] = useState<Record<string, "simple" | "detailed">>({});
  const [lightboxDiagramId, setLightboxDiagramId] = useState<string | null>(null);
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme !== "light";

  // 质量审查选项卡 state
  type ReviewTabItem = {
    id: string;
    type: "single" | "batch";
    title: string;
    epNum?: number;
    isLoading: boolean;
    result?: EpisodeQualityReviewResult;
    batchResults: Map<number, EpisodeQualityReviewResult>;
    batchProgress: { current: number; total: number; epNum: number | null; batchIdx?: number; totalBatches?: number };
  };
  const [reviewTabs, setReviewTabs] = useState<ReviewTabItem[]>([]);
  const [activeReviewTabId, setActiveReviewTabId] = useState<string | null>(null);
  const reviewAbortRefs = useRef<Map<string, AbortController>>(new Map());
  const extractSetupFromSnapshot = useCallback(() => {
    const setupArtifact = snapshot?.artifacts.find(
      (a) => a.kind === "setup" && a.payload?.type === "setup",
    );
    const p = setupArtifact?.payload?.type === "setup" ? setupArtifact.payload : null;
    return {
      genres: p?.genres ?? [],
      audience: p?.audience ?? "",
      tone: p?.tone ?? "",
      ending: p?.ending ?? "",
      totalEpisodes: p?.totalEpisodes ?? 0,
      targetMarket: p ? resolveTargetMarket(p.marketLabel) : "cn",
    };
  }, [snapshot]);

  /** 从 snapshot 中提取角色文本 */
  const extractCharactersFromSnapshot = useCallback(() => {
    const charArtifact = snapshot?.artifacts.find((a) => a.kind === "characters");
    if (!charArtifact) return "";
    if (charArtifact.payload?.type === "characters+mermaid") return charArtifact.payload.body;
    return charArtifact.content ?? "";
  }, [snapshot]);

  /** 从 snapshot 中提取目录条目 */
  const extractDirectoryFromSnapshot = useCallback(() => {
    const dirArtifact = snapshot?.artifacts.find(
      (a) => a.kind === "directory" && a.payload?.type === "directory+stats",
    );
    if (dirArtifact?.payload?.type === "directory+stats") return dirArtifact.payload.entries;
    return [];
  }, [snapshot]);

  /** 从 episodes+batchProgress artifact 中获取集内容 */
  const getEpisodeContent = useCallback((epNum: number): string => {
    const epArtifact = snapshot?.artifacts.find(
      (a) => a.kind === "episode" && a.payload?.type === "episodes+batchProgress",
    );
    if (epArtifact?.payload?.type !== "episodes+batchProgress") return "";
    return epArtifact.payload.entries.find((e) => e.number === epNum)?.content ?? "";
  }, [snapshot]);

  /** 单集质量自检 */
  const handleReview = useCallback(async (epNum: number) => {
    const content = getEpisodeContent(epNum);
    if (!content) {
      toast({ title: `第 ${epNum} 集尚未生成`, variant: "destructive" });
      return;
    }

    const tabId = `single-${epNum}`;
    const tabTitle = `质量自检 第${epNum}集`;

    // 中止同 tab 的上一次审查
    reviewAbortRefs.current.get(tabId)?.abort();
    const controller = new AbortController();
    reviewAbortRefs.current.set(tabId, controller);

    setReviewTabs((prev) => {
      const exists = prev.some((t) => t.id === tabId);
      if (exists) {
        return prev.map((t) =>
          t.id === tabId ? { ...t, isLoading: true, result: undefined, title: tabTitle } : t,
        );
      }
      const newTab: ReviewTabItem = {
        id: tabId, type: "single", title: tabTitle, epNum,
        isLoading: true, batchResults: new Map(),
        batchProgress: { current: 0, total: 0, epNum: null },
      };
      const updated = [...prev, newTab];
      return updated.length > 3 ? updated.slice(-3) : updated;
    });
    setActiveReviewTabId(tabId);

    try {
      const setup = extractSetupFromSnapshot();
      const characters = extractCharactersFromSnapshot();
      const directory = extractDirectoryFromSnapshot();
      const prevContent = getEpisodeContent(epNum - 1);
      const nextContent = getEpisodeContent(epNum + 1);

      const prompt = buildReviewPrompt(
        setup, characters, directory, epNum, content,
        prevContent || undefined, nextContent || undefined,
      );
      const model = window.localStorage.getItem("decompose-model") ?? "gemini-3.1-pro-preview";

      const finalText = await callGeminiStream(
        model,
        [{ role: "user", parts: [{ text: prompt }] }],
        () => {},
        { maxOutputTokens: 4096 },
        controller.signal,
      );

      const jsonMatch = finalText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("未能解析评分结果");
      const result: EpisodeQualityReviewResult = JSON.parse(jsonMatch[0]);
      setReviewTabs((prev) =>
        prev.map((t) => t.id === tabId ? { ...t, isLoading: false, result } : t),
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "未知错误";
      if (!msg.includes("取消") && !msg.includes("abort")) {
        toast({ title: "质量审查失败", description: msg, variant: "destructive" });
        setReviewTabs((prev) => prev.filter((t) => t.id !== tabId));
      }
    } finally {
      reviewAbortRefs.current.delete(tabId);
    }
  }, [extractSetupFromSnapshot, extractCharactersFromSnapshot, extractDirectoryFromSnapshot, getEpisodeContent]);

  /** 批量质量审查（每批最多 10 集，自动分批直到全部完成） */
  const handleBatchReview = useCallback(async (episodePayload: Extract<NonNullable<ConversationArtifact["payload"]>, { type: "episodes+batchProgress" }>) => {
    const completedEntries = episodePayload.entries
      .filter((e) => e.status === "done" && e.content)
      .sort((a, b) => a.number - b.number);

    if (!completedEntries.length) {
      toast({ title: "没有已撰写的集数可审查", variant: "destructive" });
      return;
    }

    const BATCH_SIZE = 10;
    const batches: typeof completedEntries[] = [];
    for (let i = 0; i < completedEntries.length; i += BATCH_SIZE) {
      batches.push(completedEntries.slice(i, i + BATCH_SIZE));
    }

    const tabId = `batch-${Date.now()}`;
    const tabTitle = `批量质量审查 已审查0集`;

    // 中止上一次批量审查
    reviewAbortRefs.current.get("batch")?.abort();
    const controller = new AbortController();
    reviewAbortRefs.current.set("batch", controller);
    reviewAbortRefs.current.set(tabId, controller);

    setReviewTabs((prev) => {
      const newTab: ReviewTabItem = {
        id: tabId, type: "batch", title: tabTitle,
        isLoading: true, batchResults: new Map(),
        batchProgress: { current: 0, total: completedEntries.length, epNum: null, batchIdx: 1, totalBatches: batches.length },
      };
      const updated = [...prev, newTab];
      return updated.length > 3 ? updated.slice(-3) : updated;
    });
    setActiveReviewTabId(tabId);

    const results = new Map<number, EpisodeQualityReviewResult>();
    const model = window.localStorage.getItem("decompose-model") ?? "gemini-3.1-pro-preview";
    const setup = extractSetupFromSnapshot();
    const characters = extractCharactersFromSnapshot();
    const directory = extractDirectoryFromSnapshot();

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      if (controller.signal.aborted) break;
      const batch = batches[batchIdx];

      for (let i = 0; i < batch.length; i++) {
        if (controller.signal.aborted) break;
        const entry = batch[i];
        const overallIdx = batchIdx * BATCH_SIZE + i;
        setReviewTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? { ...t, batchProgress: { current: overallIdx + 1, total: completedEntries.length, epNum: entry.number, batchIdx: batchIdx + 1, totalBatches: batches.length } }
              : t,
          ),
        );

        try {
          const prevContent = completedEntries.find((e) => e.number === entry.number - 1)?.content ?? "";
          const nextContent = completedEntries.find((e) => e.number === entry.number + 1)?.content ?? "";
          const prompt = buildReviewPrompt(
            setup, characters, directory, entry.number, entry.content!,
            prevContent || undefined, nextContent || undefined,
          );
          const finalText = await callGeminiStream(
            model,
            [{ role: "user", parts: [{ text: prompt }] }],
            () => {},
            { maxOutputTokens: 4096 },
            controller.signal,
          );
          const jsonMatch = finalText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const result: EpisodeQualityReviewResult = JSON.parse(jsonMatch[0]);
            results.set(entry.number, result);
            setReviewTabs((prev) =>
              prev.map((t) =>
                t.id === tabId
                  ? { ...t, batchResults: new Map(results), title: `批量质量审查 已审查${results.size}集` }
                  : t,
              ),
            );
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "";
          if (msg.includes("取消") || msg.includes("abort")) break;
          console.error(`批量审查第${entry.number}集失败:`, e);
        }
      }
    }

    setReviewTabs((prev) =>
      prev.map((t) => t.id === tabId ? { ...t, isLoading: false } : t),
    );
    reviewAbortRefs.current.delete("batch");
    reviewAbortRefs.current.delete(tabId);
  }, [extractSetupFromSnapshot, extractCharactersFromSnapshot, extractDirectoryFromSnapshot]);

  // 外部触发批量质量审查（directBatchReviewTrigger 计数器变化时触发）
  useEffect(() => {
    if (!directBatchReviewTrigger?.count) return;
    const epArtifact = snapshot?.artifacts.find(
      (a) => a.kind === "episode" && a.payload?.type === "episodes+batchProgress",
    );
    if (epArtifact?.payload?.type === "episodes+batchProgress") {
      void handleBatchReview(epArtifact.payload);
    } else {
      toast({ title: "没有可审查的分集数据", variant: "destructive" });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directBatchReviewTrigger?.count]);

  // 外部触发单集质量自检
  useEffect(() => {
    if (!directSingleReviewTrigger?.count) return;
    void handleReview(directSingleReviewTrigger.epNum);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directSingleReviewTrigger]);

  const visibleArtifacts = useMemo(
    () => {
      if (reviewWorkspaceOnly) return [];

      const primaryArtifacts =
        snapshot?.artifacts.filter((artifact) => PRIMARY_KINDS.has(artifact.kind)) ?? [];
      const workflowStage = snapshot ? resolveScriptWorkflowStage(snapshot.derivedStage) : null;
      const videoStage =
        snapshot?.projectKind === "video" ? resolveVisibleVideoArtifactStage(snapshot.derivedStage) : null;
      const exportStageArtifacts =
        workflowStage === "export" ? primaryArtifacts.filter((artifact) => artifact.kind === "export") : [];
      const hasDirectoryArtifact = primaryArtifacts.some((artifact) => artifact.kind === "directory");
      const hasRichEpisodePreview = primaryArtifacts.some((artifact) => isRichEpisodePreviewArtifact(artifact));
      const isOutlineStage =
        snapshot?.derivedStage === "单集细纲" || snapshot?.derivedStage === "生成单集细纲";

      if (exportStageArtifacts.length) {
        return exportStageArtifacts;
      }

      return primaryArtifacts.filter((artifact) => {
        if (hasDirectoryArtifact && !isOutlineStage && isEmptyOutlinePlaceholderArtifact(artifact)) {
          return false;
        }

        if (hasRichEpisodePreview && artifact.kind === "episode" && !isRichEpisodePreviewArtifact(artifact)) {
          return false;
        }

        if (videoStage && videoStage !== "脚本拆解" && isVideoScriptArtifact(artifact)) {
          return false;
        }

        return true;
      });
    },
    [reviewWorkspaceOnly, snapshot],
  );

  useEffect(() => {
    if (!editingArtifactId) return;
    if (!visibleArtifacts.some((artifact) => artifact.id === editingArtifactId)) {
      setEditingArtifactId(null);
      setEditDraft("");
      setSavingArtifactId(null);
    }
  }, [editingArtifactId, visibleArtifacts]);

  useEffect(() => {
    const validOutlineEntryKeys = new Set(
      visibleArtifacts.flatMap((artifact) =>
        artifact.payload?.type === "outlines+batchProgress"
          ? artifact.payload.entries.map((entry) => getOutlineEntryKey(artifact.id, entry.number))
          : [],
      ),
    );

    setExpandedOutlineEntryKeys((current) => {
      const filtered = current.filter((key) => validOutlineEntryKeys.has(key));
      const next = [...filtered];

      visibleArtifacts.forEach((artifact) => {
        if (artifact.payload?.type !== "outlines+batchProgress") return;
        if (!artifact.payload.entries.length) return;

        const hasStateForArtifact = filtered.some((key) => key.startsWith(`${artifact.id}:`));
        if (!hasStateForArtifact) {
          next.push(getOutlineEntryKey(artifact.id, artifact.payload.entries[0].number));
        }
      });

      return next;
    });

    if (editingOutlineEntryKey && !validOutlineEntryKeys.has(editingOutlineEntryKey)) {
      setEditingOutlineEntryKey(null);
      setOutlineEntryDraft("");
      setSavingOutlineEntryKey(null);
    }

    setOutlineInstructionDrafts((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => validOutlineEntryKeys.has(key)),
      ),
    );
  }, [editingOutlineEntryKey, visibleArtifacts]);

  useEffect(() => {
    const validEpisodeEntryKeys = new Set(
      visibleArtifacts.flatMap((artifact) =>
        artifact.payload?.type === "episodes+batchProgress"
          ? artifact.payload.entries.map((entry) => getEpisodeEntryKey(artifact.id, entry.number))
          : [],
      ),
    );

    setExpandedEpisodeEntryKeys((current) => {
      const filtered = current.filter((key) => validEpisodeEntryKeys.has(key));
      const next = [...filtered];

      visibleArtifacts.forEach((artifact) => {
        if (artifact.payload?.type !== "episodes+batchProgress") return;
        if (!artifact.payload.entries.length) return;

        const hasStateForArtifact = filtered.some((key) => key.startsWith(`${artifact.id}:episode:`));
        if (!hasStateForArtifact) {
          next.push(getEpisodeEntryKey(artifact.id, artifact.payload.entries[0].number));
        }
      });

      return next;
    });
  }, [visibleArtifacts]);

  useEffect(() => {
    const nextCollapsed = visibleArtifacts
      .filter(
        (artifact): artifact is ConversationArtifact & {
          payload: Extract<NonNullable<ConversationArtifact["payload"]>, { type: "characters+mermaid" }>;
        } => artifact.payload?.type === "characters+mermaid" && Boolean(artifact.payload.diagramCollapsed),
      )
      .map((artifact) => artifact.id);
    setCollapsedDiagramArtifactIds(nextCollapsed);
  }, [visibleArtifacts]);

  const handleCopyExport = useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedExport(true);
    window.setTimeout(() => setCopiedExport(false), 1500);
  }, []);

  const handleExportDocx = useCallback(async (payload: Extract<NonNullable<ConversationArtifact["payload"]>, { type: "exportSummary" }>) => {
    if (!payload.setup) return;
    setExportingDocx(true);
    try {
      const { exportToDocx } = await import("@/lib/export-docx");
      await exportToDocx(
        payload.setup,
        payload.dramaTitle,
        payload.creativePlan,
        payload.characters,
        payload.episodes,
      );
    } finally {
      setExportingDocx(false);
    }
  }, []);

  if (!snapshot || (snapshot.projectKind !== "script" && snapshot.projectKind !== "adaptation")) {
    return null;
  }

  const openArtifactEditor = (artifact: ConversationArtifact) => {
    setEditingArtifactId(artifact.id);
    setEditDraft(getEditableArtifactText(artifact));
  };

  const closeArtifactEditor = () => {
    setEditingArtifactId(null);
    setEditDraft("");
    setSavingArtifactId(null);
  };

  const openOutlineEntryEditor = (
    artifact: ConversationArtifact,
    entry: OutlineEntryPayload,
  ) => {
    const entryKey = getOutlineEntryKey(artifact.id, entry.number);
    setEditingOutlineEntryKey(entryKey);
    setOutlineEntryDraft(entry.outline?.trim() || "");
    setExpandedOutlineEntryKeys((current) =>
      current.includes(entryKey) ? current : [...current, entryKey],
    );
  };

  const closeOutlineEntryEditor = () => {
    setEditingOutlineEntryKey(null);
    setOutlineEntryDraft("");
    setSavingOutlineEntryKey(null);
  };

  const toggleOutlineEntry = (artifactId: string, episodeNumber: number) => {
    const entryKey = getOutlineEntryKey(artifactId, episodeNumber);
    setExpandedOutlineEntryKeys((current) =>
      current.includes(entryKey)
        ? current.filter((key) => key !== entryKey)
        : [...current, entryKey],
    );
  };

  const updateOutlineInstructionDraft = (entryKey: string, value: string) => {
    setOutlineInstructionDrafts((current) => ({
      ...current,
      [entryKey]: value,
    }));
  };

  const toggleDiagramCollapse = async (artifactId: string) => {
    const nextCollapsed = !collapsedDiagramArtifactIds.includes(artifactId);
    setCollapsedDiagramArtifactIds((current) =>
      nextCollapsed
        ? [...current, artifactId]
        : current.filter((id) => id !== artifactId),
    );
    await onRelationshipDiagramCollapsedChange?.(nextCollapsed);
  };

  const saveArtifactText = async (artifact: ConversationArtifact) => {
    const field = artifact.editor?.field;
    if (!field || !onSaveArtifactText) return;
    const nextText = editDraft.trim();
    if (!nextText) return;
    setSavingArtifactId(artifact.id);
    try {
      await onSaveArtifactText(field, artifact.label, nextText);
      closeArtifactEditor();
    } catch {
      // The parent surface already reports save failures.
    } finally {
      setSavingArtifactId(null);
    }
  };

  const saveOutlineEntryText = async (
    artifact: ConversationArtifact,
    payload: Extract<
      NonNullable<ConversationArtifact["payload"]>,
      { type: "outlines+batchProgress" }
    >,
    episodeNumber: number,
  ) => {
    if (!onSaveArtifactText) return;
    const nextText = outlineEntryDraft.trim();
    if (!nextText) return;

    const entryKey = getOutlineEntryKey(artifact.id, episodeNumber);
    setSavingOutlineEntryKey(entryKey);
    try {
      await onSaveArtifactText(
        "outlines",
        artifact.label,
        buildOutlineEntrySaveText(payload, episodeNumber, nextText),
      );
      closeOutlineEntryEditor();
    } catch {
      // The parent surface already reports save failures.
    } finally {
      setSavingOutlineEntryKey(null);
    }
  };

  const regenerateOutlineEntry = (
    artifact: ConversationArtifact,
    entry: OutlineEntryPayload,
  ) => {
    if (!onArtifactAction) return;
    const entryKey = getOutlineEntryKey(artifact.id, entry.number);
    const customInstruction = outlineInstructionDrafts[entryKey]?.trim();

    onArtifactAction(
      `script:outline-regenerate:${entry.number}`,
      `重新生成第 ${entry.number} 集细纲`,
      {
        episodeNumber: entry.number,
        keepCurrentStep: true,
        ...(customInstruction ? { customInstruction } : {}),
      },
    );
  };

  const renderEditableBody = (
    artifact: ConversationArtifact,
    body: React.ReactNode,
    options?: { disableInlineEditor?: boolean },
  ) => {
    const editableField = artifact.editor?.field ?? null;
    const editable = Boolean(editableField && onSaveArtifactText && !options?.disableInlineEditor);
    const editing = editingArtifactId === artifact.id;
    const sourceText = getEditableArtifactText(artifact).trim();
    const draftChanged = editDraft.trim() !== sourceText;

    return (
      <div className="space-y-2">
        {editable ? (
          <div className="flex flex-wrap items-center gap-2">
            {!editing ? (
              <button
                type="button"
                className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground/80"
                onClick={() => openArtifactEditor(artifact)}
              >
                <PencilLine className="h-3 w-3" />
                编辑文本
              </button>
            ) : (
              <>
                <span className="text-xs text-muted-foreground">编辑中</span>
                {editableField === "characters" || editableField === "characterTransform" ? (
                  <span className="text-xs text-muted-foreground/60">
                    关系图 Mermaid 代码会和角色文本一起保存并刷新。
                  </span>
                ) : null}
              </>
            )}
          </div>
        ) : null}
        {editing ? (
          <div className="space-y-2">
            <Textarea
              value={editDraft}
              onChange={(event) => setEditDraft(event.target.value)}
              rows={18}
              spellCheck={false}
              className="min-h-[260px] resize-y border-border bg-muted/30 text-sm leading-6 text-foreground"
            />
            <div className="flex flex-wrap items-center justify-end gap-4">
              <button
                type="button"
                className="text-xs text-muted-foreground transition-colors hover:text-foreground/80"
                onClick={closeArtifactEditor}
              >
                取消
              </button>
              <button
                type="button"
                disabled={!editDraft.trim() || !draftChanged || savingArtifactId === artifact.id}
                className="flex items-center gap-1 text-xs text-foreground/80 transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => void saveArtifactText(artifact)}
              >
                {savingArtifactId === artifact.id ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : null}
                保存文本
              </button>
            </div>
          </div>
        ) : (
          body
        )}
      </div>
    );
  };

  const renderOutlineEntryCard = (
    artifact: ConversationArtifact,
    payload: Extract<
      NonNullable<ConversationArtifact["payload"]>,
      { type: "outlines+batchProgress" }
    >,
    entry: OutlineEntryPayload,
  ) => {
    const entryKey = getOutlineEntryKey(artifact.id, entry.number);
    const expanded = expandedOutlineEntryKeys.includes(entryKey);
    const editing = editingOutlineEntryKey === entryKey;
    const draftChanged = outlineEntryDraft.trim() !== (entry.outline?.trim() || "");
    const instructionDraft = outlineInstructionDrafts[entryKey] ?? "";

    const hasOutline = Boolean(entry.outline?.trim());

    return (
      <div key={entry.number}>
        <button
          type="button"
          onClick={() => toggleOutlineEntry(artifact.id, entry.number)}
          className="flex w-full items-center gap-2 py-1 text-left transition-colors hover:text-foreground/80"
          aria-expanded={expanded}
          aria-controls={`outline-entry-panel-${artifact.id}-${entry.number}`}
        >
          <ChevronDown
            className={cn("h-5 w-5 shrink-0 text-muted-foreground transition-transform", expanded ? "" : "-rotate-90")}
          />
          <span className="tabular-nums text-xs text-muted-foreground">{String(entry.number).padStart(2, "0")}</span>
          <span className="font-medium text-sm text-foreground/80">{entry.title}</span>
          <StatusBadge tone={hasOutline ? "success" : "default"} className="shrink-0 text-[10px]">
            {hasOutline ? "已生成" : "待生成"}
          </StatusBadge>
        </button>

        {expanded ? (
          <div
            id={`outline-entry-panel-${artifact.id}-${entry.number}`}
            className="ml-5 space-y-3 border-l border-border pl-3 pb-3 pt-1"
          >
            {entry.summary ? <p className="text-xs text-muted-foreground">{entry.summary}</p> : null}
            {editing ? (
              <div className="space-y-2">
                <Textarea
                  value={outlineEntryDraft}
                  onChange={(event) => setOutlineEntryDraft(event.target.value)}
                  rows={8}
                  spellCheck={false}
                  className="min-h-[180px] resize-y border-border bg-muted/30 text-sm leading-6 text-foreground"
                />
                <div className="flex flex-wrap items-center justify-end gap-4">
                  <button
                    type="button"
                    className="text-xs text-muted-foreground transition-colors hover:text-foreground/80"
                    onClick={closeOutlineEntryEditor}
                  >取消</button>
                  <button
                    type="button"
                    disabled={!outlineEntryDraft.trim() || !draftChanged || savingOutlineEntryKey === entryKey}
                    className="flex items-center gap-1 text-xs text-foreground/80 transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={() => void saveOutlineEntryText(artifact, payload, entry.number)}
                  >
                    {savingOutlineEntryKey === entryKey ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                    保存本集
                  </button>
                </div>
              </div>
            ) : hasOutline ? (
              <div className="prose prose-neutral dark:prose-invert prose-sm max-w-none [&_h1]:text-base [&_h1]:font-semibold [&_h1]:text-foreground [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-foreground [&_h3]:text-sm [&_h3]:font-medium [&_h3]:text-foreground/80 [&_p]:text-foreground/70 [&_p]:leading-relaxed [&_li]:text-foreground/70 [&_strong]:text-foreground [&_strong]:font-medium [&_table]:border-collapse [&_th]:border [&_th]:border-border [&_th]:bg-muted/40 [&_th]:px-2 [&_th]:py-1 [&_th]:text-foreground/80 [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:text-foreground/70 [&_tr:hover_td]:bg-muted/20">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.outline}</ReactMarkdown>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">待生成</p>
            )}

            {hasOutline && !editing ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground/80"
                  onClick={() => openOutlineEntryEditor(artifact, entry)}
                >
                  <PencilLine className="h-3 w-3" />
                  编辑
                </button>
                <input
                  type="text"
                  value={instructionDraft}
                  onChange={(event) => updateOutlineInstructionDraft(entryKey, event.target.value)}
                  placeholder="调整指令，如：加强冲突、压缩铺垫……"
                  className="h-6 flex-1 rounded border border-border bg-muted/20 px-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-border"
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  const toggleEpisodeEntry = (artifactId: string, episodeNumber: number) => {
    const entryKey = getEpisodeEntryKey(artifactId, episodeNumber);
    setExpandedEpisodeEntryKeys((current) =>
      current.includes(entryKey)
        ? current.filter((key) => key !== entryKey)
        : [...current, entryKey],
    );
  };

  const renderEpisodeEntryCard = (
    artifact: ConversationArtifact,
    payload: Extract<
      NonNullable<ConversationArtifact["payload"]>,
      { type: "episodes+batchProgress" }
    >,
    entry: EpisodeBatchEntryPayload,
  ) => {
    const entryKey = getEpisodeEntryKey(artifact.id, entry.number);
    const expanded = expandedEpisodeEntryKeys.includes(entryKey);
    const isDone = entry.status === "done";
    const previewText = entry.content?.trim() || entry.outline?.trim() || entry.summary?.trim() || "尚未开始生成";

    return (
      <div key={entry.number}>
        <button
          type="button"
          onClick={() => toggleEpisodeEntry(artifact.id, entry.number)}
          className="flex w-full items-center gap-2 py-1 text-left transition-colors hover:text-foreground/80"
          aria-expanded={expanded}
          aria-controls={`episode-entry-panel-${artifact.id}-${entry.number}`}
        >
          <ChevronDown
            className={cn("h-5 w-5 shrink-0 text-muted-foreground transition-transform", expanded ? "" : "-rotate-90")}
          />
          <span className="tabular-nums text-xs text-muted-foreground">{String(entry.number).padStart(2, "0")}</span>
          <span className="font-medium text-sm text-foreground/80">{entry.title}</span>
          <StatusBadge tone={isDone ? "success" : "default"} className="shrink-0 text-[10px]">
            {isDone ? "已完成" : "未开始"}
          </StatusBadge>
        </button>

        {expanded ? (
          <div
            id={`episode-entry-panel-${artifact.id}-${entry.number}`}
            className="ml-5 space-y-2 border-l border-border pl-3 pb-3 pt-1"
          >
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <Metric label="目标时长" value={payload.durationSeconds ? `${payload.durationSeconds} 秒` : "60 秒（默认）"} />
              <Metric label="字数" value={entry.wordCount?.toLocaleString() ?? "—"} />
            </div>
            <div className="text-sm leading-relaxed text-foreground/80 whitespace-pre-wrap">{previewText}</div>
            {false && onArtifactAction ? (
              <button
                type="button"
                className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground/80"
                onClick={() => onArtifactAction(`script:episode-generate:${entry.number}`, `${isDone ? "重新生成" : "生成"}第 ${entry.number} 集`)}>
                {isDone ? <RotateCcw className="h-3 w-3" /> : <PlayCircle className="h-3 w-3" />}
                {isDone ? "重新生成" : "生成本集"}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  const renderRichArtifact = (artifact: ConversationArtifact) => {
    const payload = artifact.payload;
    const displayLabel = getArtifactDisplayLabel(artifact);
    const expanded = expandedArtifactIds.includes(artifact.id);
    const onToggle = () =>
      setExpandedArtifactIds((current) =>
        current.includes(artifact.id)
          ? current.filter((id) => id !== artifact.id)
          : [...current, artifact.id],
      );

    if (!payload || artifact.presentation !== "script-rich") {
      return (
        <ArtifactCard artifact={artifact} displayLabel={displayLabel} onArtifactAction={onArtifactAction} expanded={expanded} onToggle={onToggle}>
          {renderEditableBody(
            artifact,
            <TextBlock text={artifact.content || artifact.summary} />,
          )}
        </ArtifactCard>
      );
    }

    if (payload.type === "setup") {
      return (
        <ArtifactCard artifact={artifact} displayLabel={displayLabel} onArtifactAction={onArtifactAction} expanded={expanded} onToggle={onToggle}>
          {renderEditableBody(
            artifact,
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <Metric label="模式" value={payload.mode === "adaptation" ? "改编" : "原创"} />
              <Metric label="目标市场" value={payload.marketLabel} />
              <Metric label="受众" value={payload.audience} />
              <Metric label="基调" value={payload.tone} />
              <Metric label="结局" value={payload.ending} />
              <Metric label="总集数" value={payload.totalEpisodes || "未识别"} />
              <Metric label="题材" value={payload.genres.join(" / ") || payload.customTopic || "待补充"} />
              {payload.referenceStructure ? (
                <div className="mt-3 w-full">
                  <TextBlock text={payload.referenceStructure} />
                </div>
              ) : null}
            </div>,
          )}
        </ArtifactCard>
      );
    }

    if (payload.type === "characters+mermaid") {
      const diagramCollapsed = collapsedDiagramArtifactIds.includes(artifact.id);
      const hasDetailed = Boolean(payload.detailedMermaidCode?.trim());
      const currentMode = diagramModes[artifact.id] ?? "simple";
      const activeCode = currentMode === "detailed" && hasDetailed
        ? payload.detailedMermaidCode!
        : (payload.mermaidCode ?? "");
      return (
        <ArtifactCard artifact={artifact} displayLabel={displayLabel} onArtifactAction={undefined} expanded={expanded} onToggle={onToggle}>
          {renderEditableBody(
            artifact,
            <div className="space-y-3">
              <TextBlock text={payload.body} />
              {payload.mermaidCode?.trim() ? (
                <div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void toggleDiagramCollapse(artifact.id)}
                      className="flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground/70 transition-colors"
                    >
                      <GitBranch className="h-3 w-3" />
                      人物关系图
                      <ChevronDown className={cn("h-4 w-4 transition-transform", diagramCollapsed ? "-rotate-90" : "")} />
                    </button>
                    {!diagramCollapsed ? (
                      <>
                        <div className="flex items-center gap-0 rounded-md border border-border overflow-hidden text-xs">
                          <button
                            type="button"
                            onClick={() => setDiagramModes((m) => ({ ...m, [artifact.id]: "simple" }))}
                            className={cn(
                              "px-2 py-0.5 transition-colors",
                              currentMode === "simple"
                                ? "bg-primary/15 text-primary font-medium"
                                : "text-muted-foreground hover:text-foreground/70",
                            )}
                          >
                            简单
                          </button>
                          <span className="w-px h-3 bg-border" />
                          <button
                            type="button"
                            onClick={() => hasDetailed && setDiagramModes((m) => ({ ...m, [artifact.id]: "detailed" }))}
                            disabled={!hasDetailed}
                            title={hasDetailed ? undefined : "重新生成角色档案以获取完整详细版（含 NPC）"}
                            className={cn(
                              "px-2 py-0.5 transition-colors",
                              currentMode === "detailed" && hasDetailed
                                ? "bg-primary/15 text-primary font-medium"
                                : "text-muted-foreground",
                              hasDetailed ? "hover:text-foreground/70" : "opacity-40 cursor-not-allowed",
                            )}
                          >
                            详细
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => setLightboxDiagramId(artifact.id)}
                          title="放大查看"
                          className="rounded p-0.5 text-muted-foreground hover:text-foreground/70 hover:bg-muted transition-colors"
                        >
                          <Maximize2 className="h-3.5 w-3.5" />
                        </button>
                      </>
                    ) : null}
                  </div>
                  {!diagramCollapsed ? (
                    <div className="mt-2">
                      <MermaidDiagram
                        simpleCode={payload.mermaidCode ?? ""}
                        detailedCode={payload.detailedMermaidCode}
                        isDark={isDark}
                        lightboxOpen={lightboxDiagramId === artifact.id}
                        onCloseLightbox={() => setLightboxDiagramId(null)}
                        externalMode={currentMode}
                        onModeChange={(mode) => setDiagramModes((m) => ({ ...m, [artifact.id]: mode }))}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>,
          )}
        </ArtifactCard>
      );
    }

    if (payload.type === "directory+stats") {
      const totalEps = payload.stats.totalEpisodes;
      const hookDist = buildHookDistribution(payload.entries);
      const rhythmSegs = buildRhythmSegments(totalEps);

      return (
        <ArtifactCard artifact={artifact} displayLabel={displayLabel} onArtifactAction={undefined} expanded={expanded} onToggle={onToggle}>
          {renderEditableBody(
            artifact,
            <>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <Metric label="总集数" value={totalEps} />
                <Metric label="已细纲/正文" value={`${payload.stats.outlinedEpisodes}/${payload.stats.writtenEpisodes}`} />
                <Metric label="关键/高潮/付费" value={`${payload.stats.keyEpisodes}/${payload.stats.climaxEpisodes}/${payload.stats.paywallEpisodes}`} />
              </div>
              <div className="mt-2 space-y-2">
                {payload.entries.map((entry) => (
                  <div key={entry.number} className="text-sm text-foreground/70">
                    <span className="tabular-nums text-muted-foreground">{String(entry.number).padStart(2, "0")}.</span>
                    <span className="ml-2 font-medium text-foreground/80">{entry.title}</span>
                    {entry.summary ? <span className="ml-2 text-muted-foreground">{entry.summary.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')}</span> : null}
                  </div>
                ))}
              </div>
              {hookDist.length ? (
                <>
                  <hr className="border-t border-border/60" />
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <BarChart3 className="h-3 w-3" />
                      钩子类型分布
                    </div>
                    <div className="space-y-2">
                      {hookDist.map((row) => (
                        <DistributionRow
                          key={row.label}
                          label={row.label}
                          countLabel={`${row.count} 集`}
                          detailLabel={`${row.percentage}%`}
                          percentage={row.percentage}
                          accentClassName={row.accentClassName}
                          softClassName={row.softClassName}
                        />
                      ))}
                    </div>
                  </div>
                </>
              ) : null}
              {rhythmSegs.length ? (
                <>
                  <hr className="border-t border-border/60" />
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <BarChart3 className="h-3 w-3" />
                      节奏段落分布
                    </div>
                    <div className="space-y-2">
                      {rhythmSegs.map((seg) => (
                        <DistributionRow
                          key={seg.key}
                          label={seg.label}
                          countLabel={`${seg.count} 集`}
                          detailLabel={`第 ${seg.start}–${seg.end} 集`}
                          percentage={Math.round((seg.count / Math.max(totalEps, 1)) * 100)}
                          accentClassName={seg.accentClassName}
                          softClassName={seg.softClassName}
                        />
                      ))}
                    </div>
                  </div>
                </>
              ) : null}
              {payload.entries.length ? (
                <>
                  <hr className="border-t border-border/60" />
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Activity className="h-3 w-3" />
                      情绪波形图
                      <span className="text-muted-foreground/60">· 情绪 1–5 · 高潮/付费/关键集高亮</span>
                    </div>
                    <EmotionWaveChart entries={payload.entries} />
                  </div>
                </>
              ) : null}
            </>,
          )}
        </ArtifactCard>
      );
    }

    if (payload.type === "outlines+batchProgress") {
      return (
        <OutlineBatchProgressCard
          artifact={artifact}
          payload={payload}
          displayLabel={displayLabel}
          onArtifactAction={onArtifactAction}
          expanded={expanded}
          onToggle={onToggle}
          renderEditableBody={renderEditableBody}
          renderOutlineEntryCard={renderOutlineEntryCard}
        />
      );
    }

    if (payload.type === "episodes+batchProgress") {
      const doneCount = payload.entries.filter((e) => e.status === "done").length;
      return (
        <ArtifactCard artifact={artifact} displayLabel={displayLabel} onArtifactAction={onArtifactAction} expanded={expanded} onToggle={onToggle}>
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <Progress value={payload.batchProgress.percent} className="h-1 flex-1 bg-muted/60" />
              <span className="shrink-0 text-xs text-muted-foreground">
                {`${payload.batchProgress.done}/${payload.batchProgress.total} 集 · ${payload.batchProgress.percent}%`}
              </span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <Metric label="已完成" value={`${payload.batchProgress.done}/${payload.totalEpisodes}`} />
              <Metric label="待生成" value={Math.max(payload.totalEpisodes - payload.batchProgress.done, 0)} />
              <Metric label="单集时长" value={payload.durationSeconds ? `${payload.durationSeconds} 秒` : "60 秒（默认）"} />
            </div>
            {doneCount >= 2 && onArtifactAction ? (
              <button
                type="button"
                className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground/80"
                onClick={() => onArtifactAction("script:episode-review", "批量质量审查")}
              >
                <BarChart3 className="h-3 w-3" />
                批量质量审查
              </button>
            ) : null}
            {payload.entries.length ? (
              <div className="space-y-0.5">
                {payload.entries.map((entry) => renderEpisodeEntryCard(artifact, payload, entry))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">分集撰写预览已经创建，当前还没有可展示的分集条目。</p>
            )}
          </div>
        </ArtifactCard>
      );
    }

    if (payload.type === "episodeReview") {
      return (
        <ArtifactCard artifact={artifact} displayLabel={displayLabel} onArtifactAction={onArtifactAction} expanded={expanded} onToggle={onToggle}>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <Metric label="已质检" value={`${payload.summary.reviewedCount} 集`} />
            <Metric label="平均分" value={payload.summary.averageTotal.toFixed(1)} />
            <Metric label="风险" value={`${payload.summary.riskCounts.blocking}/${payload.summary.riskCounts.warning}/${payload.summary.riskCounts.suggestion}`} />
          </div>
          <div className="mt-3 space-y-2">
            {payload.packets.map((packet) => {
              const rewriteInstruction = packet.rewriteInstruction.trim();
              return (
                <div key={packet.id} className="space-y-2 border-l border-border/70 pl-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground/80">{`第 ${packet.episodeNumber} 集 · ${packet.title}`}</span>
                    <StatusBadge tone={packet.result.total >= 40 ? "success" : packet.result.total >= 30 ? "warning" : "danger"}>
                      {`${packet.result.grade} ${packet.result.total}/50`}
                    </StatusBadge>
                  </div>
                  <SingleReviewContent
                    reviewResult={packet.result}
                    reviewEpNum={packet.episodeNumber}
                    onClose={() => undefined}
                  />
                  {rewriteInstruction ? (
                    <div className="space-y-1 rounded-md border border-border/60 bg-muted/20 p-2 text-xs">
                      <p className="text-muted-foreground">原始修复指令</p>
                      <div className="whitespace-pre-wrap break-words leading-relaxed text-muted-foreground">{rewriteInstruction}</div>
                    </div>
                  ) : null}
                  {onArtifactAction ? (
                    <button
                      type="button"
                      className="mt-1 flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground/80"
                      onClick={() => onArtifactAction("script:step-enter-episodes", "打开正文面板")}
                    >
                      <RotateCcw className="h-3 w-3" />
                      打开正文面板
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </ArtifactCard>
      );
    }

    if (payload.type === "complianceSummary") {
      return (
        <ArtifactCard artifact={artifact} displayLabel={displayLabel} onArtifactAction={onArtifactAction} expanded={expanded} onToggle={onToggle}>
          <ComplianceSummaryContent payload={payload} onArtifactAction={onArtifactAction} />
        </ArtifactCard>
      );
    }

    return (
      <ArtifactCard artifact={artifact} displayLabel={displayLabel} onArtifactAction={onArtifactAction} expanded={expanded} onToggle={onToggle}>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <Metric label="完成集数" value={`${payload.completedEpisodes}/${payload.totalEpisodes || payload.completedEpisodes}`} />
          <Metric label="总字数" value={payload.totalWordCount.toLocaleString()} />
          <Metric label="剧名" value={payload.dramaTitle || "未命名"} />
          <Metric label="导出形态" value={payload.exportDocument ? "AI 整合稿" : "快速拼接稿"} />
        </div>
        <div className="mt-3 space-y-1 text-xs text-muted-foreground">
          <p>{`合规状态：${payload.complianceStatus}`}</p>
          {payload.complianceStatus === "skipped" ? (
            <p>{`本次已跳过合规审查${payload.skippedAt ? `（${payload.skippedAt}）` : ""}。`}</p>
          ) : payload.complianceStatus === "pending" ? (
            <p>当前导出尚未完成完整合规审查，仍可返回第 7 步继续处理。</p>
          ) : (
            <p>当前项目已完成合规审查，可以直接导出与桥接视频。</p>
          )}
        </div>
        {payload.patchPlan ? (
          <div className="mt-3 space-y-1">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium text-foreground/80">导出补写路径</span>
              <StatusBadge tone={payload.patchPlan.readyForExport ? "success" : "warning"}>
                {payload.patchPlan.readyForExport ? "可继续导出" : "仍有待处理缺口"}
              </StatusBadge>
            </div>
            <p className="text-sm text-muted-foreground">{payload.patchPlan.summary}</p>
            {payload.patchPlan.entries.map((entry) => (
              <div key={entry.id} className="text-sm">
                <span className="font-medium text-foreground/80">{entry.title}</span>
                <span className="ml-2 text-xs text-muted-foreground">{entry.summary}</span>
                {false && entry.action && onArtifactAction ? (
                  <button
                    type="button"
                    className="ml-2 text-xs text-muted-foreground transition-colors hover:text-foreground/80"
                    onClick={() => onArtifactAction(entry.action.value, entry.action.label)}>
                    {entry.action.label}
                  </button>
                ) : null}
              </div>
            ))}
            {false && !payload.patchPlan.entries.length && payload.patchPlan.recommendedAction && onArtifactAction ? (
              <button
                type="button"
                className="mt-1 text-xs text-muted-foreground transition-colors hover:text-foreground/80"
                onClick={() => onArtifactAction(payload.patchPlan.recommendedAction!.value, payload.patchPlan.recommendedAction!.label)}>
                {payload.patchPlan.recommendedAction.label}
              </button>
            ) : null}
          </div>
        ) : null}
        <hr className="border-t border-border/60" />
        <div className="flex flex-wrap gap-4">
          <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground/80" onClick={() => void handleCopyExport(payload.quickExportMarkdown)}>
            <Copy className="h-3 w-3" />
            {copiedExport ? "已复制" : "复制快速导出"}
          </button>
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground/80"
            onClick={() => downloadMarkdown(`${payload.dramaTitle || "script"}.md`, payload.exportDocument || payload.quickExportMarkdown)}>
            <Download className="h-3 w-3" />Markdown 下载
          </button>
          <button
            type="button"
            disabled={!payload.setup || exportingDocx}
            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground/80 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => void handleExportDocx(payload)}>
            {exportingDocx ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileText className="h-3 w-3" />}
            Word 导出
          </button>
          {false && onArtifactAction ? (
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground/80"
              onClick={() => onArtifactAction("script:export-video", "用于视频创作")}>
              <PlayCircle className="h-3 w-3" />用于视频创作
            </button>
          ) : null}
        </div>
        <hr className="border-t border-border/60" />
        <div>
          <TextBlock text={payload.exportDocument || payload.quickExportMarkdown} />
        </div>
      </ArtifactCard>
    );
  };

  return (
    <div className={cn("mx-auto w-full space-y-0.5", trackClassName)}>
      {visibleArtifacts.map((artifact) => (
        <div key={artifact.id}>{renderRichArtifact(artifact)}</div>
      ))}

      {/* 质量审查 — 可折叠卡片风格，与上方三个 artifact 卡片保持一致 */}
      {reviewTabs.map((tab) => {
        const isExpanded = activeReviewTabId === tab.id;
        const closeTab = () => {
          reviewAbortRefs.current.get(tab.id)?.abort();
          setReviewTabs((prev) => {
            const next = prev.filter((t) => t.id !== tab.id);
            if (activeReviewTabId === tab.id) setActiveReviewTabId(next[next.length - 1]?.id ?? null);
            return next;
          });
        };

        if (!isExpanded) {
          return (
            <div key={tab.id} className="flex w-full items-center gap-1.5 px-1 py-0.5">
              <button
                type="button"
                onClick={() => setActiveReviewTabId(tab.id)}
                className="flex flex-1 items-center gap-1.5 text-left transition-colors hover:text-foreground/80"
              >
                <ChevronDown className="h-5 w-5 shrink-0 -rotate-90 text-muted-foreground transition-transform duration-200" />
                {tab.isLoading && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />}
                <span className="text-sm font-medium text-foreground/70">{tab.title}</span>
              </button>
              <button type="button" className="shrink-0 px-1 text-muted-foreground/60 transition-colors hover:text-muted-foreground" onClick={closeTab}>×</button>
            </div>
          );
        }

        return (
          <div key={tab.id} className="border-l border-border pl-3">
            <div className="flex items-center gap-1.5 py-0.5">
              <button
                type="button"
                onClick={() => setActiveReviewTabId(null)}
                className="flex flex-1 items-center gap-1.5 text-left"
              >
                <ChevronDown className="h-5 w-5 shrink-0 text-muted-foreground transition-transform duration-200" />
                {tab.isLoading && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />}
                <span className="text-sm font-medium text-foreground/80">{tab.title}</span>
              </button>
              <button type="button" className="shrink-0 px-1 text-muted-foreground/60 transition-colors hover:text-muted-foreground" onClick={closeTab}>×</button>
            </div>
            <div className="mt-1.5 space-y-2 pb-1.5">
              {/* 加载中 */}
              {tab.isLoading && !tab.result && tab.batchResults.size === 0 && (
                <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {tab.type === "batch" && tab.batchProgress.epNum != null
                    ? `正在审查第 ${tab.batchProgress.epNum} 集… (${tab.batchProgress.current}/${tab.batchProgress.total})`
                    : "正在审查中，请稍候…"}
                </div>
              )}
              {/* 批量进度条（有结果时也显示） */}
              {tab.type === "batch" && tab.isLoading && tab.batchResults.size > 0 && (
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {tab.batchProgress.totalBatches != null && tab.batchProgress.totalBatches > 1
                      ? `第${tab.batchProgress.batchIdx}批/共${tab.batchProgress.totalBatches}批 · `
                      : ""}
                    {tab.batchProgress.current}/{tab.batchProgress.total}
                    {tab.batchProgress.epNum != null ? ` · 正在审查第 ${tab.batchProgress.epNum} 集…` : ""}
                  </span>
                  <button
                    type="button"
                    className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground/70"
                    onClick={() => reviewAbortRefs.current.get(tab.id)?.abort()}
                  >
                    <Square className="h-3 w-3" />停止
                  </button>
                </div>
              )}
              {/* 单集结果 */}
              {tab.type === "single" && tab.result && (
                <SingleReviewContent
                  reviewResult={tab.result}
                  reviewEpNum={tab.epNum ?? null}
                  onClose={closeTab}
                />
              )}
              {/* 批量结果 */}
              {tab.type === "batch" && tab.batchResults.size > 0 && (
                <BatchReviewContent
                  batchReviewResults={tab.batchResults}
                  onClose={closeTab}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
