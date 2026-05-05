import type {
  ComplianceRevisionPacket,
  DramaProject,
  DramaSetup,
  EpisodeEntry,
  ExportPatchPlan,
  ExportPatchPlanEntry,
  EpisodeQualityReviewPacket,
  EpisodeScript,
  OutlineBatchStatus,
} from "@/types/drama";
import { resolveComplianceStatus } from "@/lib/home-agent/compliance-workspace";

export const OUTLINE_BATCH_SIZE = 10;
const CHINESE_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
const DEFAULT_DIRECTORY_HOOK_TYPE = "悬念钩子";
const DIRECTORY_LINE_PATTERNS = [
  /^第?\s*(\d+)\s*(?:[集话章节]\s*[：:]?)?\s*(.+?)(?:\s*[-—–]\s*)(.+)$/,
  /^(\d+)[.)、]\s*(.+?)(?:\s*[-—–]\s*)(.+)$/,
  /^Episode\s*(\d+)\s*[:：]?\s*(.+?)(?:\s*[-—–]\s*)(.+)$/i,
] as const;
const DIRECTORY_HOOK_PATTERN = /\[([^\]]+)\]/;
const DIRECTORY_EMOTION_PATTERN = /情绪[:：]?\s*(\d)/i;
const DIRECTORY_KEY_MARKER_PATTERN = /🔥|关键(?:剧情)?集?|重点/;
const DIRECTORY_CLIMAX_MARKER_PATTERN = /⚡|高潮(?:卡点)?集?/;
const DIRECTORY_PAYWALL_MARKER_PATTERN = /💰|付费(?:卡点)?集?|付费点|付费墙/;

export function extractMermaidCode(text: string): string | null {
  const match = text.match(/```mermaid\s*\n([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

export function extractDetailedMermaidCode(text: string): string | null {
  const match = text.match(/```mermaid-detailed\s*\n([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

export function stripMermaidCodeBlocks(text: string): string {
  return text.replace(/```mermaid(?:-detailed)?\s*\n[\s\S]*?```\s*/g, "").trim();
}

export function sanitizeMermaidCode(input: string): string {
  return input
    .replace(/\r/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "`")
    .split("\n")
    .map((line) =>
      line.replace(/\[(.+?)\]/g, (_match, label) => {
        const safeLabel = String(label).replace(/"/g, '\\"').trim();
        return /[():/\\,\u4e00-\u9fff]/.test(safeLabel) ? `["${safeLabel}"]` : `[${safeLabel}]`;
      }),
    )
    .join("\n")
    .trim();
}

export function isNonChineseText(text: string): boolean {
  const sample = text.slice(0, 1200);
  if (!sample.trim()) return false;
  const chineseCount = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
  return chineseCount / Math.max(sample.length, 1) < 0.12;
}

export function parseDramaDirectoryText(raw: string): EpisodeEntry[] {
  return raw
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = DIRECTORY_LINE_PATTERNS
        .map((pattern) => line.match(pattern))
        .find((result) => result);
      if (!match) return [];

      const number = Number(match[1]);
      const title = match[2].trim();
      const rest = match[3].trim();
      const hookMatch = rest.match(DIRECTORY_HOOK_PATTERN);
      const emotionMatch = rest.match(DIRECTORY_EMOTION_PATTERN);

      return [
        {
          number,
          title,
          summary: rest.replace(/\[[^\]]+\]/g, "").trim(),
          hookType: hookMatch?.[1]?.trim() || DEFAULT_DIRECTORY_HOOK_TYPE,
          isKey: DIRECTORY_KEY_MARKER_PATTERN.test(line),
          isClimax: DIRECTORY_CLIMAX_MARKER_PATTERN.test(line),
          isPaywall: DIRECTORY_PAYWALL_MARKER_PATTERN.test(line),
          emotionLevel: emotionMatch ? Number(emotionMatch[1]) : undefined,
        },
      ];
    });
}

export function repairDramaDirectoryFromRaw(
  directoryRaw: string,
  existingDirectory: EpisodeEntry[],
): EpisodeEntry[] {
  const parsedDirectory = parseDramaDirectoryText(directoryRaw);
  if (!parsedDirectory.length) return existingDirectory;
  if (existingDirectory.length === 0) return parsedDirectory;
  if (parsedDirectory.length !== existingDirectory.length) return existingDirectory;

  const parsedByEpisode = new Map(parsedDirectory.map((entry) => [entry.number, entry]));

  return existingDirectory.map((entry) => {
    const parsed = parsedByEpisode.get(entry.number);
    if (!parsed) return entry;

    return {
      ...entry,
      title: parsed.title || entry.title,
      summary: parsed.summary || entry.summary,
      hookType:
        parsed.hookType !== DEFAULT_DIRECTORY_HOOK_TYPE || !entry.hookType
          ? parsed.hookType
          : entry.hookType,
      isKey: entry.isKey || parsed.isKey,
      isClimax: entry.isClimax || parsed.isClimax,
      isPaywall: entry.isPaywall || parsed.isPaywall,
      emotionLevel: parsed.emotionLevel ?? entry.emotionLevel,
    };
  });
}

export function buildOutlineBatchStatuses(
  directory: EpisodeEntry[],
  batchSize = OUTLINE_BATCH_SIZE,
): OutlineBatchStatus[] {
  const batches: OutlineBatchStatus[] = [];
  for (let index = 0; index < directory.length; index += batchSize) {
    const slice = directory.slice(index, index + batchSize);
    if (!slice.length) continue;
    const startEp = slice[0].number;
    const endEp = slice[slice.length - 1].number;
    const allHaveOutline = slice.every((entry) => entry.outline?.trim());
    batches.push({
      index: batches.length,
      label: `第${startEp}-${endEp}集`,
      startEp,
      endEp,
      status: allHaveOutline ? "done" : "pending",
    });
  }
  return batches;
}

function formatBatchNumber(batchNumber: number): string {
  if (!Number.isInteger(batchNumber) || batchNumber <= 0) {
    return String(batchNumber);
  }

  if (batchNumber < 10) {
    return CHINESE_DIGITS[batchNumber];
  }

  if (batchNumber === 10) {
    return "十";
  }

  if (batchNumber < 20) {
    return `十${CHINESE_DIGITS[batchNumber % 10]}`;
  }

  if (batchNumber < 100) {
    const tens = Math.floor(batchNumber / 10);
    const ones = batchNumber % 10;
    return `${CHINESE_DIGITS[tens]}十${ones === 0 ? "" : CHINESE_DIGITS[ones]}`;
  }

  return String(batchNumber);
}

export function findNextOutlineBatchStatus(
  batches: OutlineBatchStatus[],
): OutlineBatchStatus | null {
  return batches.find((batch) => batch.status === "processing")
    ?? batches.find((batch) => batch.status !== "done")
    ?? null;
}

export function buildOutlineBatchActionLabel(batch: OutlineBatchStatus): string {
  return `生成第${formatBatchNumber(batch.index + 1)}批次细纲`;
}

export function buildOutlineBatchRangeLabel(
  batch: Pick<OutlineBatchStatus, "startEp" | "endEp">,
): string {
  if (batch.startEp === batch.endEp) {
    return `第 ${batch.startEp} 集`;
  }

  return `第 ${batch.startEp}-${batch.endEp} 集`;
}

export function countComplianceFlags(report: string): {
  redLine: number;
  highRisk: number;
  suggestion: number;
} {
  return {
    redLine: (report.match(/⛔/g) || []).length,
    highRisk: (report.match(/⚠️/g) || []).length,
    suggestion: (report.match(/ℹ️/g) || []).length,
  };
}

export function buildQuickExportMarkdown(
  setup: DramaSetup | null,
  dramaTitle: string,
  creativePlan: string,
  characters: string,
  episodes: EpisodeScript[],
): string {
  const safeSetup = setup ?? {
    genres: [],
    audience: "",
    tone: "",
    ending: "",
    totalEpisodes: 0,
    targetMarket: "",
  };

  const sceneSet = new Set<string>();
  const soundtrackList: Array<{ ep: number; scene: string; music: string }> = [];
  const characterLines: string[] = [];
  const sortedEpisodes = [...episodes].sort((a, b) => a.number - b.number);

  const characterMatches = characters.matchAll(
    /(?:^|\n)(?:###?\s*)?\d*\.?\s*\*{0,2}(.+?)\*{0,2}\s*[（(](.+?)[）)]/g,
  );
  for (const match of characterMatches) {
    characterLines.push(`| ${match[1].trim()} | ${match[2].trim()} |`);
  }

  sortedEpisodes.forEach((episode) => {
    const sceneMatches = episode.content.matchAll(/\*\*场景[：:]\*\*\s*(.+)/g);
    for (const match of sceneMatches) sceneSet.add(match[1].trim());
    const intExtMatches = episode.content.matchAll(/\*\*(INT\.|EXT\.|内景|外景)\s*(.+?)\*\*/g);
    for (const match of intExtMatches) sceneSet.add(`${match[1]} ${match[2]}`.trim());
    const musicMatches = episode.content.matchAll(/♪\s*(?:音乐提示|Music|Score|OST|音楽)[：:]?\s*(.+)/g);
    let sceneIndex = 0;
    for (const match of musicMatches) {
      sceneIndex += 1;
      soundtrackList.push({
        ep: episode.number,
        scene: `场次${sceneIndex}`,
        music: match[1].trim(),
      });
    }
  });

  return [
    `# ${dramaTitle || "未命名短剧"}`,
    "",
    `> 题材：${safeSetup.genres.join(" + ") || "待补充"} | 受众：${safeSetup.audience || "待补充"} | 基调：${safeSetup.tone || "待补充"} | 集数：${safeSetup.totalEpisodes || episodes.length || "待补充"}`,
    "",
    "---",
    "",
    "## 角色表",
    "",
    "| 角色名 | 简介 |",
    "|--------|------|",
    ...(characterLines.length ? characterLines : ["| （请参考角色档案） | |"]),
    "",
    "---",
    "",
    "## 场景清单",
    "",
    ...(sceneSet.size ? [...sceneSet].map((scene, index) => `${index + 1}. ${scene}`) : ["（未提取到场景信息）"]),
    "",
    "---",
    "",
    "## 配乐提示表",
    "",
    ...(soundtrackList.length
      ? [
          "| 集数 | 场次 | 配乐描述 |",
          "|------|------|----------|",
          ...soundtrackList.map(
            (item) => `| 第${item.ep}集 | ${item.scene} | ${item.music} |`,
          ),
        ]
      : ["（未提取到配乐提示）"]),
    "",
    "---",
    "",
    "## 创作方案",
    "",
    creativePlan || "（暂无创作方案）",
    "",
    "---",
    "",
    "## 角色档案",
    "",
    characters || "（暂无角色档案）",
    "",
    "---",
    "",
    "## 分集剧本",
    "",
    ...sortedEpisodes.map(
      (episode) => `### 第${episode.number}集：${episode.title}\n\n${episode.content}\n\n---\n`,
    ),
  ].join("\n");
}

export function buildEpisodeReviewRewriteInstruction(
  packet: EpisodeQualityReviewPacket,
): string {
  const parts: string[] = [`【第 ${packet.episodeNumber} 集质检修复目标】`];
  packet.result.issues.forEach((issue) => {
    parts.push(`${issue.level} ${issue.description}`);
  });
  packet.result.suggestions.forEach((suggestion, index) => {
    parts.push(`${index + 1}. ${suggestion}`);
  });

  const lowScores = Object.entries(packet.result.scores)
    .filter(([, value]) => value.score <= 6)
    .map(([key, value]) => `${key}（${value.score}/10）：${value.comment}`);
  if (lowScores.length) {
    parts.push("【需重点提升】", ...lowScores);
  }

  return parts.join("\n");
}

export function summariseEpisodeReviewPackets(
  packets: EpisodeQualityReviewPacket[],
): {
  reviewedCount: number;
  averageTotal: number;
  highestEpisodeNumber?: number;
  lowestEpisodeNumber?: number;
  riskCounts: { blocking: number; warning: number; suggestion: number };
  dimensionAverages: Record<
    "rhythm" | "satisfaction" | "dialogue" | "format" | "continuity",
    number
  >;
} {
  const reviewedCount = packets.length;
  const dimensionKeys = [
    "rhythm",
    "satisfaction",
    "dialogue",
    "format",
    "continuity",
  ] as const;

  if (!reviewedCount) {
    return {
      reviewedCount: 0,
      averageTotal: 0,
      riskCounts: { blocking: 0, warning: 0, suggestion: 0 },
      dimensionAverages: {
        rhythm: 0,
        satisfaction: 0,
        dialogue: 0,
        format: 0,
        continuity: 0,
      },
    };
  }

  const totals = packets.map((packet) => ({
    episodeNumber: packet.episodeNumber,
    total: packet.result.total,
  }));
  const highest = totals.reduce((max, current) => (current.total > max.total ? current : max));
  const lowest = totals.reduce((min, current) => (current.total < min.total ? current : min));

  const riskCounts = packets.reduce(
    (acc, packet) => {
      packet.result.issues.forEach((issue) => {
        if (issue.level.includes("⛔")) acc.blocking += 1;
        else if (issue.level.includes("⚠")) acc.warning += 1;
        else acc.suggestion += 1;
      });
      return acc;
    },
    { blocking: 0, warning: 0, suggestion: 0 },
  );

  const dimensionAverages = dimensionKeys.reduce(
    (acc, key) => {
      acc[key] =
        packets.reduce((sum, packet) => sum + packet.result.scores[key].score, 0) /
        reviewedCount;
      return acc;
    },
    {
      rhythm: 0,
      satisfaction: 0,
      dialogue: 0,
      format: 0,
      continuity: 0,
    },
  );

  return {
    reviewedCount,
    averageTotal:
      packets.reduce((sum, packet) => sum + packet.result.total, 0) / reviewedCount,
    highestEpisodeNumber: highest.episodeNumber,
    lowestEpisodeNumber: lowest.episodeNumber,
    riskCounts,
    dimensionAverages,
  };
}

export function formatEpisodeRangeLabel(episodeNumbers: number[]): string {
  const normalized = [...new Set(
    episodeNumbers.filter((episodeNumber) => Number.isFinite(episodeNumber)),
  )].sort((a, b) => a - b);

  if (!normalized.length) return "";

  const ranges: string[] = [];
  let rangeStart = normalized[0];
  let previous = normalized[0];

  for (let index = 1; index < normalized.length; index += 1) {
    const current = normalized[index];
    if (current === previous + 1) {
      previous = current;
      continue;
    }

    ranges.push(rangeStart === previous ? `${rangeStart}` : `${rangeStart}-${previous}`);
    rangeStart = current;
    previous = current;
  }

  ranges.push(rangeStart === previous ? `${rangeStart}` : `${rangeStart}-${previous}`);
  return `第 ${ranges.join("、")} 集`;
}

export function getCompletedEpisodeNumbers(project: DramaProject): Set<number> {
  return new Set(project.episodes.map((episode) => episode.number));
}

function formatEpisodeNumberList(episodeNumbers: number[], limit = 6): string {
  if (!episodeNumbers.length) return "";
  const visible = episodeNumbers.slice(0, limit).map((episodeNumber) => `第 ${episodeNumber} 集`);
  return episodeNumbers.length > limit
    ? `${visible.join("、")} 等 ${episodeNumbers.length} 集`
    : visible.join("、");
}

function createExportPatchEntry(
  entry: Omit<ExportPatchPlanEntry, "id">,
): ExportPatchPlanEntry {
  return {
    id: `${entry.kind}-${entry.priority}-${entry.title}`,
    ...entry,
  };
}

export function buildExportPatchSignature(project: DramaProject): string {
  const complianceStatus = resolveComplianceStatus(project);
  const completedEpisodeNumbers = [...getCompletedEpisodeNumbers(project)].sort((a, b) => a - b);
  const missingOutlineNumbers = project.directory
    .filter((entry) => !entry.outline?.trim())
    .map((entry) => entry.number);
  const missingEpisodeNumbers = project.directory
    .filter((entry) => !completedEpisodeNumbers.includes(entry.number))
    .map((entry) => entry.number);
  const reviewScores = (project.episodeQualityReviewPackets ?? [])
    .map((packet) => `${packet.episodeNumber}:${packet.result.total}`)
    .sort();
  const pendingCompliance = (project.complianceRevisionPackets ?? [])
    .filter((packet) => packet.status === "pending")
    .map((packet) => `${packet.id}:${packet.riskLevel}`)
    .sort();

  return JSON.stringify({
    step: project.currentStep,
    complianceStatus,
    missingOutlineNumbers,
    missingEpisodeNumbers,
    reviewScores,
    pendingCompliance,
    hasExportDocument: Boolean(project.exportDocument?.trim()),
  });
}

export function buildExportPatchPlan(
  project: DramaProject,
  generatedAt = new Date().toISOString(),
): ExportPatchPlan {
  const complianceStatus = resolveComplianceStatus(project);
  const entries: ExportPatchPlanEntry[] = [];
  const completedEpisodeNumbers = getCompletedEpisodeNumbers(project);
  const missingOutlineNumbers = project.directory
    .filter((entry) => !entry.outline?.trim())
    .map((entry) => entry.number)
    .sort((a, b) => a - b);
  const missingEpisodeNumbers = project.directory
    .filter((entry) => !completedEpisodeNumbers.has(entry.number))
    .map((entry) => entry.number)
    .sort((a, b) => a - b);
  const pendingCompliancePackets = (project.complianceRevisionPackets ?? []).filter(
    (packet) => packet.status === "pending",
  );
  const highRiskPackets = pendingCompliancePackets.filter((packet) =>
    /high|red|blocking|fatal|严重|红线/i.test(packet.riskLevel),
  );
  const reviewPackets = [...(project.episodeQualityReviewPackets ?? [])].sort(
    (a, b) => a.result.total - b.result.total,
  );
  const weakReviewPackets = reviewPackets.filter((packet) => packet.result.total < 40);

  if (missingOutlineNumbers.length) {
    entries.push(
      createExportPatchEntry({
        kind: "missing-outline",
        title: `待补细纲 ${missingOutlineNumbers.length} 集`,
        priority: "high",
        summary: `${formatEpisodeNumberList(missingOutlineNumbers)} 还没有细纲，建议先补齐细纲再继续补写正文。`,
        episodeNumbers: missingOutlineNumbers,
        action: {
          label: "补齐细纲",
          value: "生成单集细纲",
        },
      }),
    );
  }

  if (missingEpisodeNumbers.length) {
    const firstMissingEpisodeNumber = missingEpisodeNumbers[0];
    entries.push(
      createExportPatchEntry({
        kind: "missing-episode",
        title: `待补正文 ${missingEpisodeNumbers.length} 集`,
        priority: "high",
        summary: `${formatEpisodeNumberList(missingEpisodeNumbers)} 还没有生成正文，建议按集数顺序优先补写。`,
        episodeNumbers: missingEpisodeNumbers,
        action: {
          label:
            missingEpisodeNumbers.length > 1
              ? `先补第 ${firstMissingEpisodeNumber} 集`
              : `补写第 ${firstMissingEpisodeNumber} 集`,
          value: `script:episode-generate:${firstMissingEpisodeNumber}`,
        },
      }),
    );
  }

  if (weakReviewPackets.length) {
    const worstPacket = weakReviewPackets[0];
    entries.push(
      createExportPatchEntry({
        kind: "episode-review",
        title: `低分质检集 ${weakReviewPackets.length} 集`,
        priority: "medium",
        summary: `${formatEpisodeNumberList(
          weakReviewPackets.map((packet) => packet.episodeNumber),
        )} 的质检分数偏低，建议先修复最低分集再重新检查。`,
        episodeNumbers: weakReviewPackets.map((packet) => packet.episodeNumber),
        action: {
          label: `修复第 ${worstPacket.episodeNumber} 集`,
          value: `script:episode-review:repair:${worstPacket.episodeNumber}`,
        },
      }),
    );
  }

  if (complianceStatus !== "skipped" && pendingCompliancePackets.length) {
    entries.push(
      createExportPatchEntry({
        kind: "compliance",
        title: `待处理合规项 ${pendingCompliancePackets.length} 条`,
        priority: highRiskPackets.length ? "high" : "medium",
        summary: highRiskPackets.length
          ? `当前还有 ${highRiskPackets.length} 条高风险或红线项未处理，建议先完成定向修订。`
          : `当前还有 ${pendingCompliancePackets.length} 条合规建议待处理，导出前最好再跑一次合规确认。`,
        action: highRiskPackets.length
          ? {
              label: "优先处理高风险项",
              value: "script:compliance-resolve-high",
            }
          : {
              label: "重新合规审查",
              value: "script:compliance-rerun",
            },
      }),
    );
  }

  if (!project.exportDocument?.trim()) {
    entries.push(
      createExportPatchEntry({
        kind: "export-refresh",
        title: "尚未生成整合导出稿",
        priority: entries.length ? "low" : "medium",
        summary: entries.length
          ? "当前仍建议先处理上面的缺口，再重新整合导出稿。"
          : "项目主体已经齐备，可以直接生成整合导出稿并进入交付阶段。",
        action: {
          label: "生成整合导出稿",
          value: "script:export-document",
        },
      }),
    );
  }

  const counts = entries.reduce(
    (acc, entry) => {
      acc[entry.priority] += 1;
      return acc;
    },
    { high: 0, medium: 0, low: 0 },
  );

  const recommendedAction =
    entries.find((entry) => entry.priority === "high" && entry.action)?.action ??
    entries.find((entry) => entry.action)?.action ??
    (project.exportDocument?.trim()
      ? {
          label: "接入视频工作流",
          value: "script:export-video",
        }
      : undefined);

  const readyForExport =
    missingOutlineNumbers.length === 0 &&
    missingEpisodeNumbers.length === 0 &&
    (complianceStatus === "skipped" || pendingCompliancePackets.length === 0) &&
    weakReviewPackets.length === 0;

  const summary = readyForExport
    ? project.exportDocument?.trim()
      ? "导出缺口检查完成，当前内容已经具备继续交付或衔接视频工作流的条件。"
      : "导出缺口检查完成，当前内容已基本齐备，建议先生成一版整合导出稿。"
    : `已识别 ${entries.length} 个导出前建议处理的缺口，优先从高优先级项开始补写或修订。`;

  const resolvedSummary =
    readyForExport && complianceStatus === "skipped"
      ? project.exportDocument?.trim()
        ? "导出缺口检查完成，本轮已按用户选择跳过合规审查，可继续导出或随时回到完整版合规工作台。"
        : "导出缺口检查完成，本轮已按用户选择跳过合规审查；如需补做审核，可从导出面板重新进入完整版合规。"
      : summary;

  return {
    generatedAt,
    signature: buildExportPatchSignature(project),
    readyForExport,
    summary: resolvedSummary,
    counts,
    recommendedAction,
    entries,
  };
}

export function mergeCompliancePacketsByStatus(
  packets: ComplianceRevisionPacket[],
): {
  pendingPackets: number;
  resolvedPackets: number;
} {
  return packets.reduce(
    (acc, packet) => {
      if (packet.status === "resolved") acc.resolvedPackets += 1;
      else acc.pendingPackets += 1;
      return acc;
    },
    { pendingPackets: 0, resolvedPackets: 0 },
  );
}
