import type { AskUserQuestionRequest } from "@/lib/agent/tools/ask-user-question";
import { normalizeAutomationMode } from "@/lib/home-agent/automation-mode";
import { listStudioProjectSessions, readStudioSessionBootstrap } from "@/lib/home-agent/session-store";
import { isAdaptationUploadInstructionMessage } from "@/lib/home-agent/adaptation-workflow-kickoff";
import { isVideoWorkflowUploadInstructionMessage } from "@/lib/home-agent/video-workflow-kickoff";
import type {
  AutomationMode,
  ComposerQuestion,
  ConversationProjectSnapshot,
  PendingWorkflowUploadKind,
  StudioQuestionState,
  StudioRuntimeState,
  StudioSessionState,
} from "@/lib/home-agent/types";

const STUDIO_PROJECT_SESSIONS_STORAGE_KEY = "storyforge-home-agent-project-sessions-v1";

export function createInitialStudioSeed(): {
  session: StudioSessionState | null;
  runtime: StudioRuntimeState;
  needsSessionHydration: boolean;
} {
  const { session, needsHydration } = readStudioSessionBootstrap();
  const recentProjectSessions = listStudioProjectSessions();
  const recoveredFallbackSession =
    recentProjectSessions.find(
      (candidate) => hasSavedSessionContent(candidate) || Boolean(candidate.currentProjectSnapshot),
    ) ?? null;
  const seedSession =
    hasSavedSessionContent(session) || Boolean(session?.currentProjectSnapshot)
      ? session
      : recoveredFallbackSession;
  const seedNeedsHydration =
    seedSession === session
      ? needsHydration
      : Boolean(
          seedSession &&
            (
              (seedSession.compactedMessageCount ?? 0) > 0 ||
              seedSession.messages.length >= 100 ||
              (seedSession.currentProjectSnapshot?.artifacts.length ?? 0) >= 10
            ),
        );

  return {
    session: seedSession,
    runtime: {
      sessionId: seedSession?.sessionId ?? crypto.randomUUID(),
      suppressHistoricalMemory: true,
      currentProjectSnapshot: seedSession?.currentProjectSnapshot ?? null,
      currentDramaProject: null,
      currentVideoProject: null,
      currentSetupDraft: null,
      skillDrafts: [],
      maintenanceReports: [],
      recentProjects: [],
      recentProjectSessions,
      recentMessageSummary: seedSession?.recentMessageSummary ?? "",
      fullAutoRun: seedSession?.fullAutoRun ?? null,
    },
    needsSessionHydration: seedNeedsHydration,
  };
}

const trimProjectId = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

export function shouldKeepSessionProjectIdForBridgedVideo(params: {
  currentSessionProjectId?: string | null;
  snapshot?: Pick<
    ConversationProjectSnapshot,
    "projectId" | "projectKind" | "sourceProjectId"
  > | null;
}): boolean {
  const normalizedSessionProjectId = trimProjectId(params.currentSessionProjectId);
  const normalizedSnapshotProjectId = trimProjectId(params.snapshot?.projectId);
  const normalizedSourceProjectId = trimProjectId(params.snapshot?.sourceProjectId);
  return Boolean(
    normalizedSessionProjectId &&
      normalizedSnapshotProjectId &&
      params.snapshot?.projectKind === "video" &&
      normalizedSnapshotProjectId !== normalizedSessionProjectId &&
      normalizedSourceProjectId === normalizedSessionProjectId,
  );
}

export function resolveSessionProjectIdForSnapshot(params: {
  currentSessionProjectId?: string | null;
  snapshot?: Pick<
    ConversationProjectSnapshot,
    "projectId" | "projectKind" | "sourceProjectId"
  > | null;
  fallbackProjectId?: string | null;
}): string | null {
  const normalizedSessionProjectId = trimProjectId(params.currentSessionProjectId);
  if (
    shouldKeepSessionProjectIdForBridgedVideo({
      currentSessionProjectId: normalizedSessionProjectId,
      snapshot: params.snapshot,
    })
  ) {
    return normalizedSessionProjectId || null;
  }

  const normalizedSnapshotProjectId = trimProjectId(params.snapshot?.projectId);
  if (normalizedSnapshotProjectId) {
    return normalizedSnapshotProjectId;
  }

  const normalizedFallbackProjectId = trimProjectId(params.fallbackProjectId);
  if (normalizedFallbackProjectId) {
    return normalizedFallbackProjectId;
  }

  return normalizedSessionProjectId || null;
}

function collectHiddenBridgedVideoProjectIds(params: {
  recentProjects: ConversationProjectSnapshot[];
  recentProjectSessions?: Array<
    Pick<StudioSessionState, "projectId" | "currentProjectSnapshot">
  >;
  currentProjectSnapshot?: Pick<
    ConversationProjectSnapshot,
    "projectId" | "projectKind" | "sourceProjectId"
  > | null;
  currentSessionProjectId?: string | null;
}): Set<string> {
  const {
    recentProjects,
    recentProjectSessions = [],
    currentProjectSnapshot = null,
    currentSessionProjectId = null,
  } = params;
  const visibleProjectIds = new Set(
    recentProjects
      .map((project) => trimProjectId(project.projectId))
      .filter(Boolean),
  );
  const hiddenProjectIds = new Set<string>();

  const collectFromSnapshot = (
    sessionProjectId: string | null | undefined,
    snapshot:
      | Pick<ConversationProjectSnapshot, "projectId" | "projectKind" | "sourceProjectId">
      | null
      | undefined,
  ) => {
    const normalizedSessionProjectId = trimProjectId(sessionProjectId);
    const normalizedSnapshotProjectId = trimProjectId(snapshot?.projectId);
    const normalizedSourceProjectId = trimProjectId(snapshot?.sourceProjectId);
    if (
      snapshot?.projectKind === "video" &&
      normalizedSourceProjectId &&
      normalizedSourceProjectId !== normalizedSnapshotProjectId &&
      (
        visibleProjectIds.has(normalizedSourceProjectId) ||
        normalizedSessionProjectId === normalizedSourceProjectId ||
        normalizedSourceProjectId === trimProjectId(currentSessionProjectId)
      )
    ) {
      hiddenProjectIds.add(normalizedSnapshotProjectId);
      return;
    }
    if (
      !normalizedSessionProjectId ||
      !normalizedSnapshotProjectId ||
      !shouldKeepSessionProjectIdForBridgedVideo({
        currentSessionProjectId: normalizedSessionProjectId,
        snapshot,
      })
    ) {
      return;
    }
    if (
      !visibleProjectIds.has(normalizedSessionProjectId) &&
      normalizedSessionProjectId !== trimProjectId(currentSessionProjectId)
    ) {
      return;
    }
    hiddenProjectIds.add(normalizedSnapshotProjectId);
  };

  for (const session of recentProjectSessions) {
    collectFromSnapshot(session.projectId, session.currentProjectSnapshot);
  }
  collectFromSnapshot(currentSessionProjectId, currentProjectSnapshot);

  return hiddenProjectIds;
}

export function summarizeRecoveryArtifacts(snapshot: ConversationProjectSnapshot): string {
  const labels = snapshot.artifacts
    .slice(0, 3)
    .map((artifact) => artifact.label)
    .filter(Boolean);

  return labels.length
    ? `我已对照当前项目产物做了恢复分析，最近可直接承接的内容是：${labels.join("、")}。`
    : "我已对照当前项目状态做了恢复分析，当前更适合先补齐一份可复用的核心产物。";
}

export function buildRecoveryActionRationale(
  snapshot: ConversationProjectSnapshot,
  action: string,
  index: number,
): string {
  if (action === "修改创作冲突") return "告诉我你想调整的冲突方向，我会重新生成创作方案。";
  if (action === "进入角色开发") return "创作方案已就绪，直接开始生成主要角色设定。";

  void action;

  const artifact = snapshot.artifacts[index] ?? snapshot.artifacts[0];
  if (artifact) {
    return `优先围绕「${artifact.label}」继续推进，保持在${snapshot.derivedStage}阶段内完成。`;
  }

  if (snapshot.currentObjective.trim()) {
    return `会先围绕当前目标”${snapshot.currentObjective}”推进，不需要跳出首页。`;
  }

  return `继续留在${snapshot.derivedStage}阶段里推进这一步，不需要跳出首页。`;
}

export function hasSavedSessionContent(session: StudioSessionState | null | undefined): boolean {
  return Boolean(
    session?.messages?.length ||
      session?.qState ||
      session?.pendingChoiceQuestion ||
      session?.interruptedChoiceQuestion ||
      session?.draft?.trim() ||
      session?.selectedValues?.length ||
      session?.selectedImageModelFamily ||
      session?.imageGenerationPrefs ||
      session?.selectedVideoModelKey ||
      session?.videoGenerationPrefs,
  );
}

export function resolveComposerDraftSnapshot(liveDraft: string, persistedDraft: string): string {
  return liveDraft === persistedDraft ? persistedDraft : liveDraft;
}

export function didSessionScopedProjectSwitch(
  hasObservedProjectSelection: boolean,
  previousProjectId: string | undefined,
  nextProjectId: string | undefined,
): boolean {
  if (!hasObservedProjectSelection) return false;
  return previousProjectId !== nextProjectId;
}

export function normalizePendingWorkflowUploadKind(value: unknown): PendingWorkflowUploadKind | null {
  return value === "adaptation" || value === "video" ? value : null;
}

function hasLegacyPendingWorkflowUploadQuestion(
  session: StudioSessionState | null | undefined,
  label: "adaptation" | "video",
): boolean {
  const question = session?.pendingChoiceQuestion ?? session?.interruptedChoiceQuestion ?? null;
  if (!question) return false;

  const text = [
    question.title,
    question.description,
    ...(question.options?.map((option) => option.label) ?? []),
    ...(question.options?.map((option) => option.value) ?? []),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");

  if (!text) return false;
  if (label === "adaptation") {
    return text.includes("上传参考文档") || text.includes("上传参考剧本");
  }
  return text.includes("上传剧本文档") || text.includes("上传脚本文档");
}

export function resolvePendingWorkflowUploadKind(
  session: StudioSessionState | null | undefined,
): PendingWorkflowUploadKind | null {
  const explicit = normalizePendingWorkflowUploadKind(session?.pendingWorkflowUploadKind);
  if (explicit) return explicit;

  const assistantMessages = (session?.messages ?? [])
    .filter((message) => message.role === "assistant")
    .map((message) => message.content ?? "");
  const lastAssistantMessage = assistantMessages[assistantMessages.length - 1] ?? "";
  if (isAdaptationUploadInstructionMessage(lastAssistantMessage)) return "adaptation";
  if (isVideoWorkflowUploadInstructionMessage(lastAssistantMessage)) return "video";
  if (
    hasLegacyPendingWorkflowUploadQuestion(session, "adaptation") &&
    assistantMessages.some((message) => isAdaptationUploadInstructionMessage(message))
  ) {
    return "adaptation";
  }
  if (
    hasLegacyPendingWorkflowUploadQuestion(session, "video") &&
    assistantMessages.some((message) => isVideoWorkflowUploadInstructionMessage(message))
  ) {
    return "video";
  }
  return null;
}

export function areProjectSnapshotsEquivalent(
  nextProjects: ConversationProjectSnapshot[],
  prevProjects: ConversationProjectSnapshot[],
): boolean {
  if (nextProjects === prevProjects) return true;
  if (nextProjects.length !== prevProjects.length) return false;

  return nextProjects.every((project, index) => {
    const prev = prevProjects[index];
    return (
      project.projectId === prev.projectId &&
      project.sourceProjectId === prev.sourceProjectId &&
      project.updatedAt === prev.updatedAt &&
      project.automationMode === prev.automationMode &&
      project.derivedStage === prev.derivedStage &&
      project.currentObjective === prev.currentObjective &&
      project.agentSummary === prev.agentSummary
    );
  });
}

export function areRecentSessionsEquivalent(
  nextSessions: StudioSessionState[] | undefined,
  prevSessions: StudioSessionState[] | undefined,
): boolean {
  if (nextSessions === prevSessions) return true;
  if (!nextSessions?.length && !prevSessions?.length) return true;
  if (!nextSessions || !prevSessions) return false;
  if (nextSessions.length !== prevSessions.length) return false;

  return nextSessions.every((session, index) => {
    const prev = prevSessions[index];
    const currentSnapshot = session.currentProjectSnapshot;
    const previousSnapshot = prev.currentProjectSnapshot;
    return (
      session.sessionId === prev.sessionId &&
      session.projectId === prev.projectId &&
      session.automationMode === prev.automationMode &&
      currentSnapshot?.projectId === previousSnapshot?.projectId &&
      currentSnapshot?.projectKind === previousSnapshot?.projectKind &&
      currentSnapshot?.sourceProjectId === previousSnapshot?.sourceProjectId &&
      currentSnapshot?.automationMode === previousSnapshot?.automationMode &&
      currentSnapshot?.title === previousSnapshot?.title &&
      currentSnapshot?.currentObjective === previousSnapshot?.currentObjective &&
      currentSnapshot?.derivedStage === previousSnapshot?.derivedStage &&
      currentSnapshot?.agentSummary === previousSnapshot?.agentSummary &&
      currentSnapshot?.updatedAt === previousSnapshot?.updatedAt &&
      session.selectedTextModelKey === prev.selectedTextModelKey &&
      session.selectedImageModelFamily === prev.selectedImageModelFamily &&
      session.selectedVideoModelKey === prev.selectedVideoModelKey &&
      session.imageGenerationPrefs?.familyKey === prev.imageGenerationPrefs?.familyKey &&
      session.imageGenerationPrefs?.resolution === prev.imageGenerationPrefs?.resolution &&
      session.imageGenerationPrefs?.aspectRatio === prev.imageGenerationPrefs?.aspectRatio &&
      session.imageGenerationPrefs?.styleCategory === prev.imageGenerationPrefs?.styleCategory &&
      session.imageGenerationPrefs?.stylePreset === prev.imageGenerationPrefs?.stylePreset &&
      session.imageGenerationPrefs?.customStylePrompt === prev.imageGenerationPrefs?.customStylePrompt &&
      session.videoGenerationPrefs?.modelKey === prev.videoGenerationPrefs?.modelKey &&
      session.videoGenerationPrefs?.resolution === prev.videoGenerationPrefs?.resolution &&
      session.mode === prev.mode &&
      session.compactedMessageCount === prev.compactedMessageCount &&
      session.messages.length === prev.messages.length &&
      session.draft === prev.draft &&
      session.qState?.source === prev.qState?.source &&
      session.qState?.request.id === prev.qState?.request.id &&
      session.qState?.currentIndex === prev.qState?.currentIndex
    );
  });
}

export function upsertRecentProjectSession(
  currentSessions: StudioSessionState[] | undefined,
  nextSession: StudioSessionState,
  limit = 50,
): StudioSessionState[] {
  const baseSessions = currentSessions ?? [];
  const merged = [
    nextSession,
    ...baseSessions.filter(
      (session) =>
        session.projectId !== nextSession.projectId &&
        session.sessionId !== nextSession.sessionId,
    ),
  ].slice(0, limit);

  return areRecentSessionsEquivalent(merged, currentSessions) ? baseSessions : merged;
}

export function mergeRecentProjects(
  currentProjects: ConversationProjectSnapshot[],
  nextProject: ConversationProjectSnapshot,
  limit = 50,
): ConversationProjectSnapshot[] {
  const existingIndex = currentProjects.findIndex((item) => item.projectId === nextProject.projectId);
  const merged =
    existingIndex >= 0
      ? currentProjects.map((item, index) => (index === existingIndex ? nextProject : item))
      : [nextProject, ...currentProjects].slice(0, limit);
  return areProjectSnapshotsEquivalent(merged, currentProjects) ? currentProjects : merged;
}

export function reconcileRecentProjectsWithStableOrder(
  previousProjects: ConversationProjectSnapshot[],
  nextProjects: ConversationProjectSnapshot[],
): ConversationProjectSnapshot[] {
  if (!previousProjects.length) return nextProjects;

  const previousProjectIdSet = new Set(previousProjects.map((project) => project.projectId));
  const nextProjectIdSet = new Set(nextProjects.map((project) => project.projectId));
  const nextProjectMap = new Map(nextProjects.map((project) => [project.projectId, project]));

  const preservedProjects = previousProjects
    .filter((project) => nextProjectIdSet.has(project.projectId))
    .map((project) => nextProjectMap.get(project.projectId) ?? project);
  const addedProjects = nextProjects.filter((project) => !previousProjectIdSet.has(project.projectId));
  const reconciledProjects = addedProjects.length
    ? [...addedProjects, ...preservedProjects]
    : preservedProjects;

  return areProjectSnapshotsEquivalent(reconciledProjects, previousProjects)
    ? previousProjects
    : reconciledProjects;
}

export type AutomationModeProjectMemory = Record<AutomationMode, string | null>;

export function createAutomationModeProjectMemory(
  snapshot?: Pick<ConversationProjectSnapshot, "projectId" | "automationMode"> | null,
): AutomationModeProjectMemory {
  return rememberProjectForAutomationMode(
    {
      manual: null,
      "full-auto": null,
    },
    snapshot,
  );
}

export function rememberProjectForAutomationMode(
  current: AutomationModeProjectMemory,
  snapshot?: Pick<ConversationProjectSnapshot, "projectId" | "automationMode"> | null,
): AutomationModeProjectMemory {
  if (!snapshot?.projectId) return current;
  const mode = normalizeAutomationMode(snapshot.automationMode);
  if (current[mode] === snapshot.projectId) return current;
  return {
    ...current,
    [mode]: snapshot.projectId,
  };
}

function findSessionForProjectId(
  projectId: string,
  recentProjectSessions: Array<
    Pick<StudioSessionState, "projectId" | "automationMode" | "currentProjectSnapshot">
  >,
): Pick<StudioSessionState, "projectId" | "automationMode" | "currentProjectSnapshot"> | null {
  return (
    recentProjectSessions.find(
      (session) =>
        session.projectId === projectId ||
        session.currentProjectSnapshot?.projectId === projectId,
    ) ?? null
  );
}

function timestampOfProjectSession(
  session: Pick<StudioSessionState, "currentProjectSnapshot">,
): number {
  const value = session.currentProjectSnapshot?.updatedAt;
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function mergeProjectSessionFallback(
  existing: Pick<StudioSessionState, "projectId" | "automationMode" | "currentProjectSnapshot">,
  fallback: Pick<StudioSessionState, "projectId" | "automationMode" | "currentProjectSnapshot">,
): Pick<StudioSessionState, "projectId" | "automationMode" | "currentProjectSnapshot"> {
  const fallbackIsNewer =
    timestampOfProjectSession(fallback) >= timestampOfProjectSession(existing);
  const fallbackHasExplicitMode = Boolean(fallback.automationMode);
  const fallbackModeDiffers =
    fallbackHasExplicitMode &&
    normalizeAutomationMode(fallback.automationMode) !== normalizeAutomationMode(existing.automationMode);
  const shouldPreferFallbackSnapshot =
    Boolean(fallback.currentProjectSnapshot) &&
    (!existing.currentProjectSnapshot || fallbackIsNewer || fallbackModeDiffers);

  return {
    ...existing,
    ...fallback,
    projectId: existing.projectId || fallback.projectId,
    automationMode: fallbackHasExplicitMode
      ? fallback.automationMode
      : existing.automationMode ?? fallback.automationMode,
    currentProjectSnapshot: shouldPreferFallbackSnapshot
      ? fallback.currentProjectSnapshot
      : existing.currentProjectSnapshot ?? fallback.currentProjectSnapshot,
  };
}

function getRecentProjectSessionsWithStorageFallback(
  recentProjectSessions: Array<
    Pick<StudioSessionState, "projectId" | "automationMode" | "currentProjectSnapshot">
  > = [],
): Array<Pick<StudioSessionState, "projectId" | "automationMode" | "currentProjectSnapshot">> {
  const merged = [...recentProjectSessions];
  const indexByProjectId = new Map<string, number>();
  merged.forEach((session, index) => {
    const key = session.projectId || session.currentProjectSnapshot?.projectId || "";
    if (key) indexByProjectId.set(key, index);
  });

  const storageSessions =
    typeof window === "undefined"
      ? []
      : (() => {
          try {
            const raw = window.localStorage.getItem(STUDIO_PROJECT_SESSIONS_STORAGE_KEY);
            const parsed = raw ? JSON.parse(raw) : {};
            return parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? Object.values(parsed) as Array<
                  Pick<StudioSessionState, "projectId" | "automationMode" | "currentProjectSnapshot">
                >
              : [];
          } catch {
            return [];
          }
        })();

  for (const session of storageSessions) {
    const key = session.projectId || session.currentProjectSnapshot?.projectId || "";
    if (!key) continue;
    const existingIndex = indexByProjectId.get(key);
    if (existingIndex !== undefined) {
      merged[existingIndex] = mergeProjectSessionFallback(merged[existingIndex], session);
      continue;
    }
    indexByProjectId.set(key, merged.length);
    merged.push(session);
  }

  return merged;
}

export function resolveEffectiveProjectAutomationMode(params: {
  snapshot?: Pick<ConversationProjectSnapshot, "projectId" | "automationMode"> | null;
  recentProjectSessions?: Array<
    Pick<StudioSessionState, "projectId" | "automationMode" | "currentProjectSnapshot">
  >;
  currentProjectSnapshot?: Pick<ConversationProjectSnapshot, "projectId" | "automationMode"> | null;
}): AutomationMode {
  const {
    snapshot = null,
    recentProjectSessions = [],
    currentProjectSnapshot = null,
  } = params;

  if (!snapshot?.projectId) {
    return normalizeAutomationMode(snapshot?.automationMode);
  }

  const session = findSessionForProjectId(
    snapshot.projectId,
    getRecentProjectSessionsWithStorageFallback(recentProjectSessions),
  );
  if (session?.automationMode) {
    return normalizeAutomationMode(session.automationMode);
  }
  if (session?.currentProjectSnapshot?.automationMode) {
    return normalizeAutomationMode(session.currentProjectSnapshot.automationMode);
  }

  if (currentProjectSnapshot?.projectId === snapshot.projectId) {
    return normalizeAutomationMode(currentProjectSnapshot.automationMode ?? snapshot.automationMode);
  }

  return normalizeAutomationMode(snapshot.automationMode);
}

export function filterRecentProjectsForAutomationMode(params: {
  recentProjects: ConversationProjectSnapshot[];
  mode: AutomationMode;
  recentProjectSessions?: Array<
    Pick<StudioSessionState, "projectId" | "automationMode" | "currentProjectSnapshot">
  >;
  currentProjectSnapshot?: Pick<
    ConversationProjectSnapshot,
    "projectId" | "automationMode" | "projectKind" | "sourceProjectId"
  > | null;
  currentSessionProjectId?: string | null;
}): ConversationProjectSnapshot[] {
  const {
    recentProjects,
    mode,
    recentProjectSessions = [],
    currentProjectSnapshot = null,
    currentSessionProjectId = null,
  } = params;
  const sessionSource = getRecentProjectSessionsWithStorageFallback(recentProjectSessions);
  const hiddenBridgedVideoProjectIds = collectHiddenBridgedVideoProjectIds({
    recentProjects,
    recentProjectSessions: sessionSource,
    currentProjectSnapshot,
    currentSessionProjectId,
  });

  return recentProjects.filter(
    (project) =>
      !hiddenBridgedVideoProjectIds.has(project.projectId) &&
      resolveEffectiveProjectAutomationMode({
        snapshot: project,
        recentProjectSessions: sessionSource,
        currentProjectSnapshot,
      }) === mode,
  );
}

export function selectRecentProjectForAutomationMode(params: {
  recentProjects: ConversationProjectSnapshot[];
  mode: AutomationMode;
  preferredProjectId?: string | null;
  recentProjectSessions?: Array<
    Pick<StudioSessionState, "projectId" | "automationMode" | "currentProjectSnapshot">
  >;
  currentProjectSnapshot?: Pick<
    ConversationProjectSnapshot,
    "projectId" | "automationMode" | "projectKind" | "sourceProjectId"
  > | null;
  currentSessionProjectId?: string | null;
}): ConversationProjectSnapshot | null {
  const {
    recentProjects,
    mode,
    preferredProjectId = null,
    recentProjectSessions = [],
    currentProjectSnapshot = null,
    currentSessionProjectId = null,
  } = params;
  const eligibleProjects = filterRecentProjectsForAutomationMode({
    recentProjects,
    mode,
    recentProjectSessions,
    currentProjectSnapshot,
    currentSessionProjectId,
  });
  if (preferredProjectId) {
    const preferredProject = eligibleProjects.find((project) => project.projectId === preferredProjectId);
    if (preferredProject) return preferredProject;
  }
  return eligibleProjects[0] ?? null;
}

export function mergeRecentProjectsWithSessionSnapshots(params: {
  recentProjects: ConversationProjectSnapshot[];
  recentProjectSessions?: StudioSessionState[];
  currentProjectSnapshot?: ConversationProjectSnapshot | null;
  currentSessionProjectId?: string | null;
  limit?: number;
}): ConversationProjectSnapshot[] {
  const {
    recentProjects,
    recentProjectSessions = [],
    currentProjectSnapshot = null,
    currentSessionProjectId = null,
    limit = 50,
  } = params;
  const sessionSource = getRecentProjectSessionsWithStorageFallback(recentProjectSessions);

  const hiddenBridgedVideoProjectIds = collectHiddenBridgedVideoProjectIds({
    recentProjects,
    recentProjectSessions: sessionSource,
    currentProjectSnapshot,
    currentSessionProjectId,
  });

  let nextProjects = hiddenBridgedVideoProjectIds.size
    ? recentProjects.filter((project) => !hiddenBridgedVideoProjectIds.has(project.projectId))
    : recentProjects;
  const currentSnapshotProjectId = trimProjectId(currentProjectSnapshot?.projectId);
  const currentSessionProjectIdNormalized = trimProjectId(currentSessionProjectId);
  const sessionSnapshots = sessionSource
    .map((session) => {
      const snapshot = session.currentProjectSnapshot;
      if (!snapshot?.projectId) return null;
      const sessionProjectId = trimProjectId(session.projectId);
      const shouldProjectOntoSessionShell = shouldKeepSessionProjectIdForBridgedVideo({
        currentSessionProjectId: sessionProjectId,
        snapshot,
      });
      return {
        ...snapshot,
        projectId: shouldProjectOntoSessionShell ? sessionProjectId : snapshot.projectId,
        automationMode: session.automationMode ?? snapshot.automationMode,
      } satisfies ConversationProjectSnapshot;
    })
    .filter((snapshot): snapshot is ConversationProjectSnapshot => Boolean(snapshot));

  for (const snapshot of [...sessionSnapshots].reverse()) {
    const previousSnapshot = nextProjects.find((project) => project.projectId === snapshot.projectId) ?? null;
    const sessionProjectId = trimProjectId(snapshot.projectId);
    const snapshotSourceProjectId = trimProjectId(snapshot.sourceProjectId);
    const isCurrentSessionSnapshot =
      sessionProjectId === currentSessionProjectIdNormalized ||
      sessionProjectId === currentSnapshotProjectId ||
      snapshotSourceProjectId === currentSessionProjectIdNormalized;
    const isFullAutoSessionOnlySnapshot =
      !previousSnapshot &&
      resolveEffectiveProjectAutomationMode({
        snapshot,
        recentProjectSessions: sessionSource,
        currentProjectSnapshot,
      }) === "full-auto";
    const shouldSurfaceMissingSnapshot =
      isCurrentSessionSnapshot ||
      (!previousSnapshot && sessionProjectId === currentSnapshotProjectId) ||
      isFullAutoSessionOnlySnapshot;

    if (!shouldSurfaceMissingSnapshot) {
      continue;
    }

    nextProjects = mergeRecentProjects(
      nextProjects,
      previousSnapshot?.pinned && !snapshot.pinned
        ? { ...snapshot, pinned: previousSnapshot.pinned }
        : snapshot,
      limit,
    );
  }

  if (currentProjectSnapshot?.projectId) {
    const normalizedCurrentSnapshotProjectId = trimProjectId(currentProjectSnapshot.projectId);
    const normalizedCurrentSourceProjectId = trimProjectId(currentProjectSnapshot.sourceProjectId);
    const bridgedVisibleShellProjectId =
      currentProjectSnapshot.projectKind === "video" &&
      normalizedCurrentSnapshotProjectId &&
      normalizedCurrentSourceProjectId &&
      hiddenBridgedVideoProjectIds.has(normalizedCurrentSnapshotProjectId) &&
      nextProjects.some((project) => project.projectId === normalizedCurrentSourceProjectId)
        ? normalizedCurrentSourceProjectId
        : null;
    const projectedCurrentSnapshot = {
      ...currentProjectSnapshot,
      projectId:
        bridgedVisibleShellProjectId ??
        resolveSessionProjectIdForSnapshot({
          currentSessionProjectId,
          snapshot: currentProjectSnapshot,
          fallbackProjectId: currentProjectSnapshot.projectId,
        }) ?? currentProjectSnapshot.projectId,
    };
    const previousSnapshot =
      nextProjects.find((project) => project.projectId === projectedCurrentSnapshot.projectId) ?? null;
    const shouldSurfaceCurrentSnapshot =
      Boolean(previousSnapshot) ||
      !currentSessionProjectIdNormalized ||
      projectedCurrentSnapshot.projectId === currentSessionProjectIdNormalized;
    if (!shouldSurfaceCurrentSnapshot) {
      return nextProjects;
    }
    nextProjects = mergeRecentProjects(
      nextProjects,
      previousSnapshot?.pinned && !projectedCurrentSnapshot.pinned
        ? { ...projectedCurrentSnapshot, pinned: previousSnapshot.pinned }
        : projectedCurrentSnapshot,
      limit,
    );
  }
  return nextProjects;
}

export function buildProjectSuggestionKey(
  snapshot: ConversationProjectSnapshot | null | undefined,
  question: ComposerQuestion | null | undefined,
): string | null {
  if (!snapshot || !question) return null;
  const optionSignature = question.options
    .slice(0, 4)
    .map((option) => `${option.value}:${option.label}`)
    .join("|");
  return [
    snapshot.projectId,
    snapshot.projectKind,
    snapshot.derivedStage,
    snapshot.currentObjective,
    question.id,
    question.title,
    question.answerKey,
    optionSignature,
  ]
    .filter(Boolean)
    .join(":");
}

export const qStepKey = (
  index: number,
  question: Pick<AskUserQuestionRequest["questions"][number], "header">,
) => `${index}:${question.header}`;

export function qToComposer(state: StudioQuestionState | null): ComposerQuestion | null {
  const activeQuestion = state ? state.request.questions[state.currentIndex] : null;
  if (!state || !activeQuestion) return null;

  return {
    id: `${state.request.id}:${state.currentIndex}`,
    title: activeQuestion.question,
    description: state.request.description,
    options: activeQuestion.options.map((option, index) => ({
      id: `${activeQuestion.header}-${index}`,
      label: option.label,
      value: option.value || option.label,
      rationale: option.rationale || option.description,
      confirmDialog: option.confirmDialog,
    })),
    presentation: activeQuestion.presentation === "chip" || activeQuestion.presentation === "card"
      ? activeQuestion.presentation
      : "auto",
    allowCustomInput: state.request.allowCustomInput !== false,
    submissionMode: state.request.submissionMode === "confirm" ? "confirm" : "immediate",
    multiSelect: activeQuestion.multiSelect,
    stepIndex: state.currentIndex,
    totalSteps: state.request.questions.length,
    answerKey: activeQuestion.header,
  };
}

export function serializeQuestionAnswers(
  request: AskUserQuestionRequest,
  answers: Record<string, string>,
): string {
  const rows = request.questions
    .map((item, index) => {
      const answer = answers[qStepKey(index, item)]?.trim();
      return answer ? `${item.header}: ${answer}` : "";
    })
    .filter(Boolean);

  if (rows.length <= 1) {
    return rows[0]?.replace(/^[^:]+:\s*/, "") ?? "";
  }

  return rows.join("\n");
}
