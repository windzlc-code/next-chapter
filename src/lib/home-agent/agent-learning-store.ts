import type { DramaProject } from "@/types/drama";
import type { EpisodeQualityReviewPacket, ComplianceRevisionPacket } from "@/types/drama";
import type { AssistantFeedbackLogEntry } from "./assistant-feedback-log";

// ─── 数据结构 ────────────────────────────────────────────────────────────────

export interface QualityPattern {
  id: string;
  ts: string;
  sourceProjectId: string;
  genres: string[];
  targetMarket: string;
  audience: string;
  tone: string;
  weakDimensions: string[];
  strongDimensions: string[];
  issuePatterns: string[];
  avgScore: number;
  grade: string;
}

export interface ComplianceRiskMemory {
  id: string;
  ts: string;
  sourceProjectId: string;
  genres: string[];
  targetMarket: string;
  riskLevel: "high" | "medium" | "low";
  issueTitle: string;
  recommendation: string;
}

export interface UserPreferenceSignal {
  ts: string;
  messageId: string;
  action: "up" | "down";
  contentPreview: string;
}

export interface UserPreferenceStore {
  signals: UserPreferenceSignal[];
  positiveKeywords: string[];
  negativeKeywords: string[];
  lastUpdated: string;
}

// ─── Storage Keys ────────────────────────────────────────────────────────────

const QUALITY_KEY = "storyforge-agent-quality-patterns-v1";
const COMPLIANCE_KEY = "storyforge-agent-compliance-memory-v1";
const PREFS_KEY = "storyforge-agent-user-prefs-v1";

const MAX_QUALITY = 200;
const MAX_COMPLIANCE = 150;
const MAX_SIGNALS = 100;

// ─── 工具函数 ────────────────────────────────────────────────────────────────

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

function safeRead<T>(key: string): T[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function safeWrite(key: string, data: unknown): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    /* quota or privacy mode */
  }
}

// ─── 质量模式 ────────────────────────────────────────────────────────────────

export function recordQualityPattern(
  project: DramaProject,
  packet: EpisodeQualityReviewPacket,
): void {
  if (!project.setup) return;
  const { genres, targetMarket, audience, tone } = project.setup;
  const { scores, total, grade, issues } = packet.result;

  const DIMS = ["rhythm", "satisfaction", "dialogue", "format", "continuity"] as const;
  const weakDimensions = DIMS.filter((d) => (scores[d]?.score ?? 10) < 6);
  const strongDimensions = DIMS.filter((d) => (scores[d]?.score ?? 0) >= 8);
  const issuePatterns = issues.map((i) => trunc(i.description, 80)).filter(Boolean);

  const pattern: QualityPattern = {
    id: `${project.id}-ep${packet.episodeNumber}-${Date.now()}`,
    ts: new Date().toISOString(),
    sourceProjectId: project.id,
    genres,
    targetMarket,
    audience,
    tone,
    weakDimensions,
    strongDimensions,
    issuePatterns,
    avgScore: Math.round((total / 5) * 10) / 10,
    grade,
  };

  const existing = safeRead<QualityPattern>(QUALITY_KEY);
  safeWrite(QUALITY_KEY, [...existing, pattern].slice(-MAX_QUALITY));
}

export function readQualityPatterns(): QualityPattern[] {
  return safeRead<QualityPattern>(QUALITY_KEY);
}

// ─── 合规风险记忆 ─────────────────────────────────────────────────────────────

export function recordComplianceRisks(
  project: DramaProject,
  packets: ComplianceRevisionPacket[],
): void {
  if (!project.setup) return;
  const { genres, targetMarket } = project.setup;
  const highRisk = packets.filter((p) => p.riskLevel === "high");
  if (!highRisk.length) return;

  const existing = safeRead<ComplianceRiskMemory>(COMPLIANCE_KEY);
  const existingTitles = new Set(existing.map((r) => r.issueTitle));

  const newRisks: ComplianceRiskMemory[] = highRisk
    .filter((p) => !existingTitles.has(trunc(p.issueTitle, 60)))
    .map((p) => ({
      id: `${project.id}-compliance-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      ts: new Date().toISOString(),
      sourceProjectId: project.id,
      genres,
      targetMarket,
      riskLevel: p.riskLevel,
      issueTitle: trunc(p.issueTitle, 60),
      recommendation: trunc(p.recommendation, 120),
    }));

  if (!newRisks.length) return;
  safeWrite(COMPLIANCE_KEY, [...existing, ...newRisks].slice(-MAX_COMPLIANCE));
}

export function readComplianceRisks(): ComplianceRiskMemory[] {
  return safeRead<ComplianceRiskMemory>(COMPLIANCE_KEY);
}

// ─── 用户偏好 ────────────────────────────────────────────────────────────────

function extractKeywords(texts: string[]): string[] {
  const freq: Record<string, number> = {};
  for (const text of texts) {
    // CJK bigram 分词
    for (let i = 0; i < text.length - 1; i++) {
      const bigram = text.slice(i, i + 2);
      if (/[\u4e00-\u9fff]{2}/.test(bigram)) {
        freq[bigram] = (freq[bigram] ?? 0) + 1;
      }
    }
    // 英文单词
    const words = text.toLowerCase().match(/[a-z]{3,}/g) ?? [];
    for (const w of words) {
      freq[w] = (freq[w] ?? 0) + 1;
    }
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([k]) => k);
}

export function recordUserPreference(
  entry: Omit<AssistantFeedbackLogEntry, "ts">,
): void {
  if (entry.action !== "up" && entry.action !== "down") return;

  const store = readUserPreferenceStore();
  const signal: UserPreferenceSignal = {
    ts: new Date().toISOString(),
    messageId: entry.messageId,
    action: entry.action,
    contentPreview: trunc(entry.contentPreview, 100),
  };

  const signals = [...store.signals, signal].slice(-MAX_SIGNALS);
  const positiveTexts = signals.filter((s) => s.action === "up").map((s) => s.contentPreview);
  const negativeTexts = signals.filter((s) => s.action === "down").map((s) => s.contentPreview);

  const updated: UserPreferenceStore = {
    signals,
    positiveKeywords: extractKeywords(positiveTexts),
    negativeKeywords: extractKeywords(negativeTexts),
    lastUpdated: new Date().toISOString(),
  };
  safeWrite(PREFS_KEY, updated);
}

export function readUserPreferenceStore(): UserPreferenceStore {
  if (typeof window === "undefined") {
    return { signals: [], positiveKeywords: [], negativeKeywords: [], lastUpdated: "" };
  }
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { signals: [], positiveKeywords: [], negativeKeywords: [], lastUpdated: "" };
    const parsed = JSON.parse(raw) as Partial<UserPreferenceStore>;
    return {
      signals: Array.isArray(parsed.signals) ? parsed.signals : [],
      positiveKeywords: Array.isArray(parsed.positiveKeywords) ? parsed.positiveKeywords : [],
      negativeKeywords: Array.isArray(parsed.negativeKeywords) ? parsed.negativeKeywords : [],
      lastUpdated: parsed.lastUpdated ?? "",
    };
  } catch {
    return { signals: [], positiveKeywords: [], negativeKeywords: [], lastUpdated: "" };
  }
}
