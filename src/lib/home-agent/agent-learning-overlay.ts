import type { ConversationProjectSnapshot } from "@/lib/home-agent/types";
import {
  readQualityPatterns,
  readComplianceRisks,
  readUserPreferenceStore,
  type QualityPattern,
  type ComplianceRiskMemory,
} from "./agent-learning-store";

const CREATION_KEYWORDS = /写|生成|创作|剧本|集|场景|撰写|续写|重写|细纲|目录/;
const CREATION_STAGES = new Set(["episodes", "outlines", "细纲", "分集正文"]);

export function isLearningOverlayApplicable(
  prompt: string,
  snapshot: ConversationProjectSnapshot | null,
): boolean {
  if (!snapshot) return false;
  if (CREATION_KEYWORDS.test(prompt)) return true;
  const stage = snapshot.derivedStage ?? "";
  return CREATION_STAGES.has(stage);
}

function filterQualityPatterns(
  patterns: QualityPattern[],
  genres: string[],
  targetMarket: string,
): QualityPattern[] {
  return patterns
    .filter(
      (p) =>
        p.targetMarket === targetMarket &&
        p.genres.some((g) => genres.includes(g)),
    )
    .slice(-5); // 最近 5 条
}

function filterComplianceRisks(
  risks: ComplianceRiskMemory[],
  genres: string[],
  targetMarket: string,
): ComplianceRiskMemory[] {
  return risks
    .filter(
      (r) =>
        r.riskLevel === "high" &&
        r.targetMarket === targetMarket &&
        r.genres.some((g) => genres.includes(g)),
    )
    .slice(-3); // 最近 3 条
}

function buildQualitySection(patterns: QualityPattern[]): string {
  if (!patterns.length) return "";

  // 聚合弱维度频率
  const weakFreq: Record<string, number> = {};
  const issueSet = new Set<string>();
  for (const p of patterns) {
    for (const d of p.weakDimensions) weakFreq[d] = (weakFreq[d] ?? 0) + 1;
    for (const i of p.issuePatterns) issueSet.add(i);
  }

  const topWeak = Object.entries(weakFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([d]) => d);

  const lines: string[] = ["### 质量改进重点"];
  if (topWeak.length) {
    lines.push(`- 历史偏弱维度：${topWeak.join("、")}`);
  }
  const issues = [...issueSet].slice(0, 3);
  for (const issue of issues) {
    lines.push(`- ${issue}`);
  }
  return lines.join("\n");
}

function buildComplianceSection(risks: ComplianceRiskMemory[]): string {
  if (!risks.length) return "";
  const lines: string[] = ["### 合规风险提示（同类题材历史高风险）"];
  for (const r of risks) {
    lines.push(`- ${r.issueTitle}`);
    if (r.recommendation) lines.push(`  建议：${r.recommendation}`);
  }
  return lines.join("\n");
}

function buildPrefsSection(
  positiveKeywords: string[],
  negativeKeywords: string[],
): string {
  if (!positiveKeywords.length && !negativeKeywords.length) return "";
  const lines: string[] = ["### 用户偏好倾向"];
  if (positiveKeywords.length) lines.push(`- 倾向认可：${positiveKeywords.slice(0, 5).join("、")}`);
  if (negativeKeywords.length) lines.push(`- 倾向回避：${negativeKeywords.slice(0, 5).join("、")}`);
  return lines.join("\n");
}

export function buildLearningMemoryOverlay(params: {
  currentProjectSnapshot: ConversationProjectSnapshot | null;
  prompt: string;
}): string | null {
  const { currentProjectSnapshot, prompt } = params;

  if (!isLearningOverlayApplicable(prompt, currentProjectSnapshot)) return null;

  // 尝试从 artifacts 中找到 setup 信息（题材、市场）
  const setupArtifact = currentProjectSnapshot?.artifacts?.find(
    (a) => a.kind === "dramaSetup" || a.kind === "setup",
  );
  const setupPayload = setupArtifact?.payload as { genres?: string[]; targetMarket?: string } | undefined;

  const genres: string[] = setupPayload?.genres ?? [];
  const targetMarket: string = setupPayload?.targetMarket ?? "";

  // 若无法确定题材/市场，仍可注入偏好信息
  const allPatterns = readQualityPatterns();
  const allRisks = readComplianceRisks();
  const prefs = readUserPreferenceStore();

  const relevantPatterns =
    genres.length && targetMarket
      ? filterQualityPatterns(allPatterns, genres, targetMarket)
      : [];
  const relevantRisks =
    genres.length && targetMarket
      ? filterComplianceRisks(allRisks, genres, targetMarket)
      : [];

  const qualitySection = buildQualitySection(relevantPatterns);
  const complianceSection = buildComplianceSection(relevantRisks);
  const prefsSection = buildPrefsSection(prefs.positiveKeywords, prefs.negativeKeywords);

  const sections = [qualitySection, complianceSection, prefsSection].filter(Boolean);
  if (!sections.length) return null;

  // 总长度保护：超过 500 字时按优先级裁剪
  let body = sections.join("\n\n");
  if (body.length > 500) {
    const priority = [complianceSection, qualitySection, prefsSection].filter(Boolean);
    body = priority.join("\n\n").slice(0, 500);
  }

  return `## 创作经验参考（基于历史项目学习）\n\n${body}`;
}
