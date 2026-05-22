import type {
  CharacterStateCard,
  ComplianceRevisionPacket,
  DramaProject,
  EpisodeEntry,
  StoryBeatPacket,
} from "@/types/drama";
import type { VideoStyleLock, VideoWorldModel } from "@/types/project";
import {
  deriveComplianceRevisionPackets,
  normalizeComplianceWorkspace,
} from "./compliance-workspace";
import { repairDramaDirectoryFromRaw } from "./script-artifact-helpers";

function truncate(text: string, max = 180): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function pickFirstSentence(text: string, fallback: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  const match = normalized.match(/^(.+?[。！？.!?])/);
  return truncate(match?.[1] || normalized, 80);
}

function cleanHeading(line: string): string {
  return line.replace(/^[-*#\d.\s、（）()]+/, "").trim();
}

function extractTaggedValue(block: string, labels: string[]): string {
  for (const label of labels) {
    const regex = new RegExp(`${label}[：:]?\\s*([^\\n]+)`);
    const match = block.match(regex);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return "";
}

function splitCharacterBlocks(text: string): string[] {
  return text
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter((block) => block.length > 10);
}

function deriveRelationshipAxis(block: string): string[] {
  const tagged = extractTaggedValue(block, ["关系", "人物关系", "关系网", "对手", "羁绊"]);
  if (tagged) {
    return tagged
      .split(/[、，,；;]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 4);
  }
  return [];
}

export function deriveDramaCharacterStateCards(project: DramaProject): CharacterStateCard[] {
  const source = project.characterTransform || project.characters || "";
  if (!source.trim()) return [];
  const existingStatusMap = new Map(
    (project.characterStateCards ?? []).map((card) => [card.id, card.status]),
  );

  const blocks = splitCharacterBlocks(source);
  if (!blocks.length) {
    return [
      {
        id: `${project.id}-character-card-0`,
        name: "主角群",
        role: project.mode === "adaptation" ? "改编角色组" : "原创角色组",
        coreConflict: pickFirstSentence(source, "待补充角色冲突"),
        desire: "待补充角色目标",
        riskNote: "待补充角色风险",
        relationshipAxis: [],
        stageFocus: "继续收束人物弧光与关系张力",
        status: existingStatusMap.get(`${project.id}-character-card-0`) ?? "pending",
      },
    ];
  }

  return blocks.slice(0, 6).map((block, index) => {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const firstLine = cleanHeading(lines[0] || `角色 ${index + 1}`);

    return {
      id: `${project.id}-character-card-${index}`,
      name: extractTaggedValue(block, ["姓名", "名字", "角色"]) || firstLine,
      role: extractTaggedValue(block, ["身份", "定位", "标签"]) || "主要角色",
      coreConflict:
        extractTaggedValue(block, ["核心冲突", "冲突", "矛盾", "困境"]) || pickFirstSentence(block, "待补充核心冲突"),
      desire: extractTaggedValue(block, ["动机", "目标", "欲望", "诉求"]) || "待补充人物目标",
      riskNote: extractTaggedValue(block, ["弱点", "秘密", "代价", "风险"]) || "待补充角色风险",
      relationshipAxis: deriveRelationshipAxis(block),
      stageFocus:
        project.currentStep === "characters" || project.currentStep === "character-transform"
          ? "继续细化人物弧光与关系反应"
          : "保持人物动机和冲突连续",
      status: existingStatusMap.get(`${project.id}-character-card-${index}`) ?? "pending",
    };
  });
}

function buildBeatStatus(entry: EpisodeEntry, completedEpisodeNumbers: Set<number>): StoryBeatPacket["status"] {
  if (completedEpisodeNumbers.has(entry.number)) return "locked";
  if (entry.outline?.trim()) return "drafted";
  return "pending";
}

export function deriveDramaStoryBeatPackets(project: DramaProject): StoryBeatPacket[] {
  if (!project.directory.length) return [];

  const completedEpisodeNumbers = new Set(project.episodes.map((episode) => episode.number));
  const existingStatusMap = new Map(
    (project.storyBeatPackets ?? []).map((packet) => [packet.id, packet.status]),
  );
  return project.directory.slice(0, 24).map((entry) => ({
    id: `${project.id}-beat-${entry.number}`,
    episodeNumber: entry.number,
    title: entry.title || `第 ${entry.number} 集`,
    beatSummary: truncate(entry.summary || entry.outline || "待补充剧情节点", 120),
    hook: truncate(entry.hookType || pickFirstSentence(entry.summary || "", "待补充钩子"), 60),
    payoff: entry.isPaywall
      ? "本集承担付费卡点，需要强化悬念和转化。"
      : entry.isClimax
        ? "本集承担高潮推进，需要兑现前置冲突。"
        : pickFirstSentence(entry.outline || entry.summary || "", "待补充情绪回收点"),
    sourceOutline: entry.outline?.trim() || undefined,
    status:
      existingStatusMap.get(`${project.id}-beat-${entry.number}`) === "locked"
        ? "locked"
        : buildBeatStatus(entry, completedEpisodeNumbers),
  }));
}

function splitComplianceBlocks(report: string): string[] {
  const normalized = report.replace(/\r/g, "").trim();
  if (!normalized) return [];

  const parts = normalized
    .split(/\n(?=(?:\d+[.)、]|[-*•]|问题|风险|建议))/)
    .map((item) => item.trim())
    .filter((item) => item.length > 8);

  return parts.length ? parts.slice(0, 12) : [normalized];
}

function isSmartComplianceSummaryReport(report: string): boolean {
  return /^#?\s*智能重审摘要(?:\s|$)/m.test(report.replace(/\r/g, "").trim());
}

function inferRiskLevel(block: string): ComplianceRevisionPacket["riskLevel"] {
  if (/(高风险|严重|违规|禁止|敏感)/.test(block)) return "high";
  if (/(中风险|注意|谨慎|建议调整)/.test(block)) return "medium";
  return "low";
}

export function deriveDramaComplianceRevisionPackets(project: DramaProject): ComplianceRevisionPacket[] {
  const workspace = normalizeComplianceWorkspace(project.complianceWorkspace);
  if (workspace.riskPhrases.length) {
    return deriveComplianceRevisionPackets(workspace.riskPhrases, workspace.phraseReplacements);
  }
  if (isSmartComplianceSummaryReport(project.complianceReport)) return [];
  if (!project.complianceReport.trim()) return [];

  const existingStatusMap = new Map(
    (project.complianceRevisionPackets ?? []).map((packet) => [packet.id, packet.status]),
  );
  return splitComplianceBlocks(project.complianceReport).map((block, index) => {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const issueTitle = cleanHeading(lines[0] || `修订项 ${index + 1}`);
    const recommendation = truncate(lines.slice(1).join(" ") || block, 180);
    const id = `${project.id}-compliance-${index}`;

    return {
      id,
      issueTitle,
      riskLevel: inferRiskLevel(block),
      recommendation: recommendation || "请根据审查意见做一轮稳妥修订。",
      sourceQuote: lines[1] || undefined,
      status: existingStatusMap.get(id) ?? "pending",
    };
  });
}

export function synchronizeDramaProductionState(
  project: DramaProject,
  styleLock: VideoStyleLock | null,
  worldModel: VideoWorldModel | null,
): DramaProject {
  const repairedDirectory = repairDramaDirectoryFromRaw(project.directoryRaw, project.directory);
  const repairedProject = {
    ...project,
    directory: repairedDirectory,
  };

  return {
    ...repairedProject,
    styleLock,
    worldModel,
    characterStateCards: deriveDramaCharacterStateCards(repairedProject),
    storyBeatPackets: deriveDramaStoryBeatPackets(repairedProject),
    complianceRevisionPackets: deriveDramaComplianceRevisionPackets(repairedProject),
  };
}
