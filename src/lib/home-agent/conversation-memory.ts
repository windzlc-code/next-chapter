import type {
  ConversationMemoryDocument,
  ConversationMemoryKind,
  ConversationProjectSnapshot,
  MaintenanceReport,
  SkillDraft,
  StudioSessionState,
  StudioRuntimeState,
} from "./types";
import { buildFallbackCompactedChunkSummary } from "./conversation-compact";

const MEMORY_RESULT_LIMIT = 3;
const MEMORY_KIND_HINT_LABEL: Record<ConversationMemoryKind, string> = {
  "project-summary": "项目经验",
  "conversation-summary": "会话结论",
  artifact: "素材记录",
  "maintenance-report": "维护记录",
  "skill-draft": "技能草案",
};
const SAME_PROJECT_PENALTY = 12;
const SAME_KIND_PENALTY = 4;
const CURRENT_PROJECT_INTERNAL_BOOST = 18;

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  const latinTokens = normalize(value).split(/[^a-z0-9\u4e00-\u9fa5]+/).filter((token) => token.length >= 2);
  const cjkBigrams = Array.from(normalize(value).replace(/[^a-z0-9\u4e00-\u9fa5]/g, ""))
    .flatMap((_, index, chars) => {
      if (index >= chars.length - 1) return [];
      return [`${chars[index]}${chars[index + 1]}`];
    });
  return Array.from(new Set([...latinTokens, ...cjkBigrams]));
}

function truncate(value: string, max = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function scoreField(haystack: string, queryTokens: string[], weight: number): number {
  if (!haystack) return 0;

  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += weight;
  }
  return score;
}

function computeCoverageScore(queryTokens: string[], haystacks: string[]): number {
  if (!queryTokens.length) return 0;

  const coveredTokenCount = queryTokens.filter((token) => haystacks.some((haystack) => haystack.includes(token))).length;
  if (!coveredTokenCount) return 0;

  return coveredTokenCount * 2 + Math.round((coveredTokenCount / queryTokens.length) * 6);
}

export function buildMemoryDocumentsFromSnapshot(
  snapshot: ConversationProjectSnapshot,
): ConversationMemoryDocument[] {
  const summaryText = [
    snapshot.title,
    snapshot.projectKind,
    snapshot.derivedStage,
    snapshot.currentObjective,
    snapshot.agentSummary,
    snapshot.recommendedActions.join("；"),
  ]
    .filter(Boolean)
    .join("\n");

  const baseDocument: ConversationMemoryDocument = {
    id: `memory:${snapshot.projectId}:summary`,
    projectId: snapshot.projectId,
    projectKind: snapshot.projectKind,
    title: `${snapshot.title} · 项目摘要`,
    kind: "project-summary",
    text: summaryText,
    summary: truncate(snapshot.agentSummary || snapshot.currentObjective || snapshot.title, 150),
    updatedAt: snapshot.updatedAt ?? snapshot.artifacts[0]?.updatedAt ?? new Date().toISOString(),
    tags: [snapshot.projectKind, snapshot.derivedStage, ...snapshot.recommendedActions].filter(Boolean),
  };

  const artifactDocuments = snapshot.artifacts.map<ConversationMemoryDocument>((artifact) => ({
    id: `memory:${snapshot.projectId}:artifact:${artifact.id}`,
    projectId: snapshot.projectId,
    projectKind: snapshot.projectKind,
    title: `${snapshot.title} · ${artifact.label}`,
    kind: "artifact",
    text: [artifact.label, artifact.summary, artifact.content ?? ""].filter(Boolean).join("\n"),
    summary: truncate(artifact.summary || artifact.content || artifact.label, 150),
    updatedAt: artifact.updatedAt,
    tags: [snapshot.projectKind, snapshot.derivedStage, artifact.kind, artifact.label].filter(Boolean),
  }));

  return [
    baseDocument,
    ...artifactDocuments,
    ...buildProjectRuntimeMemoryDocuments(snapshot),
  ];
}

function buildProjectRuntimeMemoryDocuments(
  snapshot: ConversationProjectSnapshot,
): ConversationMemoryDocument[] {
  const memory = snapshot.memory;
  if (!memory) return [];

  const updatedAt = snapshot.updatedAt ?? snapshot.artifacts[0]?.updatedAt ?? new Date().toISOString();
  const runtimeDocuments: ConversationMemoryDocument[] = [];

  if (snapshot.projectKind === "video") {
    const videoScenes = memory.videoScenes ?? [];
    const failedScenes = videoScenes.filter((scene) => String(scene.videoStatus || "").toLowerCase() === "failed");
    const runningScenes = videoScenes.filter((scene) => {
      const status = String(scene.videoStatus || "").toLowerCase();
      return !!scene.videoTaskId && (status === "queued" || status === "processing");
    });
    const readyScenes = videoScenes.filter((scene) => {
      const status = String(scene.videoStatus || "").toLowerCase();
      return !scene.videoUrl && status !== "queued" && status !== "processing";
    });

    if (failedScenes.length) {
      runtimeDocuments.push({
        id: `memory:${snapshot.projectId}:runtime:failed-scenes`,
        projectId: snapshot.projectId,
        projectKind: snapshot.projectKind,
        title: `${snapshot.title} · 失败镜头`,
        kind: "artifact",
        text: failedScenes
          .slice(0, 8)
          .map((scene) =>
            `镜头 ${scene.sceneNumber}${scene.segmentLabel ? ` / ${scene.segmentLabel}` : ""} · ${scene.sceneName}\n${scene.videoFailureMessage || "当前镜头生成失败"}`,
          )
          .join("\n\n"),
        summary: truncate(
          `当前有 ${failedScenes.length} 条失败镜头${
            failedScenes[0] ? `，首条为镜头 ${failedScenes[0].sceneNumber} · ${failedScenes[0].sceneName}` : ""
          }。`,
          150,
        ),
        updatedAt,
        tags: ["video", "scene", "failed", "镜头", "失败"],
      });
    }

    if (runningScenes.length) {
      runtimeDocuments.push({
        id: `memory:${snapshot.projectId}:runtime:running-scenes`,
        projectId: snapshot.projectId,
        projectKind: snapshot.projectKind,
        title: `${snapshot.title} · 进行中镜头`,
        kind: "artifact",
        text: runningScenes
          .slice(0, 8)
          .map((scene) =>
            `镜头 ${scene.sceneNumber}${scene.segmentLabel ? ` / ${scene.segmentLabel}` : ""} · ${scene.sceneName}\n状态：${scene.videoStatus || "processing"}`,
          )
          .join("\n\n"),
        summary: truncate(`当前有 ${runningScenes.length} 条镜头仍在后台出片。`, 150),
        updatedAt,
        tags: ["video", "scene", "running", "镜头", "生成中"],
      });
    }

    if (readyScenes.length) {
      runtimeDocuments.push({
        id: `memory:${snapshot.projectId}:runtime:ready-scenes`,
        projectId: snapshot.projectId,
        projectKind: snapshot.projectKind,
        title: `${snapshot.title} · 可继续出片镜头`,
        kind: "artifact",
        text: readyScenes
          .slice(0, 8)
          .map((scene) => `镜头 ${scene.sceneNumber}${scene.segmentLabel ? ` / ${scene.segmentLabel}` : ""} · ${scene.sceneName}`)
          .join("\n"),
        summary: truncate(`当前还有 ${readyScenes.length} 条镜头可继续生成或补发。`, 150),
        updatedAt,
        tags: ["video", "scene", "ready", "待生成", "镜头"],
      });
    }
  } else {
    const unlockedCharacterCards = (memory.characterStateCards ?? []).filter((card) => card.status !== "locked");
    const pendingBeatPackets = (memory.storyBeatPackets ?? []).filter((packet) => packet.status !== "locked");
    const pendingCompliancePackets = (memory.complianceRevisionPackets ?? []).filter(
      (packet) => packet.status === "pending",
    );

    if (unlockedCharacterCards.length) {
      runtimeDocuments.push({
        id: `memory:${snapshot.projectId}:runtime:character-cards`,
        projectId: snapshot.projectId,
        projectKind: snapshot.projectKind,
        title: `${snapshot.title} · 待锁定角色卡`,
        kind: "artifact",
        text: unlockedCharacterCards
          .slice(0, 8)
          .map((card) => `${card.name}\n${card.coreConflict}\n${card.desire}`)
          .join("\n\n"),
        summary: truncate(`当前有 ${unlockedCharacterCards.length} 张角色状态卡待锁定。`, 150),
        updatedAt,
        tags: ["script", "角色卡", "待锁定", "character-card"],
      });
    }

    if (pendingBeatPackets.length) {
      runtimeDocuments.push({
        id: `memory:${snapshot.projectId}:runtime:beat-packets`,
        projectId: snapshot.projectId,
        projectKind: snapshot.projectKind,
        title: `${snapshot.title} · 待锁定剧情 beat`,
        kind: "artifact",
        text: pendingBeatPackets
          .slice(0, 8)
          .map((packet) => `第 ${packet.episodeNumber} 集 · ${packet.title}\n${packet.beatSummary}`)
          .join("\n\n"),
        summary: truncate(`当前有 ${pendingBeatPackets.length} 条剧情 beat 待锁定。`, 150),
        updatedAt,
        tags: ["script", "beat", "剧情", "待锁定"],
      });
    }

    if (pendingCompliancePackets.length) {
      runtimeDocuments.push({
        id: `memory:${snapshot.projectId}:runtime:compliance-packets`,
        projectId: snapshot.projectId,
        projectKind: snapshot.projectKind,
        title: `${snapshot.title} · 待处理修订包`,
        kind: "artifact",
        text: pendingCompliancePackets
          .slice(0, 8)
          .map((packet) => `${packet.issueTitle}\n${packet.recommendation}`)
          .join("\n\n"),
        summary: truncate(`当前有 ${pendingCompliancePackets.length} 条合规修订包待处理。`, 150),
        updatedAt,
        tags: ["script", "compliance", "修订包", "待处理"],
      });
    }
  }

  return runtimeDocuments;
}

function buildConversationMemoryText(session: StudioSessionState): {
  summary: string;
  text: string;
  updatedAt: string;
} | null {
  const summary =
    session.recentMessageSummary.trim() ||
    buildFallbackCompactedChunkSummary(session.messages.slice(-8)).trim();
  const recentTurns = session.messages
    .slice(-4)
    .map((message) => `${message.role === "user" ? "用户" : "Agent"}：${truncate(message.content, 88)}`)
    .join("\n");
  const lastTimestamp = session.messages.at(-1)?.createdAt;
  const updatedAt =
    (typeof lastTimestamp === "string" && lastTimestamp.trim()) ||
    session.currentProjectSnapshot?.updatedAt ||
    new Date().toISOString();

  if (!summary && !recentTurns) return null;

  return {
    summary: truncate(summary || recentTurns, 150),
    text: [summary, recentTurns].filter(Boolean).join("\n"),
    updatedAt,
  };
}

function buildSessionMemoryDocuments(
  sessions: StudioSessionState[],
  snapshotByProjectId: Map<string, ConversationProjectSnapshot>,
): ConversationMemoryDocument[] {
  return sessions.flatMap((session) => {
    const projectId = session.projectId ?? session.currentProjectSnapshot?.projectId;
    const snapshot = projectId
      ? (snapshotByProjectId.get(projectId) ?? session.currentProjectSnapshot ?? null)
      : (session.currentProjectSnapshot ?? null);
    const memoryText = buildConversationMemoryText(session);
    if (!snapshot || !memoryText) return [];

    return [
      {
        id: `memory:${snapshot.projectId}:conversation-summary`,
        projectId: snapshot.projectId,
        projectKind: snapshot.projectKind,
        title: `${snapshot.title} · 会话结论`,
        kind: "conversation-summary" as const,
        text: [snapshot.currentObjective, memoryText.text].filter(Boolean).join("\n"),
        summary: memoryText.summary,
        updatedAt: memoryText.updatedAt,
        tags: [snapshot.projectKind, snapshot.derivedStage, "conversation", ...snapshot.recommendedActions].filter(
          Boolean,
        ),
      },
    ];
  });
}

function buildMaintenanceMemoryDocuments(reports: MaintenanceReport[]): ConversationMemoryDocument[] {
  return reports.slice(0, 6).map((report) => ({
    id: `memory:maintenance:${report.id}`,
    title: "维护报告",
    kind: "maintenance-report",
    text: [report.summary, ...report.notes].filter(Boolean).join("\n"),
    summary: truncate(report.summary, 150),
    updatedAt: report.createdAt,
    tags: ["maintenance", "cleanup", "summary"],
  }));
}

function buildSkillDraftMemoryDocuments(drafts: SkillDraft[]): ConversationMemoryDocument[] {
  return drafts.slice(0, 6).map((draft) => ({
    id: `memory:skill:${draft.id}`,
    title: `技能草案 · ${draft.proposedSkillName}`,
    kind: "skill-draft",
    text: [draft.proposedSkillName, draft.reason, draft.proposedContent].filter(Boolean).join("\n"),
    summary: truncate(draft.reason || draft.proposedSkillName, 150),
    updatedAt: draft.createdAt,
    tags: ["skill", draft.status, draft.proposedSkillName].filter(Boolean),
  }));
}

export function buildConversationMemoryCorpus(
  runtime: Pick<StudioRuntimeState, "recentProjects" | "currentProjectSnapshot" | "maintenanceReports" | "skillDrafts"> & {
    recentProjectSessions?: StudioSessionState[];
  },
): ConversationMemoryDocument[] {
  const projectSnapshots = [
    runtime.currentProjectSnapshot,
    ...runtime.recentProjects.filter(
      (snapshot) => snapshot.projectId !== runtime.currentProjectSnapshot?.projectId,
    ),
  ].filter((snapshot): snapshot is ConversationProjectSnapshot => Boolean(snapshot));

  const snapshotByProjectId = new Map(projectSnapshots.map((snapshot) => [snapshot.projectId, snapshot]));
  const projectDocuments = projectSnapshots.flatMap((snapshot) => buildMemoryDocumentsFromSnapshot(snapshot));
  const sessionDocuments = buildSessionMemoryDocuments(runtime.recentProjectSessions ?? [], snapshotByProjectId);
  return [
    ...projectDocuments,
    ...sessionDocuments,
    ...buildMaintenanceMemoryDocuments(runtime.maintenanceReports),
    ...buildSkillDraftMemoryDocuments(runtime.skillDrafts),
  ];
}

function scoreDocument(
  queryTokens: string[],
  document: ConversationMemoryDocument,
  currentProjectId?: string,
  preferCurrentProject = false,
): number {
  const titleHaystack = normalize(document.title);
  const summaryHaystack = normalize(document.summary);
  const tagHaystack = normalize(document.tags.join(" "));
  const textHaystack = normalize(document.text);
  const haystacks = [titleHaystack, summaryHaystack, tagHaystack, textHaystack].filter(Boolean);
  const hasMatch = queryTokens.some((token) => haystacks.some((haystack) => haystack.includes(token)));
  if (!hasMatch) return 0;

  let score =
    scoreField(titleHaystack, queryTokens, 12) +
    scoreField(summaryHaystack, queryTokens, 8) +
    scoreField(tagHaystack, queryTokens, 7) +
    scoreField(textHaystack, queryTokens, 4) +
    computeCoverageScore(queryTokens, haystacks);
  if (document.kind === "project-summary") score += 6;
  if (document.kind === "conversation-summary") score += 5;
  if (document.kind === "artifact") score += 4;
  if (document.projectId && document.projectId === currentProjectId) score += 3;
  if (preferCurrentProject && document.projectId && document.projectId === currentProjectId) {
    score += CURRENT_PROJECT_INTERNAL_BOOST;
  }
  return score;
}

export function isProjectInternalMemoryQuery(query: string): boolean {
  const normalized = normalize(query);
  if (!normalized) return false;

  const internalKeywords = [
    "失败",
    "待审",
    "审阅",
    "重做",
    "补发",
    "镜头",
    "素材",
    "资产",
    "角色卡",
    "角色状态卡",
    "剧情 beat",
    "beat",
    "修订包",
    "合规",
    "导出",
    "状态包",
    "bundle",
    "scene",
    "shot",
    "review",
  ];
  if (internalKeywords.some((keyword) => normalized.includes(keyword))) {
    return true;
  }

  const continuationWords = ["当前", "这轮", "这一轮", "上次", "刚才", "恢复", "继续", "回到"];
  const projectNouns = ["项目", "结果", "内容", "记录", "状态"];
  return continuationWords.some((word) => normalized.includes(word)) && projectNouns.some((noun) => normalized.includes(noun));
}

export function searchConversationMemory(
  query: string,
  documents: ConversationMemoryDocument[],
  currentProjectId?: string,
  options?: {
    preferCurrentProject?: boolean;
  },
): ConversationMemoryDocument[] {
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];
  const preferCurrentProject = options?.preferCurrentProject === true;

  const rankedEntries = documents
    .map((document) => ({
      document,
      score: scoreDocument(queryTokens, document, currentProjectId, preferCurrentProject),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.document.updatedAt).getTime() - new Date(a.document.updatedAt).getTime();
    });

  const selected: Array<(typeof rankedEntries)[number]> = [];
  const selectedProjectIds = new Set<string>();
  const selectedKinds = new Set<ConversationMemoryKind>();

  while (selected.length < MEMORY_RESULT_LIMIT) {
    let bestIndex = -1;
    let bestScore = -Infinity;

    for (let index = 0; index < rankedEntries.length; index += 1) {
      const entry = rankedEntries[index];
      if (!entry) continue;
      if (selected.some((picked) => picked.document.id === entry.document.id)) continue;

      let adjustedScore = entry.score;
      const isCurrentProjectDocument =
        preferCurrentProject &&
        entry.document.projectId &&
        entry.document.projectId === currentProjectId;
      if (!isCurrentProjectDocument && entry.document.projectId && selectedProjectIds.has(entry.document.projectId)) {
        adjustedScore -= SAME_PROJECT_PENALTY;
      }
      if (selectedKinds.has(entry.document.kind)) {
        adjustedScore -= SAME_KIND_PENALTY;
      }

      if (adjustedScore > bestScore) {
        bestScore = adjustedScore;
        bestIndex = index;
      }
    }

    if (bestIndex < 0) break;

    const nextEntry = rankedEntries[bestIndex];
    if (!nextEntry) break;

    selected.push(nextEntry);
    if (nextEntry.document.projectId) {
      selectedProjectIds.add(nextEntry.document.projectId);
    }
    selectedKinds.add(nextEntry.document.kind);
  }

  return selected.map((entry) => entry.document);
}

export function buildConversationMemoryPrompt(documents: ConversationMemoryDocument[]): string | undefined {
  if (!documents.length) return undefined;
  return [
    "以下是与当前输入相关的历史记忆，仅在确实相关时复用，不要生硬套用：",
    ...documents.map((document) =>
      [
        `- ${document.title}`,
        `  类型：${document.kind}`,
        `  摘要：${document.summary}`,
      ].join("\n"),
    ),
  ].join("\n");
}

export function buildConversationMemoryHint(documents: ConversationMemoryDocument[]): string | undefined {
  if (!documents.length) return undefined;

  const kinds = Array.from(new Set(documents.map((document) => document.kind)));
  if (kinds.length !== 1) return `已参考 ${documents.length} 条历史经验`;

  return `已参考 ${documents.length} 条${MEMORY_KIND_HINT_LABEL[kinds[0]]}`;
}
