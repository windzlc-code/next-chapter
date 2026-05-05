import {
  stripAttachmentPayloadForHistory,
  type ChatAttachment,
} from "@/lib/agent/chat-attachments";
import type { AgentControlMode, CreationMode, HomeAgentMessage, StudioSessionState } from "./types";
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

const STUDIO_SESSION_KEY = "storyforge-home-agent-session-v1";
const STUDIO_PROJECT_SESSIONS_KEY = "storyforge-home-agent-project-sessions-v1";
// 记录最近一次被主动清除的 projectId，防止文件系统恢复时把已删除的会话重新写回
const STUDIO_SESSION_RESET_MARKER_KEY = "storyforge-session-reset-marker-v1";

// session map 内存缓存，避免每次切换项目都重新解析整个 localStorage JSON
let sessionMapCache: Record<string, StudioSessionState> | null = null;
let activeSessionCache: StudioSessionState | null | undefined = undefined;
let queuedFullSessionCache: StudioSessionState | null = null;
let queuedPersistHandle: number | null = null;
const STORAGE_LEVELS = ["standard", "compact", "minimal"] as const;
const PROJECT_SESSION_ENTRY_LIMITS = {
  standard: 20,
  compact: 10,
  minimal: 5,
} as const;

type StorageLevel = (typeof STORAGE_LEVELS)[number];

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

function hasSessionResetMarker(projectId: string | null | undefined): boolean {
  if (typeof window === "undefined" || !projectId) return false;
  return localStorage.getItem(STUDIO_SESSION_RESET_MARKER_KEY) === projectId;
}

function truncateText(value: string | undefined, max: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.length > max ? `${trimmed.slice(0, Math.max(0, max - 1))}…` : trimmed;
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
    previewUrl: typeof record.previewUrl === "string" ? record.previewUrl : undefined,
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
            previewUrl: typeof entry.previewUrl === "string" ? entry.previewUrl : undefined,
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
    return;
  }

  if (activeSessionCache) {
    tryWriteJson(STUDIO_SESSION_KEY, (level) => compactSessionForStorage(activeSessionCache, level));
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
  queuedFullSessionCache = null;
  persistActiveSessionCache();
  persistProjectSessionCache();
  if (fullSession?.projectId) {
    // Keep the full archive in sync without copying large media folders on debounced saves.
    void writeFullSessionBackup(fullSession, { copyLegacyProjectMedia: false });
  }
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
      return { count: 50, chars: 1200 };
    case "minimal":
      return { count: 20, chars: 600 };
    default:
      return { count: 100, chars: 3200 };
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

function compactProjectSnapshotForStorage(
  snapshot: StudioSessionState["currentProjectSnapshot"],
  level: StorageLevel,
): StudioSessionState["currentProjectSnapshot"] {
  if (!snapshot) return null;

  const limits = artifactLimit(level);

  return {
    projectId: snapshot.projectId,
    projectKind: snapshot.projectKind,
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
    messages: session.messages.slice(-limits.count).map((message) => ({
      ...message,
      content: truncateText(message.content, limits.chars),
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
    pendingChoiceQuestion: compactComposerQuestionForStorage(session.pendingChoiceQuestion, level),
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
    automationMode: normalizeAutomationMode(session.automationMode ?? session.currentProjectSnapshot?.automationMode),
    devMode: normalizeDevMode(session.devMode, session.agentControlMode),
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
    currentProjectSnapshot: session.currentProjectSnapshot
      ? {
          ...session.currentProjectSnapshot,
          automationMode: normalizeAutomationMode(
            session.currentProjectSnapshot.automationMode ?? session.automationMode,
          ),
        }
      : null,
    recentMessageSummary:
      typeof session.recentMessageSummary === "string" ? session.recentMessageSummary : "",
    projectId: typeof session.projectId === "string" ? session.projectId : undefined,
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
    pendingChoiceQuestion:
      session.pendingChoiceQuestion && typeof session.pendingChoiceQuestion === "object"
        ? session.pendingChoiceQuestion
        : null,
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
  };
}

const BOOTSTRAP_MESSAGE_COUNT = 12;
const BOOTSTRAP_MESSAGE_CHARS = 900;

function normalizeStudioSessionForBootstrap(session: StudioSessionState | null): StudioSessionState | null {
  if (!session || typeof session !== "object") return null;

  const rawMessages = Array.isArray(session.messages) ? session.messages : [];
  const bootMessages = rawMessages.slice(-BOOTSTRAP_MESSAGE_COUNT);
  const hiddenMessageCount = Math.max(0, rawMessages.length - bootMessages.length);

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
    automationMode: normalizeAutomationMode(session.automationMode ?? session.currentProjectSnapshot?.automationMode),
    devMode: normalizeDevMode(session.devMode, session.agentControlMode),
    messages: bootMessages.map((message): HomeAgentMessage => {
      const row = message as HomeAgentMessage;
      const feedback = row.feedback === "up" || row.feedback === "down" ? row.feedback : undefined;
      return {
        ...row,
        content: truncateText(row.content, BOOTSTRAP_MESSAGE_CHARS),
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
    currentProjectSnapshot: compactProjectSnapshotForStorage(session.currentProjectSnapshot ?? null, "minimal"),
    recentMessageSummary: truncateText(
      typeof session.recentMessageSummary === "string" ? session.recentMessageSummary : "",
      1200,
    ),
    projectId: typeof session.projectId === "string" ? session.projectId : undefined,
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
    pendingChoiceQuestion:
      session.pendingChoiceQuestion && typeof session.pendingChoiceQuestion === "object"
        ? session.pendingChoiceQuestion
        : null,
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
  };
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
    if (normalized) accumulator[projectId] = normalized;
    return accumulator;
  }, {});

  return sessionMapCache;
}

function cacheStudioSession(normalized: StudioSessionState): void {
  const cachedSession = normalizeStudioSession(compactSessionForStorage(normalized, "standard")) ?? normalized;
  activeSessionCache = cachedSession;

  if (!cachedSession.projectId) return;

  if (hasSessionResetMarker(cachedSession.projectId)) {
    localStorage.removeItem(STUDIO_SESSION_RESET_MARKER_KEY);
  }

  const sessions = readProjectSessionMap();
  sessions[cachedSession.projectId] = cachedSession;
}

export function readStudioSession(): StudioSessionState | null {
  if (activeSessionCache !== undefined) return activeSessionCache;

  activeSessionCache = normalizeStudioSession(safeReadJson<StudioSessionState | null>(STUDIO_SESSION_KEY, null));
  return activeSessionCache;
}

export function readStudioSessionBootstrap(): {
  session: StudioSessionState | null;
  needsHydration: boolean;
} {
  const raw = safeReadJson<StudioSessionState | null>(STUDIO_SESSION_KEY, null);
  const session = normalizeStudioSessionForBootstrap(raw);
  if (!session) {
    return { session: null, needsHydration: false };
  }

  const rawMessageCount = Array.isArray(raw?.messages) ? raw.messages.length : 0;
  const rawArtifactCount = Array.isArray(raw?.currentProjectSnapshot?.artifacts)
    ? raw.currentProjectSnapshot.artifacts.length
    : 0;
  const bootstrapArtifactCount = session.currentProjectSnapshot?.artifacts.length ?? 0;

  return {
    session,
    needsHydration:
      rawMessageCount > session.messages.length ||
      rawArtifactCount > bootstrapArtifactCount,
  };
}

export function writeStudioSession(session: StudioSessionState): void {
  const normalized = normalizeStudioSession(session);
  if (!normalized) return;
  if (hasSessionResetMarker(normalized.projectId)) return;
  cacheStudioSession(normalized);

  tryWriteJson(STUDIO_SESSION_KEY, (level) => compactSessionForStorage(normalized, level));

  if (!normalized.projectId) return;

  // 新会话写入时清除 reset 标记，解除对该项目文件系统恢复的封锁
  if (hasSessionResetMarker(normalized.projectId)) {
    localStorage.removeItem(STUDIO_SESSION_RESET_MARKER_KEY);
  }

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
  void writeFullSessionBackup(normalized, { copyLegacyProjectMedia: true });
}

export function queueStudioSessionWrite(session: StudioSessionState, delay = 120): void {
  const normalized = normalizeStudioSession(session);
  if (!normalized) return;
  if (hasSessionResetMarker(normalized.projectId)) return;

  queuedFullSessionCache = normalized;
  cacheStudioSession(normalized);
  scheduleQueuedSessionPersistence(delay);
}

export function clearStudioSession(): void {
  if (typeof window === "undefined") return;
  clearQueuedPersistHandle();
  activeSessionCache = null;
  queuedFullSessionCache = null;
  localStorage.removeItem(STUDIO_SESSION_KEY);
}

export function __resetSessionStoreCachesForTests(): void {
  clearQueuedPersistHandle();
  activeSessionCache = undefined;
  sessionMapCache = null;
  queuedFullSessionCache = null;
  cachedSessionsDir = undefined;
  invalidateConversationArchiveScanCache();
}

/** 仅写入指定项目的会话（不覆盖当前活跃会话 key），用于后台复制等场景。 */
export async function writeProjectStudioSession(session: StudioSessionState): Promise<void> {
  const normalized = normalizeStudioSession(session);
  if (!normalized?.projectId) return;

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
  if (activeSessionCache?.projectId === projectId) {
    activeSessionCache = null;
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
  localStorage.setItem(STUDIO_SESSION_RESET_MARKER_KEY, projectId);
  // 异步清除文件系统备份，防止刷新后通过 _last.json 恢复
  void deleteSessionFile(projectId);
}

/** 读取最近一次被主动清除的 projectId（用于阻止文件系统恢复）。 */
export function readSessionResetMarker(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(STUDIO_SESSION_RESET_MARKER_KEY);
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
  try {
    await writeConversationArchiveFull(session, undefined, {
      copyLegacyProjectMedia: options?.copyLegacyProjectMedia === true,
    });
  } catch {
    // Keep legacy backup as a fallback if the archive layer is unavailable.
  }
  await writeSessionToFile(session);
}

async function writeSessionToFile(session: StudioSessionState): Promise<void> {
  if (!session.projectId) return;
  const dir = await getSessionsDbDir();
  if (!dir || !window.electronAPI?.storage?.writeText) return;
  try {
    const content = JSON.stringify(session);
    await window.electronAPI.storage.writeText(`${dir}/${session.projectId}.json`, content);
    await window.electronAPI.storage.writeText(`${dir}/_last.json`, content);
  } catch {
    // 忽略文件写入错误
  }
}

/** 从文件系统读取指定项目的会话（用于 localStorage 为空时的恢复） */
export async function readProjectSessionFromFile(projectId: string): Promise<StudioSessionState | null> {
  const archive = await readConversationArchiveFull(projectId);
  const archiveSession = normalizeStudioSession(archive?.session ?? null);
  if (archiveSession) return archiveSession;

  const dir = await getSessionsDbDir();
  if (!dir || !window.electronAPI?.storage?.readText) return null;
  try {
    const result = await window.electronAPI.storage.readText(`${dir}/${projectId}.json`);
    if (!result.ok || !result.exists || !result.content) return null;
    return normalizeStudioSession(JSON.parse(result.content) as StudioSessionState | null);
  } catch {
    return null;
  }
}

/** 从文件系统读取最后一次活跃的会话（用于应用重启后恢复） */
export async function readLastSessionFromFile(): Promise<StudioSessionState | null> {
  const archiveSession = normalizeStudioSession(await readLatestConversationArchiveSession());
  if (archiveSession) return archiveSession;

  const dir = await getSessionsDbDir();
  if (!dir || !window.electronAPI?.storage?.readText) return null;
  try {
    const result = await window.electronAPI.storage.readText(`${dir}/_last.json`);
    if (!result.ok || !result.exists || !result.content) return null;
    return normalizeStudioSession(JSON.parse(result.content) as StudioSessionState | null);
  } catch {
    return null;
  }
}
