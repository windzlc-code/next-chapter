import {
  resolvePersistedAttachmentPreviewUrl,
  stripAttachmentPayloadForHistory,
  type ChatAttachment,
} from "@/lib/agent/chat-attachments";
import type {
  AgentControlMode,
  ComposerQuestion,
  ComposerQuestionOption,
  CreationMode,
  HomeAgentMessage,
  StudioSessionState,
} from "./types";
import { normalizeArtifactSnapshots } from "./message-artifact-snapshots";
import { normalizeAutomationMode } from "./automation-mode";
import { isExpiredRemoteSignedMediaUrl } from "./media-url";
import {
  normalizeHomeAgentImageModelFamilyKey,
  normalizeVideoImageGenerationPrefs,
} from "./image-models";
import {
  normalizeHomeAgentVideoModelKey,
  normalizeVideoGenerationPrefs,
} from "./video-models";
import {
  deleteConversationArchive,
  invalidateConversationArchiveScanCache,
  readConversationArchiveFull,
  readLatestConversationArchiveSession,
  writeConversationArchiveFull,
} from "./conversation-archive";
import type { ProductionAssetManifest } from "@/types/project";

const STUDIO_SESSION_KEY = "storyforge-home-agent-session-v1";
const STUDIO_SESSION_BOOTSTRAP_KEY = "storyforge-home-agent-session-bootstrap-v1";
const STUDIO_PROJECT_SESSIONS_KEY = "storyforge-home-agent-project-sessions-v1";
// 记录最近一次被主动清除的 projectId，防止文件系统恢复时把已删除的会话重新写回
const STUDIO_SESSION_RESET_MARKER_KEY = "storyforge-session-reset-marker-v1";

// session map 内存缓存，避免每次切换项目都重新解析整个 localStorage JSON
let sessionMapCache: Record<string, StudioSessionState> | null = null;
let activeSessionCache: StudioSessionState | null | undefined = undefined;
let queuedFullSessionCache: StudioSessionState | null = null;
let queuedPersistHandle: number | null = null;
let queuedPersistNeedsFullBackup = false;
const STORAGE_LEVELS = ["standard", "compact", "minimal"] as const;
const PROJECT_SESSION_ENTRY_LIMITS = {
  standard: 20,
  compact: 10,
  minimal: 5,
} as const;

type StorageLevel = (typeof STORAGE_LEVELS)[number];
type StudioSessionBootstrapCache = {
  version: 1;
  session: StudioSessionState | null;
  rawMessageCount: number;
  rawArtifactCount: number;
  rawAssetManifestCount?: number;
};

function safeReadJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;

  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function safeWriteJson(key: string, value: unknown): boolean {
  if (typeof window === "undefined") return true;
  localStorage.setItem(key, JSON.stringify(value));
  return true;
}

function clearQueuedPersistHandle(): void {
  if (typeof window === "undefined" || queuedPersistHandle === null) return;
  window.clearTimeout(queuedPersistHandle);
  queuedPersistHandle = null;
}

function readSessionResetMarkerSet(): Set<string> {
  if (typeof window === "undefined") return new Set();
  const raw = localStorage.getItem(STUDIO_SESSION_RESET_MARKER_KEY);
  if (!raw) return new Set();

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0));
    }
    if (typeof parsed === "string" && parsed.trim()) {
      return new Set([parsed]);
    }
  } catch {
    if (raw.trim()) {
      return new Set([raw]);
    }
  }

  return new Set();
}

function writeSessionResetMarkerSet(projectIds: Iterable<string>): void {
  if (typeof window === "undefined") return;
  const next = [...new Set(
    [...projectIds].filter((projectId): projectId is string => typeof projectId === "string" && projectId.trim().length > 0),
  )];
  if (!next.length) {
    localStorage.removeItem(STUDIO_SESSION_RESET_MARKER_KEY);
    return;
  }
  localStorage.setItem(STUDIO_SESSION_RESET_MARKER_KEY, JSON.stringify(next));
}

function hasSessionResetMarker(projectId: string | null | undefined): boolean {
  if (typeof window === "undefined" || !projectId) return false;
  return readSessionResetMarkerSet().has(projectId);
}

function getSessionProjectId(session: StudioSessionState | null | undefined): string | null {
  if (!session) return null;
  if (typeof session.projectId === "string" && session.projectId.trim()) {
    return session.projectId;
  }
  if (
    typeof session.currentProjectSnapshot?.projectId === "string" &&
    session.currentProjectSnapshot.projectId.trim()
  ) {
    return session.currentProjectSnapshot.projectId;
  }
  return null;
}

function shouldIgnoreDeletedProjectSession(session: StudioSessionState | null | undefined): boolean {
  return hasSessionResetMarker(getSessionProjectId(session));
}

function truncateText(value: string | undefined, max: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.length > max ? `${trimmed.slice(0, Math.max(0, max - 1))}…` : trimmed;
}

const STORYBOARD_BREAKDOWN_MESSAGE_PREFIX = "以下按导出拆镜 xlsx 的分段结构展示";
const STORYBOARD_BREAKDOWN_BLOCK_RE = /```json\s*[\s\S]*```/i;

function shouldPreserveStructuredMessageContent(value: string | undefined): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return trimmed.includes(STORYBOARD_BREAKDOWN_MESSAGE_PREFIX) && STORYBOARD_BREAKDOWN_BLOCK_RE.test(trimmed);
}

function compactMessageContent(value: string | undefined, max: number): string {
  if (shouldPreserveStructuredMessageContent(value)) {
    return typeof value === "string" ? value.trim() : "";
  }
  return truncateText(value, max);
}

function normalizeAgentControlMode(value: unknown): AgentControlMode {
  return value === "script-dev" ? "script-dev" : "llm";
}

function normalizeCreationMode(value: unknown, legacyValue?: unknown): CreationMode {
  if (value === "fast") return "fast";
  if (value === "creative") return "fast";
  return "fast";
}

function normalizeDevMode(value: unknown, legacyValue?: unknown): boolean {
  if (typeof value === "boolean") return value;
  return normalizeAgentControlMode(legacyValue) === "script-dev";
}

function isFullAutoContinuationAssistantMessage(message: HomeAgentMessage): boolean {
  if (message.role !== "assistant") return false;
  const content = typeof message.content === "string" ? message.content.trim() : "";
  return (
    content.includes("全自动执行已停止。选择当前步骤选项后会继续自动链路") ||
    content.startsWith("继续全自动链路，将从“") ||
    content.startsWith("已切换为全自动原创剧本。")
  );
}

export function sessionHasFullAutoLineage(
  session: Pick<StudioSessionState, "automationMode" | "currentProjectSnapshot" | "fullAutoRun" | "messages"> | null | undefined,
): boolean {
  if (!session) return false;
  if (session.fullAutoRun) return true;
  if (
    normalizeAutomationMode(
      session.automationMode ?? session.currentProjectSnapshot?.automationMode,
    ) === "full-auto"
  ) {
    return true;
  }
  return Array.isArray(session.messages)
    ? session.messages.some((message) => {
        const row = message as HomeAgentMessage;
        return row.automationOrigin === "full-auto" || isFullAutoContinuationAssistantMessage(row);
      })
    : false;
}

function normalizeSuppressHistoricalMemory(
  value: unknown,
  currentProjectSnapshot: StudioSessionState["currentProjectSnapshot"],
): boolean {
  if (typeof value === "boolean") return value;
  return !currentProjectSnapshot;
}

function normalizeFullAutoChecklistCollapsed(value: unknown): boolean {
  return typeof value === "boolean" ? value : true;
}

function pruneExpiredMediaFromAttachment(
  attachment: ChatAttachment,
): { attachment: ChatAttachment; removedCount: number; changed: boolean } {
  if (attachment.kind !== "image" && attachment.kind !== "video") {
    return { attachment, removedCount: 0, changed: false };
  }

  let removedCount = 0;
  const nextAttachment: ChatAttachment = { ...attachment };

  if (isExpiredRemoteSignedMediaUrl(nextAttachment.previewUrl)) {
    nextAttachment.previewUrl = undefined;
    removedCount += 1;
  }

  if (isExpiredRemoteSignedMediaUrl(nextAttachment.localPath)) {
    nextAttachment.localPath = undefined;
    removedCount += 1;
  }

  if (Array.isArray(nextAttachment.history)) {
    const nextHistory = nextAttachment.history.filter((entry) => {
      const expiredPreview = isExpiredRemoteSignedMediaUrl(entry.previewUrl);
      const expiredLocal = isExpiredRemoteSignedMediaUrl(entry.localPath);
      if (expiredPreview || expiredLocal) {
        removedCount += 1;
        return false;
      }
      return true;
    });
    nextAttachment.history = nextHistory.length ? nextHistory : undefined;
  }

  return {
    attachment: nextAttachment,
    removedCount,
    changed: removedCount > 0,
  };
}

export function pruneExpiredMediaFromSession(
  session: StudioSessionState,
): { session: StudioSessionState; removedCount: number; changed: boolean } {
  let removedCount = 0;
  let changed = false;

  const messages = session.messages.map((message) => {
    if (!Array.isArray(message.attachments) || message.attachments.length === 0) {
      return message;
    }

    let messageChanged = false;
    const nextAttachments = message.attachments.map((attachment) => {
      const pruned = pruneExpiredMediaFromAttachment(attachment);
      if (pruned.changed) {
        messageChanged = true;
        removedCount += pruned.removedCount;
      }
      return pruned.attachment;
    });

    if (!messageChanged) {
      return message;
    }

    changed = true;
    return {
      ...message,
      attachments: nextAttachments,
    };
  });

  return {
    session: changed ? { ...session, messages } : session,
    removedCount,
    changed,
  };
}

function normalizeAttachment(attachment: unknown): ChatAttachment | null {
  if (!attachment || typeof attachment !== "object") return null;
  const record = attachment as Partial<ChatAttachment>;
  if (typeof record.fileName !== "string" || typeof record.mimeType !== "string") return null;
  if (
    record.kind !== "image" &&
    record.kind !== "video" &&
    record.kind !== "document" &&
    record.kind !== "text" &&
    record.kind !== "binary"
  ) {
    return null;
  }

  return pruneExpiredMediaFromAttachment({
    id: typeof record.id === "string" && record.id.trim() ? record.id : crypto.randomUUID(),
    fileName: record.fileName,
    label: typeof record.label === "string" ? record.label : undefined,
    mimeType: record.mimeType,
    size: typeof record.size === "number" && Number.isFinite(record.size) ? record.size : 0,
    kind: record.kind,
    localPath: typeof record.localPath === "string" ? record.localPath : undefined,
    previewUrl: resolvePersistedAttachmentPreviewUrl({
      kind: record.kind,
      localPath: typeof record.localPath === "string" ? record.localPath : undefined,
      previewUrl: typeof record.previewUrl === "string" ? record.previewUrl : undefined,
    }),
    extractedText: typeof record.extractedText === "string" ? record.extractedText : undefined,
    fallbackDigest: typeof record.fallbackDigest === "string" ? record.fallbackDigest : undefined,
    history: Array.isArray(record.history)
      ? record.history
          .filter((entry): entry is NonNullable<ChatAttachment["history"]>[number] => Boolean(entry && typeof entry === "object"))
          .map((entry) => ({
            id: typeof entry.id === "string" && entry.id.trim() ? entry.id : crypto.randomUUID(),
            fileName: typeof entry.fileName === "string" ? entry.fileName : record.fileName,
            label: typeof entry.label === "string" ? entry.label : undefined,
            localPath: typeof entry.localPath === "string" ? entry.localPath : undefined,
            previewUrl: resolvePersistedAttachmentPreviewUrl({
              kind: record.kind,
              localPath: typeof entry.localPath === "string" ? entry.localPath : undefined,
              previewUrl: typeof entry.previewUrl === "string" ? entry.previewUrl : undefined,
            }),
            createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
          }))
      : undefined,
    generationContext:
      record.generationContext &&
      typeof record.generationContext === "object" &&
      typeof record.generationContext.action === "string"
        ? {
            action: record.generationContext.action as NonNullable<ChatAttachment["generationContext"]>["action"],
            projectId:
              typeof record.generationContext.projectId === "string"
                ? record.generationContext.projectId
                : undefined,
            targetId:
              typeof record.generationContext.targetId === "string"
                ? record.generationContext.targetId
                : undefined,
            regenerateMode:
              record.generationContext.regenerateMode === "redo-and-generate"
                ? "redo-and-generate"
                : record.generationContext.regenerateMode === "generate"
                  ? "generate"
                  : undefined,
          }
        : undefined,
  }).attachment;
}

function trimStringArray(values: string[] | undefined, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === "string")
    .slice(0, maxItems)
    .map((value) => truncateText(value, maxChars))
    .filter(Boolean);
}

function isQuotaExceededError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof DOMException) {
    return error.name === "QuotaExceededError" || error.code === 22 || error.code === 1014;
  }
  return false;
}

function persistActiveSessionCache(): void {
  if (typeof window === "undefined") return;

  if (activeSessionCache === null) {
    localStorage.removeItem(STUDIO_SESSION_KEY);
    localStorage.removeItem(STUDIO_SESSION_BOOTSTRAP_KEY);
    return;
  }

  if (activeSessionCache) {
    tryWriteJson(STUDIO_SESSION_KEY, (level) => compactSessionForStorage(activeSessionCache, level));
    writeStudioSessionBootstrapCache(activeSessionCache);
  }
}

function persistProjectSessionCache(activeProjectId = activeSessionCache?.projectId ?? ""): void {
  if (!sessionMapCache) return;

  const orderedSessions = orderProjectSessions(sessionMapCache, activeProjectId);
  tryWriteJson(STUDIO_PROJECT_SESSIONS_KEY, (level) =>
    Object.fromEntries(
      orderedSessions
        .slice(0, PROJECT_SESSION_ENTRY_LIMITS[level])
        .map(([projectId, projectSession]) => [projectId, compactSessionForStorage(projectSession, level)]),
    ),
  );
}

function flushQueuedSessionPersistence(): void {
  clearQueuedPersistHandle();
  const fullSession = queuedFullSessionCache;
  const shouldWriteFullBackup = queuedPersistNeedsFullBackup;
  queuedFullSessionCache = null;
  queuedPersistNeedsFullBackup = false;
  persistActiveSessionCache();
  persistProjectSessionCache();
  if (shouldWriteFullBackup && fullSession?.projectId) {
    // Keep the full archive in sync without copying large media folders on debounced saves.
    void writeFullSessionBackup(fullSession, { copyLegacyProjectMedia: false });
  }
}

function sessionHasInlinePreviewPayload(session: StudioSessionState | null | undefined): boolean {
  if (!session?.messages?.length) return false;

  return session.messages.some((message) =>
    (message.attachments ?? []).some((attachment) =>
      (typeof attachment.previewUrl === "string" && attachment.previewUrl.startsWith("data:")) ||
      (attachment.history ?? []).some(
        (entry) => typeof entry.previewUrl === "string" && entry.previewUrl.startsWith("data:"),
      ),
    ),
  );
}

function normalizedSessionNeedsRewrite(
  rawSession: StudioSessionState | null | undefined,
  normalizedSession: StudioSessionState | null | undefined,
): boolean {
  if (!rawSession || !normalizedSession) return false;
  const rawAutomationMode = normalizeAutomationMode(
    rawSession.automationMode ?? rawSession.currentProjectSnapshot?.automationMode,
  );
  if (rawAutomationMode !== normalizedSession.automationMode) {
    return true;
  }
  const rawSnapshotAutomationMode = normalizeAutomationMode(
    rawSession.currentProjectSnapshot?.automationMode ?? rawSession.automationMode,
  );
  return (
    normalizedSession.currentProjectSnapshot?.automationMode != null &&
    rawSnapshotAutomationMode !== normalizedSession.currentProjectSnapshot.automationMode
  );
}

function scheduleQueuedSessionPersistence(delay = 120): void {
  if (typeof window === "undefined") {
    flushQueuedSessionPersistence();
    return;
  }

  if (queuedPersistHandle !== null) return;
  queuedPersistHandle = window.setTimeout(() => {
    flushQueuedSessionPersistence();
  }, Math.max(0, delay));
}

function messageLimit(level: StorageLevel): { count: number; chars: number } {
  switch (level) {
    case "compact":
      return { count: 100, chars: 1200 };
    case "minimal":
      return { count: 40, chars: 600 };
    default:
      return { count: 180, chars: 3200 };
  }
}

function artifactLimit(level: StorageLevel): { count: number; summaryChars: number; contentChars: number } {
  switch (level) {
    case "compact":
      return { count: 6, summaryChars: 180, contentChars: 0 };
    case "minimal":
      return { count: 4, summaryChars: 120, contentChars: 0 };
    default:
      return { count: 10, summaryChars: 260, contentChars: 480 };
  }
}

function compactQuestionStateForStorage(
  qState: StudioSessionState["qState"],
  level: StorageLevel,
): StudioSessionState["qState"] {
  const normalized = normalizeQuestionState(qState);
  if (!normalized) return null;

  const questionLimit = level === "minimal" ? 4 : 8;
  const optionLimit = level === "minimal" ? 4 : 6;
  const textLimit = level === "minimal" ? 120 : level === "compact" ? 180 : 260;
  const answerLimit = level === "minimal" ? 140 : 260;
  const questionStart = Math.max(0, normalized.currentIndex - questionLimit + 1);
  const questionSlice = normalized.request.questions.slice(questionStart, questionStart + questionLimit);
  const nextCurrentIndex = Math.max(0, normalized.currentIndex - questionStart);

  return {
    source: normalized.source,
    currentIndex: nextCurrentIndex,
    request: {
      id: normalized.request.id,
      description: truncateText(normalized.request.description, textLimit),
      allowCustomInput: normalized.request.allowCustomInput !== false,
      submissionMode: normalized.request.submissionMode === "confirm" ? "confirm" : "immediate",
      questions: questionSlice.map((question) => ({
        header: truncateText(question.header, 48) || "问题",
        question: truncateText(question.question, textLimit),
        multiSelect: !!question.multiSelect,
        ...(question.presentation === "chip" || question.presentation === "card"
          ? { presentation: question.presentation }
          : {}),
        options: question.options.slice(0, optionLimit).map((option) => ({
          label: truncateText(option.label, 64) || "选项",
          value: truncateText(option.value || option.label, 120) || truncateText(option.label, 64) || "选项",
          description: truncateText(option.description, textLimit),
          rationale: truncateText(option.rationale, textLimit),
        })),
      })),
    },
    answers: Object.fromEntries(
      Object.entries(normalized.answers).map(([key, value]) => [truncateText(key, 64), truncateText(value, answerLimit)]),
    ),
    displayAnswers: Object.fromEntries(
      Object.entries(normalized.displayAnswers).map(([key, value]) => [
        truncateText(key, 64),
        truncateText(value, answerLimit),
      ]),
    ),
  };
}

function compactComposerQuestionForStorage(
  question: StudioSessionState["pendingChoiceQuestion"],
  level: StorageLevel,
): StudioSessionState["pendingChoiceQuestion"] {
  if (!question) return null;

  const optionLimit = level === "minimal" ? 4 : 6;
  const textLimit = level === "minimal" ? 120 : level === "compact" ? 180 : 260;

  const compactOption = (option: import("./types").ComposerQuestionOption): import("./types").ComposerQuestionOption => ({
    id: truncateText(option.id, 64) || crypto.randomUUID(),
    label: truncateText(option.label, 64) || "选项",
    value: truncateText(option.value, 120) || truncateText(option.label, 64) || "选项",
    rationale: truncateText(option.rationale, textLimit) || undefined,
    selected: !!option.selected,
    disabled: !!option.disabled,
    devOnly: !!option.devOnly,
    childInput: option.childInput
      ? {
          ...option.childInput,
          actionPrefix: truncateText(option.childInput.actionPrefix, 120),
          buttonLabel: truncateText(option.childInput.buttonLabel, 32) || undefined,
          labelTemplate: truncateText(option.childInput.labelTemplate, 80) || undefined,
          placeholder: truncateText(option.childInput.placeholder, 80) || undefined,
          pattern: truncateText(option.childInput.pattern, 120) || undefined,
          suffix: truncateText(option.childInput.suffix, 16) || undefined,
        }
      : undefined,
    confirmDialog: option.confirmDialog
      ? {
          title: truncateText(option.confirmDialog.title, 80) || "确认",
          description: truncateText(option.confirmDialog.description, textLimit),
          confirmLabel: truncateText(option.confirmDialog.confirmLabel, 24) || undefined,
          cancelLabel: truncateText(option.confirmDialog.cancelLabel, 24) || undefined,
          summaryRows: trimStringArray(option.confirmDialog.summaryRows, 6, 80),
        }
      : undefined,
    children: option.children?.slice(0, optionLimit).map(compactOption),
  });

  return {
    id: truncateText(question.id, 80) || crypto.randomUUID(),
    title: truncateText(question.title, 80) || "待处理选项",
    description: truncateText(question.description, textLimit) || undefined,
    options: question.options.slice(0, optionLimit).map(compactOption),
    presentation: question.presentation,
    allowCustomInput: question.allowCustomInput !== false,
    submissionMode: question.submissionMode === "confirm" ? "confirm" : "immediate",
    multiSelect: !!question.multiSelect,
    stepIndex:
      typeof question.stepIndex === "number" && Number.isFinite(question.stepIndex)
        ? Math.max(0, question.stepIndex)
        : 0,
    totalSteps:
      typeof question.totalSteps === "number" && Number.isFinite(question.totalSteps)
        ? Math.max(1, question.totalSteps)
        : 1,
    answerKey: truncateText(question.answerKey, 80) || "pending-choice",
    statusBadges: question.statusBadges?.slice(0, 4).map((badge) => ({
      label: truncateText(badge.label, 24) || "状态",
      value: truncateText(String(badge.value), 24),
      tone: badge.tone,
    })),
  };
}

function normalizeStoredComposerQuestion(
  question: StudioSessionState["pendingChoiceQuestion"],
): StudioSessionState["pendingChoiceQuestion"] {
  return question && typeof question === "object" ? question : null;
}

function countStoredQuestionOptions(options: ComposerQuestionOption[] | undefined): number {
  if (!options?.length) return 0;
  return options.reduce(
    (total, option) => total + 1 + countStoredQuestionOptions(option.children),
    0,
  );
}

function scoreStoredVideoBridgeQuestionValue(value: string | undefined): number {
  if (!value) return 0;
  if (value === "video:analyze" || value === "video:bridge:next-step") return 10;
  if (value === "video:bridge:entities") return 20;
  if (value.startsWith("video:bridge:reference-assets")) return 30;
  if (value === "video:bridge:storyboard" || value === "video:step:storyboard") return 40;
  if (value === "video:bridge:shots") return 50;
  if (value.startsWith("video:bridge:prompts")) return 60;
  if (value === "video:step:render" || value === "video:step:video") return 70;
  return 0;
}

function collectStoredVideoBridgeStageScore(options: ComposerQuestionOption[] | undefined): number {
  if (!options?.length) return 0;
  return options.reduce((best, option) => {
    const optionScore = scoreStoredVideoBridgeQuestionValue(option.value);
    const childScore = collectStoredVideoBridgeStageScore(option.children);
    return Math.max(best, optionScore, childScore);
  }, 0);
}

function inferStoredVideoBridgeQuestionStageScore(question: ComposerQuestion | null): number {
  if (!question || question.answerKey !== "video-bridge-panel") return 0;

  let stageScore = collectStoredVideoBridgeStageScore(question.options);
  const stepIndex =
    typeof question.stepIndex === "number" && Number.isFinite(question.stepIndex)
      ? Math.max(0, question.stepIndex)
      : -1;
  if (stepIndex >= 0) {
    stageScore = Math.max(stageScore, (stepIndex + 1) * 10);
  }

  const labelText = `${question.title ?? ""} ${question.description ?? ""}`.toLowerCase();
  if (labelText.includes("预览") || labelText.includes("导出")) {
    stageScore = Math.max(stageScore, 70);
  } else if (labelText.includes("视频生成") || labelText.includes("出片")) {
    stageScore = Math.max(stageScore, 60);
  } else if (labelText.includes("提示词") || labelText.includes("镜头包")) {
    stageScore = Math.max(stageScore, 50);
  } else if (labelText.includes("分镜")) {
    stageScore = Math.max(stageScore, 40);
  } else if (labelText.includes("角色与场景") || labelText.includes("参考图")) {
    stageScore = Math.max(stageScore, 30);
  } else if (labelText.includes("脚本拆解")) {
    stageScore = Math.max(stageScore, 20);
  }

  return stageScore;
}

function scoreStoredChoiceQuestionForRecovery(question: ComposerQuestion | null): number {
  if (!question) return Number.NEGATIVE_INFINITY;
  if (question.answerKey !== "video-bridge-panel") return 0;

  const stageScore = inferStoredVideoBridgeQuestionStageScore(question);
  const stepScore =
    typeof question.stepIndex === "number" && Number.isFinite(question.stepIndex)
      ? Math.max(0, question.stepIndex + 1)
      : 0;
  const statusBadgeCount = question.statusBadges?.length ?? 0;
  const optionCount = countStoredQuestionOptions(question.options);
  return stageScore * 100 + stepScore * 10 + statusBadgeCount * 5 + optionCount;
}

function reconcileStoredChoiceQuestions(
  pendingChoiceQuestion: StudioSessionState["pendingChoiceQuestion"],
  interruptedChoiceQuestion: StudioSessionState["pendingChoiceQuestion"],
): {
  pendingChoiceQuestion: StudioSessionState["pendingChoiceQuestion"];
  interruptedChoiceQuestion: StudioSessionState["pendingChoiceQuestion"];
} {
  if (!pendingChoiceQuestion || !interruptedChoiceQuestion) {
    return { pendingChoiceQuestion, interruptedChoiceQuestion };
  }

  if (
    pendingChoiceQuestion.answerKey === "video-bridge-panel" &&
    interruptedChoiceQuestion.answerKey === "video-bridge-panel"
  ) {
    const pendingScore = scoreStoredChoiceQuestionForRecovery(pendingChoiceQuestion);
    const interruptedScore = scoreStoredChoiceQuestionForRecovery(interruptedChoiceQuestion);
    if (interruptedScore > pendingScore) {
      return {
        pendingChoiceQuestion: interruptedChoiceQuestion,
        interruptedChoiceQuestion,
      };
    }
  }

  return { pendingChoiceQuestion, interruptedChoiceQuestion };
}

function normalizeConsistentProjectSnapshot(
  snapshot: StudioSessionState["currentProjectSnapshot"],
  sessionProjectId: string | undefined,
  sessionAutomationMode: StudioSessionState["automationMode"] | undefined,
): StudioSessionState["currentProjectSnapshot"] {
  if (!snapshot) return null;

  const normalizedSessionProjectId =
    typeof sessionProjectId === "string" && sessionProjectId.trim()
      ? sessionProjectId.trim()
      : undefined;
  const normalizedSnapshotProjectId =
    typeof snapshot.projectId === "string" && snapshot.projectId.trim()
      ? snapshot.projectId.trim()
      : undefined;
  const normalizedSourceProjectId =
    typeof snapshot.sourceProjectId === "string" && snapshot.sourceProjectId.trim()
      ? snapshot.sourceProjectId.trim()
      : undefined;
  const isBridgedVideoSnapshot =
    normalizedSessionProjectId &&
    normalizedSnapshotProjectId &&
    normalizedSessionProjectId !== normalizedSnapshotProjectId &&
    snapshot.projectKind === "video" &&
    normalizedSourceProjectId === normalizedSessionProjectId;

  // A project-scoped session can momentarily carry the previous project's
  // snapshot during a history switch. Dropping that stale snapshot keeps the
  // message history while forcing the next restore to use the authoritative
  // project snapshot from storage.
  if (
    normalizedSessionProjectId &&
    normalizedSnapshotProjectId &&
    normalizedSessionProjectId !== normalizedSnapshotProjectId &&
    !isBridgedVideoSnapshot
  ) {
    return null;
  }

  return {
    ...snapshot,
    projectId: normalizedSnapshotProjectId ?? normalizedSessionProjectId,
    sourceProjectId: normalizedSourceProjectId,
    automationMode:
      sessionAutomationMode === "full-auto"
        ? "full-auto"
        : normalizeAutomationMode(snapshot.automationMode ?? sessionAutomationMode),
  };
}

function compactProjectSnapshotForStorage(
  snapshot: StudioSessionState["currentProjectSnapshot"],
  level: StorageLevel,
): StudioSessionState["currentProjectSnapshot"] {
  if (!snapshot) return null;

  const limits = artifactLimit(level);
  const compactedAssetManifest = compactAssetManifestForStorage(snapshot.memory?.assetManifest, level);

  return {
    projectId: snapshot.projectId,
    projectKind: snapshot.projectKind,
    sourceProjectId: snapshot.sourceProjectId,
    automationMode: normalizeAutomationMode(snapshot.automationMode),
    title: truncateText(snapshot.title, level === "minimal" ? 40 : 80) || "未命名项目",
    currentObjective: truncateText(snapshot.currentObjective, level === "minimal" ? 120 : 220),
    derivedStage: truncateText(snapshot.derivedStage, 40) || "继续创作",
    agentSummary: truncateText(snapshot.agentSummary, level === "minimal" ? 180 : 320),
    recommendedActions: trimStringArray(snapshot.recommendedActions, level === "minimal" ? 3 : 6, 120),
    artifacts: snapshot.artifacts.slice(0, limits.count).map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      label: truncateText(artifact.label, 80) || "产物",
      summary: truncateText(artifact.summary, limits.summaryChars),
      content: limits.contentChars > 0 ? truncateText(artifact.content, limits.contentChars) : undefined,
      updatedAt: artifact.updatedAt,
      presentation: artifact.presentation,
      payload: artifact.payload,
      actions: artifact.actions?.slice(0, 8),
    })),
    updatedAt: snapshot.updatedAt,
    ...(compactedAssetManifest
      ? {
          memory: {
            assetManifest: compactedAssetManifest,
          },
        }
      : {}),
  };
}

function compactSessionForStorage(session: StudioSessionState, level: StorageLevel): StudioSessionState {
  const limits = messageLimit(level);

  return {
    sessionId: session.sessionId,
    compactedMessageCount:
      typeof session.compactedMessageCount === "number" && Number.isFinite(session.compactedMessageCount)
        ? Math.max(0, session.compactedMessageCount)
        : 0,
    mode: session.mode,
    creationMode: normalizeCreationMode(session.creationMode, session.agentControlMode),
    automationMode: normalizeAutomationMode(session.automationMode ?? session.currentProjectSnapshot?.automationMode),
    devMode: normalizeDevMode(session.devMode, session.agentControlMode),
    suppressHistoricalMemory: normalizeSuppressHistoricalMemory(
      session.suppressHistoricalMemory,
      session.currentProjectSnapshot ?? null,
    ),
    messages: session.messages.slice(-limits.count).map((message) => ({
      ...message,
      content: compactMessageContent(message.content, limits.chars),
      artifactSnapshots:
        level === "minimal"
          ? undefined
          : normalizeArtifactSnapshots(message.artifactSnapshots)?.slice(0, 3),
      attachments: Array.isArray(message.attachments)
        ? message.attachments
            .map((attachment) => normalizeAttachment(attachment))
            .filter((attachment): attachment is ChatAttachment => Boolean(attachment))
            .slice(0, 8)
            .map((attachment) => stripAttachmentPayloadForHistory(attachment))
        : undefined,
    })),
    currentProjectSnapshot: compactProjectSnapshotForStorage(session.currentProjectSnapshot, level),
    recentMessageSummary: truncateText(
      session.recentMessageSummary,
      level === "minimal" ? 1000 : level === "compact" ? 1800 : 3200,
    ),
    projectId: session.projectId,
    ...(typeof session.selectedTextModelKey === "string" && session.selectedTextModelKey.trim()
      ? { selectedTextModelKey: truncateText(session.selectedTextModelKey, 80) }
      : {}),
    ...(typeof session.selectedImageModelFamily === "string" && session.selectedImageModelFamily.trim()
      ? { selectedImageModelFamily: normalizeHomeAgentImageModelFamilyKey(session.selectedImageModelFamily) }
      : {}),
    imageGenerationPrefs: normalizeVideoImageGenerationPrefs(session.imageGenerationPrefs),
    ...(typeof session.selectedVideoModelKey === "string" && session.selectedVideoModelKey.trim()
      ? { selectedVideoModelKey: normalizeHomeAgentVideoModelKey(session.selectedVideoModelKey) }
      : {}),
    videoGenerationPrefs: normalizeVideoGenerationPrefs(session.videoGenerationPrefs),
    draft: truncateText(session.draft, level === "minimal" ? 400 : level === "compact" ? 1000 : 2400),
    qState: compactQuestionStateForStorage(session.qState, level),
    deferredQuestionState: compactQuestionStateForStorage(session.deferredQuestionState, level),
    pendingWorkflowUploadKind: session.pendingWorkflowUploadKind ?? null,
    pendingChoiceQuestion: compactComposerQuestionForStorage(session.pendingChoiceQuestion, level),
    interruptedChoiceQuestion: compactComposerQuestionForStorage(session.interruptedChoiceQuestion, level),
    selectedValues: trimStringArray(session.selectedValues, level === "minimal" ? 6 : 12, 120),
    deferredSelectedValues: trimStringArray(session.deferredSelectedValues, level === "minimal" ? 6 : 12, 120),
    deferredDraft: truncateText(
      session.deferredDraft,
      level === "minimal" ? 240 : level === "compact" ? 600 : 1200,
    ),
    surfacedTaskIds: trimStringArray(session.surfacedTaskIds, 40, 120),
    surfacedTaskFollowupKeys: trimStringArray(session.surfacedTaskFollowupKeys, 40, 120),
    surfacedProjectSuggestionKeys: trimStringArray(session.surfacedProjectSuggestionKeys, 40, 160),
    fullAutoRun: session.fullAutoRun ?? null,
    fullAutoChecklistCollapsed: normalizeFullAutoChecklistCollapsed(session.fullAutoChecklistCollapsed),
  };
}

function tryWriteJson(key: string, buildValue: (level: StorageLevel) => unknown): boolean {
  if (typeof window === "undefined") return false;

  for (const level of STORAGE_LEVELS) {
    try {
      if (safeWriteJson(key, buildValue(level))) {
        return true;
      }
    } catch (error) {
      if (!isQuotaExceededError(error) || level === STORAGE_LEVELS[STORAGE_LEVELS.length - 1]) {
        break;
      }
    }
  }

  // 写入失败时保留旧数据，不删除，避免历史记录丢失
  return false;
}

function normalizeQuestionState(
  qState: StudioSessionState["qState"],
  forceRestored = false,
): StudioSessionState["qState"] {
  if (!qState || typeof qState !== "object" || !qState.request) return null;

  return {
    source:
      qState.source === "deferred"
        ? "deferred"
        : forceRestored
          ? "restored"
          : qState.source === "live"
            ? "live"
            : "restored",
    request: qState.request,
    currentIndex:
      typeof qState.currentIndex === "number" && Number.isFinite(qState.currentIndex)
        ? Math.max(0, qState.currentIndex)
        : 0,
    answers:
      qState.answers && typeof qState.answers === "object"
        ? Object.fromEntries(
            Object.entries(qState.answers).filter(
              (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
            ),
          )
        : {},
    displayAnswers:
      qState.displayAnswers && typeof qState.displayAnswers === "object"
        ? Object.fromEntries(
            Object.entries(qState.displayAnswers).filter(
              (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
            ),
          )
        : {},
  };
}

function normalizeStudioSession(session: StudioSessionState | null): StudioSessionState | null {
  if (!session || typeof session !== "object") return null;

  const normalizedProjectId =
    typeof session.projectId === "string" && session.projectId.trim()
      ? session.projectId.trim()
      : undefined;
  const resolvedAutomationMode = sessionHasFullAutoLineage(session)
    ? "full-auto"
    : normalizeAutomationMode(session.automationMode ?? session.currentProjectSnapshot?.automationMode);
  const normalizedProjectSnapshot = normalizeConsistentProjectSnapshot(
    session.currentProjectSnapshot ?? null,
    normalizedProjectId,
    resolvedAutomationMode,
  );
  const reconciledChoiceQuestions = reconcileStoredChoiceQuestions(
    normalizeStoredComposerQuestion(session.pendingChoiceQuestion),
    normalizeStoredComposerQuestion(session.interruptedChoiceQuestion),
  );

  return {
    sessionId: typeof session.sessionId === "string" ? session.sessionId : undefined,
    compactedMessageCount:
      typeof session.compactedMessageCount === "number" && Number.isFinite(session.compactedMessageCount)
        ? Math.max(0, session.compactedMessageCount)
        : 0,
    mode:
      session.mode === "idle" ||
      session.mode === "active" ||
      session.mode === "recovering" ||
      session.mode === "maintenance-review"
        ? session.mode
        : "idle",
    creationMode: normalizeCreationMode(session.creationMode, session.agentControlMode),
    automationMode: resolvedAutomationMode,
    devMode: normalizeDevMode(session.devMode, session.agentControlMode),
    suppressHistoricalMemory: normalizeSuppressHistoricalMemory(
      session.suppressHistoricalMemory,
      normalizedProjectSnapshot,
    ),
    messages: Array.isArray(session.messages)
      ? session.messages.map((message): HomeAgentMessage => {
          const row = message as HomeAgentMessage;
          const feedback = row.feedback === "up" || row.feedback === "down" ? row.feedback : undefined;
          return {
            ...row,
            feedback,
            artifactSnapshots: normalizeArtifactSnapshots(row.artifactSnapshots),
            attachments: Array.isArray(row.attachments)
              ? row.attachments
                  .map((attachment) => normalizeAttachment(attachment))
                  .filter((attachment): attachment is ChatAttachment => Boolean(attachment))
              : undefined,
          };
        })
      : [],
    currentProjectSnapshot: normalizedProjectSnapshot,
    recentMessageSummary:
      typeof session.recentMessageSummary === "string" ? session.recentMessageSummary : "",
    projectId: normalizedProjectId,
    ...(typeof session.selectedTextModelKey === "string" && session.selectedTextModelKey.trim()
      ? { selectedTextModelKey: session.selectedTextModelKey.trim() }
      : {}),
    ...(typeof session.selectedImageModelFamily === "string" && session.selectedImageModelFamily.trim()
      ? { selectedImageModelFamily: normalizeHomeAgentImageModelFamilyKey(session.selectedImageModelFamily) }
      : {}),
    imageGenerationPrefs: normalizeVideoImageGenerationPrefs(session.imageGenerationPrefs),
    ...(typeof session.selectedVideoModelKey === "string" && session.selectedVideoModelKey.trim()
      ? { selectedVideoModelKey: normalizeHomeAgentVideoModelKey(session.selectedVideoModelKey) }
      : {}),
    videoGenerationPrefs: normalizeVideoGenerationPrefs(session.videoGenerationPrefs),
    draft: typeof session.draft === "string" ? session.draft : "",
    qState: normalizeQuestionState(session.qState, true),
    deferredQuestionState: normalizeQuestionState(session.deferredQuestionState, true),
    pendingWorkflowUploadKind:
      session.pendingWorkflowUploadKind === "adaptation" || session.pendingWorkflowUploadKind === "video"
        ? session.pendingWorkflowUploadKind
        : null,
    pendingChoiceQuestion: reconciledChoiceQuestions.pendingChoiceQuestion,
    interruptedChoiceQuestion: reconciledChoiceQuestions.interruptedChoiceQuestion,
    selectedValues: Array.isArray(session.selectedValues)
      ? session.selectedValues.filter((value): value is string => typeof value === "string")
      : [],
    deferredSelectedValues: Array.isArray(session.deferredSelectedValues)
      ? session.deferredSelectedValues.filter((value): value is string => typeof value === "string")
      : [],
    deferredDraft: typeof session.deferredDraft === "string" ? session.deferredDraft : "",
    surfacedTaskIds: Array.isArray(session.surfacedTaskIds)
      ? session.surfacedTaskIds.filter((value): value is string => typeof value === "string")
      : [],
    surfacedTaskFollowupKeys: Array.isArray(session.surfacedTaskFollowupKeys)
      ? session.surfacedTaskFollowupKeys.filter((value): value is string => typeof value === "string")
      : [],
    surfacedProjectSuggestionKeys: Array.isArray(session.surfacedProjectSuggestionKeys)
      ? session.surfacedProjectSuggestionKeys.filter((value): value is string => typeof value === "string")
      : [],
    fullAutoRun: session.fullAutoRun ?? null,
    fullAutoChecklistCollapsed: normalizeFullAutoChecklistCollapsed(session.fullAutoChecklistCollapsed),
  };
}

const BOOTSTRAP_MESSAGE_COUNT = 12;
const BOOTSTRAP_MESSAGE_CHARS = 900;
const EMERGENCY_BOOTSTRAP_MESSAGE_COUNT = 4;
const EMERGENCY_BOOTSTRAP_MESSAGE_CHARS = 280;
const EMERGENCY_BOOTSTRAP_ARTIFACT_COUNT = 1;

function normalizeStudioSessionForBootstrap(session: StudioSessionState | null): StudioSessionState | null {
  if (!session || typeof session !== "object") return null;

  const normalizedProjectId =
    typeof session.projectId === "string" && session.projectId.trim()
      ? session.projectId.trim()
      : undefined;
  const resolvedAutomationMode = sessionHasFullAutoLineage(session)
    ? "full-auto"
    : normalizeAutomationMode(session.automationMode ?? session.currentProjectSnapshot?.automationMode);
  const normalizedProjectSnapshot = normalizeConsistentProjectSnapshot(
    session.currentProjectSnapshot ?? null,
    normalizedProjectId,
    resolvedAutomationMode,
  );
  const rawMessages = Array.isArray(session.messages) ? session.messages : [];
  const bootMessages = rawMessages.slice(-BOOTSTRAP_MESSAGE_COUNT);
  const hiddenMessageCount = Math.max(0, rawMessages.length - bootMessages.length);
  const reconciledChoiceQuestions = reconcileStoredChoiceQuestions(
    normalizeStoredComposerQuestion(session.pendingChoiceQuestion),
    normalizeStoredComposerQuestion(session.interruptedChoiceQuestion),
  );

  return {
    sessionId: typeof session.sessionId === "string" ? session.sessionId : undefined,
    compactedMessageCount:
      (typeof session.compactedMessageCount === "number" && Number.isFinite(session.compactedMessageCount)
        ? Math.max(0, session.compactedMessageCount)
        : 0) + hiddenMessageCount,
    mode:
      session.mode === "idle" ||
      session.mode === "active" ||
      session.mode === "recovering" ||
      session.mode === "maintenance-review"
        ? session.mode
        : "idle",
    creationMode: normalizeCreationMode(session.creationMode, session.agentControlMode),
    automationMode: resolvedAutomationMode,
    devMode: normalizeDevMode(session.devMode, session.agentControlMode),
    suppressHistoricalMemory: normalizeSuppressHistoricalMemory(
      session.suppressHistoricalMemory,
      normalizedProjectSnapshot,
    ),
    messages: bootMessages.map((message): HomeAgentMessage => {
      const row = message as HomeAgentMessage;
      const feedback = row.feedback === "up" || row.feedback === "down" ? row.feedback : undefined;
      return {
        ...row,
        content: compactMessageContent(row.content, BOOTSTRAP_MESSAGE_CHARS),
        feedback,
        artifactSnapshots: normalizeArtifactSnapshots(row.artifactSnapshots),
        attachments: Array.isArray(row.attachments)
          ? row.attachments
              .map((attachment) => normalizeAttachment(attachment))
              .filter((attachment): attachment is ChatAttachment => Boolean(attachment))
              .slice(0, 4)
              .map((attachment) => stripAttachmentPayloadForHistory(attachment))
          : undefined,
      };
    }),
    currentProjectSnapshot: compactProjectSnapshotForStorage(normalizedProjectSnapshot, "minimal"),
    recentMessageSummary: truncateText(
      typeof session.recentMessageSummary === "string" ? session.recentMessageSummary : "",
      1200,
    ),
    projectId: normalizedProjectId,
    ...(typeof session.selectedTextModelKey === "string" && session.selectedTextModelKey.trim()
      ? { selectedTextModelKey: session.selectedTextModelKey.trim() }
      : {}),
    ...(typeof session.selectedImageModelFamily === "string" && session.selectedImageModelFamily.trim()
      ? { selectedImageModelFamily: normalizeHomeAgentImageModelFamilyKey(session.selectedImageModelFamily) }
      : {}),
    imageGenerationPrefs: normalizeVideoImageGenerationPrefs(session.imageGenerationPrefs),
    ...(typeof session.selectedVideoModelKey === "string" && session.selectedVideoModelKey.trim()
      ? { selectedVideoModelKey: normalizeHomeAgentVideoModelKey(session.selectedVideoModelKey) }
      : {}),
    videoGenerationPrefs: normalizeVideoGenerationPrefs(session.videoGenerationPrefs),
    draft: typeof session.draft === "string" ? session.draft : "",
    qState: normalizeQuestionState(session.qState, true),
    deferredQuestionState: normalizeQuestionState(session.deferredQuestionState, true),
    pendingWorkflowUploadKind:
      session.pendingWorkflowUploadKind === "adaptation" || session.pendingWorkflowUploadKind === "video"
        ? session.pendingWorkflowUploadKind
        : null,
    pendingChoiceQuestion: reconciledChoiceQuestions.pendingChoiceQuestion,
    interruptedChoiceQuestion: reconciledChoiceQuestions.interruptedChoiceQuestion,
    selectedValues: Array.isArray(session.selectedValues)
      ? session.selectedValues.filter((value): value is string => typeof value === "string")
      : [],
    deferredSelectedValues: Array.isArray(session.deferredSelectedValues)
      ? session.deferredSelectedValues.filter((value): value is string => typeof value === "string")
      : [],
    deferredDraft: typeof session.deferredDraft === "string" ? session.deferredDraft : "",
    surfacedTaskIds: Array.isArray(session.surfacedTaskIds)
      ? session.surfacedTaskIds.filter((value): value is string => typeof value === "string")
      : [],
    surfacedTaskFollowupKeys: Array.isArray(session.surfacedTaskFollowupKeys)
      ? session.surfacedTaskFollowupKeys.filter((value): value is string => typeof value === "string")
      : [],
    surfacedProjectSuggestionKeys: Array.isArray(session.surfacedProjectSuggestionKeys)
      ? session.surfacedProjectSuggestionKeys.filter((value): value is string => typeof value === "string")
      : [],
    fullAutoRun: session.fullAutoRun ?? null,
    fullAutoChecklistCollapsed: normalizeFullAutoChecklistCollapsed(session.fullAutoChecklistCollapsed),
  };
}

function buildStudioSessionBootstrapCache(
  session: StudioSessionState | null | undefined,
): StudioSessionBootstrapCache | null {
  if (!session || typeof session !== "object") return null;
  const bootstrapSession = normalizeStudioSessionForBootstrap(session);
  if (!bootstrapSession) return null;

  return {
    version: 1,
    session: bootstrapSession,
    rawMessageCount: Array.isArray(session.messages) ? session.messages.length : 0,
    rawArtifactCount: Array.isArray(session.currentProjectSnapshot?.artifacts)
      ? session.currentProjectSnapshot.artifacts.length
      : 0,
    rawAssetManifestCount: Array.isArray(session.currentProjectSnapshot?.memory?.assetManifest?.items)
      ? session.currentProjectSnapshot.memory.assetManifest.items.length
      : 0,
  };
}

function buildEmergencyStudioSessionBootstrapCache(
  session: StudioSessionState | null | undefined,
): StudioSessionBootstrapCache | null {
  const payload = buildStudioSessionBootstrapCache(session);
  if (!payload?.session) return payload;

  const emergencyMessages = payload.session.messages
    .slice(-EMERGENCY_BOOTSTRAP_MESSAGE_COUNT)
    .map((message) => ({
      ...message,
      content: truncateText(message.content, EMERGENCY_BOOTSTRAP_MESSAGE_CHARS),
      attachments: Array.isArray(message.attachments) ? message.attachments.slice(0, 1) : undefined,
    }));

  return {
    ...payload,
    session: {
      ...payload.session,
      messages: emergencyMessages,
      draft: truncateText(payload.session.draft, 160),
      deferredDraft: truncateText(payload.session.deferredDraft, 120),
      recentMessageSummary: truncateText(payload.session.recentMessageSummary, 240),
      selectedValues: trimStringArray(payload.session.selectedValues, 4, 80),
      deferredSelectedValues: trimStringArray(payload.session.deferredSelectedValues, 4, 80),
      surfacedTaskIds: trimStringArray(payload.session.surfacedTaskIds, 12, 80),
      surfacedTaskFollowupKeys: trimStringArray(payload.session.surfacedTaskFollowupKeys, 12, 80),
      surfacedProjectSuggestionKeys: trimStringArray(payload.session.surfacedProjectSuggestionKeys, 12, 120),
      currentProjectSnapshot: payload.session.currentProjectSnapshot
        ? {
            ...payload.session.currentProjectSnapshot,
            recommendedActions: trimStringArray(payload.session.currentProjectSnapshot.recommendedActions, 3, 80),
            artifacts: payload.session.currentProjectSnapshot.artifacts.slice(0, EMERGENCY_BOOTSTRAP_ARTIFACT_COUNT),
          }
        : payload.session.currentProjectSnapshot,
    },
  };
}

function buildStudioSessionBootstrapResult(
  session: StudioSessionState | null,
  rawMessageCount: number,
  rawArtifactCount: number,
  rawAssetManifestCount: number,
): {
  session: StudioSessionState | null;
  needsHydration: boolean;
} {
  if (!session) {
    return { session: null, needsHydration: false };
  }

  const bootstrapArtifactCount = session.currentProjectSnapshot?.artifacts.length ?? 0;
  const bootstrapAssetManifestCount = session.currentProjectSnapshot?.memory?.assetManifest?.items.length ?? 0;

  return {
    session,
    needsHydration:
      rawMessageCount > session.messages.length ||
      rawArtifactCount > bootstrapArtifactCount ||
      rawAssetManifestCount > bootstrapAssetManifestCount,
  };
}

function writeStudioSessionBootstrapCache(session: StudioSessionState | null | undefined): void {
  if (typeof window === "undefined") return;
  const payload = buildStudioSessionBootstrapCache(session);
  if (!payload) {
    localStorage.removeItem(STUDIO_SESSION_BOOTSTRAP_KEY);
    return;
  }

  try {
    safeWriteJson(STUDIO_SESSION_BOOTSTRAP_KEY, payload);
    return;
  } catch (error) {
    if (!isQuotaExceededError(error)) {
      return;
    }
  }

  try {
    localStorage.removeItem(STUDIO_SESSION_BOOTSTRAP_KEY);
  } catch {
    // Ignore cleanup failures and fall through to the emergency retry.
  }

  const emergencyPayload = buildEmergencyStudioSessionBootstrapCache(session);
  if (!emergencyPayload) return;

  try {
    safeWriteJson(STUDIO_SESSION_BOOTSTRAP_KEY, emergencyPayload);
  } catch {
    try {
      localStorage.removeItem(STUDIO_SESSION_BOOTSTRAP_KEY);
    } catch {
      // Ignore cleanup failures. The full session/file backup path still remains available.
    }
  }
}

function assetManifestLimit(
  level: StorageLevel,
): { count: number; labelChars: number; metaChars: number; summaryChars: number } {
  switch (level) {
    case "compact":
      return { count: 12, labelChars: 64, metaChars: 100, summaryChars: 160 };
    case "minimal":
      return { count: 6, labelChars: 56, metaChars: 80, summaryChars: 120 };
    default:
      return { count: 32, labelChars: 80, metaChars: 140, summaryChars: 220 };
  }
}

function compactAssetManifestForStorage(
  manifest: ProductionAssetManifest | null | undefined,
  level: StorageLevel,
): ProductionAssetManifest | null {
  if (!manifest?.items?.length) return null;

  const limits = assetManifestLimit(level);
  const items = manifest.items
    .filter((item): item is NonNullable<ProductionAssetManifest["items"]>[number] => Boolean(item))
    .slice(-limits.count)
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      label: truncateText(item.label, limits.labelChars) || "素材",
      url: truncateText(item.url, 600),
      meta: truncateText(item.meta, limits.metaChars) || undefined,
      reusable: !!item.reusable,
      status: item.status,
      source: truncateText(item.source, 48) || undefined,
      origin: item.origin,
      sourceEntityId: truncateText(item.sourceEntityId, 80) || undefined,
      version: typeof item.version === "number" && Number.isFinite(item.version) ? item.version : undefined,
    }));

  if (!items.length) return null;

  return {
    version: truncateText(manifest.version, 24) || undefined,
    summary: truncateText(manifest.summary, limits.summaryChars) || undefined,
    updatedAt: truncateText(manifest.updatedAt, 40) || undefined,
    items,
  };
}

function readStudioSessionBootstrapCache(): {
  session: StudioSessionState | null;
  needsHydration: boolean;
} | null {
  const cached = safeReadJson<StudioSessionBootstrapCache | null>(STUDIO_SESSION_BOOTSTRAP_KEY, null);
  if (!cached || typeof cached !== "object") return null;

  const session = normalizeStudioSessionForBootstrap(cached.session ?? null);
  if (shouldIgnoreDeletedProjectSession(normalizeStudioSession(session))) {
    if (typeof window !== "undefined") {
      localStorage.removeItem(STUDIO_SESSION_BOOTSTRAP_KEY);
    }
    return { session: null, needsHydration: false };
  }
  if (!session) return null;

  return buildStudioSessionBootstrapResult(
    session,
    typeof cached.rawMessageCount === "number" && Number.isFinite(cached.rawMessageCount)
      ? Math.max(0, cached.rawMessageCount)
      : session.messages.length,
    typeof cached.rawArtifactCount === "number" && Number.isFinite(cached.rawArtifactCount)
      ? Math.max(0, cached.rawArtifactCount)
      : session.currentProjectSnapshot?.artifacts.length ?? 0,
    typeof cached.rawAssetManifestCount === "number" && Number.isFinite(cached.rawAssetManifestCount)
      ? Math.max(0, cached.rawAssetManifestCount)
      : session.currentProjectSnapshot?.memory?.assetManifest?.items.length ?? 0,
  );
}

function orderProjectSessions(
  sessions: Record<string, StudioSessionState>,
  activeProjectId: string,
): Array<[string, StudioSessionState]> {
  const entries = Object.entries(sessions).filter((entry) => entry[1]);
  const active = entries.find(([projectId]) => projectId === activeProjectId);
  const remaining = entries.filter(([projectId]) => projectId !== activeProjectId);
  return active ? [active, ...remaining] : entries;
}

function readProjectSessionMap(): Record<string, StudioSessionState> {
  if (sessionMapCache) return sessionMapCache;

  const raw = safeReadJson<Record<string, StudioSessionState | null>>(
    STUDIO_PROJECT_SESSIONS_KEY,
    {},
  );

  sessionMapCache = Object.entries(raw).reduce<Record<string, StudioSessionState>>((accumulator, entry) => {
    const [projectId, session] = entry;
    const normalized = normalizeStudioSession(session);
    if (hasSessionResetMarker(projectId) || shouldIgnoreDeletedProjectSession(normalized)) {
      return accumulator;
    }
    if (normalized) accumulator[projectId] = normalized;
    return accumulator;
  }, {});

  return sessionMapCache;
}

function cacheStudioSession(normalized: StudioSessionState): void {
  const cachedSession = normalizeStudioSession(compactSessionForStorage(normalized, "standard")) ?? normalized;
  activeSessionCache = cachedSession;

  if (!cachedSession.projectId) return;

  const sessions = readProjectSessionMap();
  sessions[cachedSession.projectId] = cachedSession;
}

export function readStudioSession(): StudioSessionState | null {
  if (activeSessionCache !== undefined) return activeSessionCache;

  activeSessionCache = normalizeStudioSession(safeReadJson<StudioSessionState | null>(STUDIO_SESSION_KEY, null));
  if (shouldIgnoreDeletedProjectSession(activeSessionCache)) {
    activeSessionCache = null;
    if (typeof window !== "undefined") {
      localStorage.removeItem(STUDIO_SESSION_KEY);
    }
  }
  return activeSessionCache;
}

export function readStudioSessionBootstrap(): {
  session: StudioSessionState | null;
  needsHydration: boolean;
} {
  const cached = readStudioSessionBootstrapCache();
  if (cached) return cached;

  const raw = safeReadJson<StudioSessionState | null>(STUDIO_SESSION_KEY, null);
  if (shouldIgnoreDeletedProjectSession(normalizeStudioSession(raw))) {
    if (typeof window !== "undefined") {
      localStorage.removeItem(STUDIO_SESSION_KEY);
      localStorage.removeItem(STUDIO_SESSION_BOOTSTRAP_KEY);
    }
    return { session: null, needsHydration: false };
  }
  const session = normalizeStudioSessionForBootstrap(raw);
  const result = buildStudioSessionBootstrapResult(
    session,
    Array.isArray(raw?.messages) ? raw.messages.length : 0,
    Array.isArray(raw?.currentProjectSnapshot?.artifacts) ? raw.currentProjectSnapshot.artifacts.length : 0,
    Array.isArray(raw?.currentProjectSnapshot?.memory?.assetManifest?.items)
      ? raw.currentProjectSnapshot.memory.assetManifest.items.length
      : 0,
  );
  writeStudioSessionBootstrapCache(raw);
  return result;
}

export function writeStudioSession(
  session: StudioSessionState,
  options?: { persistFullBackup?: boolean },
): void {
  const normalized = normalizeStudioSession(session);
  if (!normalized) return;
  if (hasSessionResetMarker(normalized.projectId)) return;
  cacheStudioSession(normalized);

  tryWriteJson(STUDIO_SESSION_KEY, (level) => compactSessionForStorage(normalized, level));
  writeStudioSessionBootstrapCache(normalized);

  if (!normalized.projectId) return;

  // 新会话写入时清除 reset 标记，解除对该项目文件系统恢复的封锁
  const sessions = readProjectSessionMap();
  sessions[normalized.projectId] = normalized;
  const orderedSessions = orderProjectSessions(sessions, normalized.projectId);

  tryWriteJson(STUDIO_PROJECT_SESSIONS_KEY, (level) =>
    Object.fromEntries(
      orderedSessions
        .slice(0, PROJECT_SESSION_ENTRY_LIMITS[level])
        .map(([projectId, projectSession]) => [projectId, compactSessionForStorage(projectSession, level)]),
    ),
  );

  // 异步写入文件系统（完整保存，无截断，作为持久化备份）
  if (options?.persistFullBackup === false) return;
  void writeFullSessionBackup(normalized, { copyLegacyProjectMedia: true });
}

export function queueStudioSessionWrite(
  session: StudioSessionState,
  delay = 120,
  options?: { persistFullBackup?: boolean },
): void {
  const normalized = normalizeStudioSession(session);
  if (!normalized) return;
  if (hasSessionResetMarker(normalized.projectId)) return;

  queuedFullSessionCache = normalized;
  queuedPersistNeedsFullBackup =
    queuedPersistNeedsFullBackup || options?.persistFullBackup !== false;
  cacheStudioSession(normalized);
  scheduleQueuedSessionPersistence(delay);
}

export function clearStudioSession(): void {
  if (typeof window === "undefined") return;
  clearQueuedPersistHandle();
  activeSessionCache = null;
  queuedFullSessionCache = null;
  queuedPersistNeedsFullBackup = false;
  localStorage.removeItem(STUDIO_SESSION_KEY);
  localStorage.removeItem(STUDIO_SESSION_BOOTSTRAP_KEY);
}

export function __resetSessionStoreCachesForTests(): void {
  clearQueuedPersistHandle();
  activeSessionCache = undefined;
  sessionMapCache = null;
  queuedFullSessionCache = null;
  queuedPersistNeedsFullBackup = false;
  cachedSessionsDir = undefined;
  invalidateConversationArchiveScanCache();
}

/** 仅写入指定项目的会话（不覆盖当前活跃会话 key），用于后台复制等场景。 */
export async function writeProjectStudioSession(session: StudioSessionState): Promise<void> {
  const normalized = normalizeStudioSession(session);
  if (!normalized?.projectId) return;
  if (hasSessionResetMarker(normalized.projectId)) return;

  const sessions = readProjectSessionMap();
  sessions[normalized.projectId] = normalized;
  const orderedSessions = orderProjectSessions(sessions, normalized.projectId);

  tryWriteJson(STUDIO_PROJECT_SESSIONS_KEY, (level) =>
    Object.fromEntries(
      orderedSessions
        .slice(0, PROJECT_SESSION_ENTRY_LIMITS[level])
        .map(([projectId, projectSession]) => [projectId, compactSessionForStorage(projectSession, level)]),
    ),
  );

  // 写入文件系统（完整保存，无截断），await 确保复制后立即可读
  await writeFullSessionBackup(normalized, { copyLegacyProjectMedia: true });
}

/** Drop persisted home-agent session for one project (e.g. after user deletes history). */
export function removeProjectStudioSession(projectId: string): void {
  if (typeof window === "undefined") return;
  if (queuedFullSessionCache?.projectId === projectId) {
    queuedFullSessionCache = null;
    clearQueuedPersistHandle();
  }
  const sessions = readProjectSessionMap();
  delete sessions[projectId];
  const activeProjectId = getSessionProjectId(activeSessionCache ?? readStudioSession());
  if (activeProjectId === projectId) {
    activeSessionCache = null;
    localStorage.removeItem(STUDIO_SESSION_KEY);
    localStorage.removeItem(STUDIO_SESSION_BOOTSTRAP_KEY);
  }
  const ordered = orderProjectSessions(sessions, "");
  tryWriteJson(STUDIO_PROJECT_SESSIONS_KEY, (level) =>
    Object.fromEntries(
      ordered
        .slice(0, PROJECT_SESSION_ENTRY_LIMITS[level])
        .map(([id, session]) => [id, compactSessionForStorage(session, level)]),
    ),
  );
  // 同步标记：防止文件系统恢复时把已删除的会话重新写回（兜底时序问题）
  const markers = readSessionResetMarkerSet();
  markers.add(projectId);
  writeSessionResetMarkerSet(markers);
  // 异步清除文件系统备份，防止刷新后通过 _last.json 恢复
  void deleteSessionFile(projectId);
}

/** 读取最近一次被主动清除的 projectId（用于阻止文件系统恢复）。 */
export function readSessionResetMarker(): string | null {
  const markers = [...readSessionResetMarkerSet()];
  return markers.at(-1) ?? null;
}

export function readSessionResetMarkers(): string[] {
  return [...readSessionResetMarkerSet()];
}

export function hasSessionResetMarkerForProject(projectId: string | null | undefined): boolean {
  return hasSessionResetMarker(projectId);
}

async function deleteSessionFile(projectId: string): Promise<void> {
  await deleteConversationArchive(projectId);
  const dir = await getSessionsDbDir();
  if (!dir || !window.electronAPI?.storage) return;
  try {
    if (window.electronAPI.storage.deleteFile) {
      await window.electronAPI.storage.deleteFile(`${dir}/${projectId}.json`);
    } else if (window.electronAPI.storage.writeText) {
      await window.electronAPI.storage.writeText(`${dir}/${projectId}.json`, "null");
    }
    // 若 _last.json 属于同一项目，一并清除，防止刷新后通过文件系统恢复
    const lastResult = await window.electronAPI.storage.readText(`${dir}/_last.json`);
    if (lastResult.ok && lastResult.exists && lastResult.content) {
      try {
        const lastSession = JSON.parse(lastResult.content) as { projectId?: string } | null;
        if (lastSession?.projectId === projectId) {
          if (window.electronAPI.storage.deleteFile) {
            await window.electronAPI.storage.deleteFile(`${dir}/_last.json`);
          } else if (window.electronAPI.storage.writeText) {
            await window.electronAPI.storage.writeText(`${dir}/_last.json`, "null");
          }
        }
      } catch {
        // 解析失败则直接清除
        if (window.electronAPI.storage.deleteFile) {
          await window.electronAPI.storage.deleteFile(`${dir}/_last.json`);
        } else if (window.electronAPI.storage.writeText) {
          await window.electronAPI.storage.writeText(`${dir}/_last.json`, "null");
        }
      }
    }
  } catch {
    // 忽略写入错误
  }
}

export function readProjectStudioSession(projectId: string): StudioSessionState | null {
  const sessions = readProjectSessionMap();
  return sessions[projectId] ?? null;
}

export { readProjectStudioSession as readStudioProjectSession };

export function listStudioProjectSessions(): StudioSessionState[] {
  return Object.values(readProjectSessionMap());
}

// ======================== 文件系统持久化（Electron 专用）========================
// 作为 localStorage 的备份层，解决配额超出导致历史记录丢失的问题

let cachedSessionsDir: string | null | undefined = undefined;

async function getSessionsDbDir(): Promise<string | null> {
  if (cachedSessionsDir !== undefined) return cachedSessionsDir;
  if (typeof window === "undefined" || !window.electronAPI?.storage?.getDefaultPath) {
    cachedSessionsDir = null;
    return null;
  }
  try {
    const paths = await window.electronAPI.storage.getDefaultPath();
    cachedSessionsDir = `${paths.db}/sessions`;
    return cachedSessionsDir;
  } catch {
    cachedSessionsDir = null;
    return null;
  }
}

async function writeFullSessionBackup(
  session: StudioSessionState,
  options?: { copyLegacyProjectMedia?: boolean },
): Promise<void> {
  const sanitizedSession = normalizeStudioSession(session) ?? session;
  try {
    await writeConversationArchiveFull(sanitizedSession, undefined, {
      copyLegacyProjectMedia: options?.copyLegacyProjectMedia === true,
    });
  } catch {
    // Keep legacy backup as a fallback if the archive layer is unavailable.
  }
  await writeSessionToFile(sanitizedSession);
}

async function writeSessionToFile(session: StudioSessionState): Promise<void> {
  if (!session.projectId) return;
  const dir = await getSessionsDbDir();
  if (!dir || !window.electronAPI?.storage?.writeText) return;
  try {
    const content = JSON.stringify(normalizeStudioSession(session) ?? session);
    await window.electronAPI.storage.writeText(`${dir}/${session.projectId}.json`, content);
    await window.electronAPI.storage.writeText(`${dir}/_last.json`, content);
  } catch {
    // 忽略文件写入错误
  }
}

/** 从文件系统读取指定项目的会话（用于 localStorage 为空时的恢复） */
export async function readProjectSessionFromFile(projectId: string): Promise<StudioSessionState | null> {
  if (hasSessionResetMarker(projectId)) return null;
  const archive = await readConversationArchiveFull(projectId);
  const archiveSession = normalizeStudioSession(archive?.session ?? null);
  if (archiveSession && !shouldIgnoreDeletedProjectSession(archiveSession)) {
    if (
      sessionHasInlinePreviewPayload(archive?.session ?? null) ||
      normalizedSessionNeedsRewrite(archive?.session ?? null, archiveSession)
    ) {
      void writeFullSessionBackup(archiveSession, { copyLegacyProjectMedia: false });
    }
    return archiveSession;
  }

  const dir = await getSessionsDbDir();
  if (!dir || !window.electronAPI?.storage?.readText) return null;
  try {
    const result = await window.electronAPI.storage.readText(`${dir}/${projectId}.json`);
    if (!result.ok || !result.exists || !result.content) return null;
    const rawSession = JSON.parse(result.content) as StudioSessionState | null;
    const session = normalizeStudioSession(rawSession);
    if (session) {
      // A db-backed session without an archive should be re-materialized into
      // files/conversations so sidebar history and on-disk conversation backups stay aligned.
      void writeFullSessionBackup(session, { copyLegacyProjectMedia: false });
    }
    return shouldIgnoreDeletedProjectSession(session) ? null : session;
  } catch {
    return null;
  }
}

/** 从文件系统读取最后一次活跃的会话（用于应用重启后恢复） */
export async function readLastSessionFromFile(): Promise<StudioSessionState | null> {
  const archiveSession = normalizeStudioSession(await readLatestConversationArchiveSession());
  if (archiveSession && !shouldIgnoreDeletedProjectSession(archiveSession)) return archiveSession;

  const dir = await getSessionsDbDir();
  if (!dir || !window.electronAPI?.storage?.readText) return null;
  try {
    const result = await window.electronAPI.storage.readText(`${dir}/_last.json`);
    if (!result.ok || !result.exists || !result.content) return null;
    const rawSession = JSON.parse(result.content) as StudioSessionState | null;
    const session = normalizeStudioSession(rawSession);
    if (session && (sessionHasInlinePreviewPayload(rawSession) || normalizedSessionNeedsRewrite(rawSession, session))) {
      void writeFullSessionBackup(session, { copyLegacyProjectMedia: false });
    }
    return shouldIgnoreDeletedProjectSession(session) ? null : session;
  } catch {
    return null;
  }
}
