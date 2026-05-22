import type {
  ArtifactKind,
  ComposerQuestion,
  ConversationArtifact,
  ConversationProjectSnapshot,
  StudioRuntimeState,
  WorkflowActionResult,
  WorkflowRuntimeDelta,
} from "./types";
import { resolveArtifactSnapshots } from "./message-artifact-snapshots";

const RECENT_PROJECT_RUNTIME_LIMIT = 50;
const SHORTCUT_PROGRESS_LABELS: Record<string, string> = {
  generate_outlines: "单集细纲",
  generate_episode: "分集撰写",
  generate_episode_batch: "分集撰写",
  analyze_script_for_video: "剧本拆解 [>] 初始化",
  compile_video_shot_packets: "编译镜头指令包",
  prepare_video_prompt_batch: "镜头提示词 [>] 初始化",
  prepare_segment_video_prompt: "片段提示词 [>] 初始化",
  generate_video_assets: "镜头视频 [>] 初始化",
  generate_segment_video: "生成片段视频",
  refresh_video_assets: "镜头视频 [>] 刷新状态",
  refresh_segment_video: "刷新片段视频",
};

export function getWorkflowShortcutProgressLabel(action: string): string | null {
  return SHORTCUT_PROGRESS_LABELS[action] ?? null;
}

export function dispatchWorkflowShortcutProgressEvent(
  action: string,
  status: "start" | "progress" | "complete",
  content: string,
) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("agent:workflow-progress", {
      detail: { id: `shortcut-${action}`, status, content },
    }),
  );
}

function shouldReopenPopoverForVideoWorkflowGate(params: {
  message: string;
  snapshot: ConversationProjectSnapshot | null | undefined;
  nextSuggestion: ComposerQuestion | null;
}): boolean {
  const { message, snapshot, nextSuggestion } = params;
  if (!nextSuggestion || snapshot?.projectKind !== "video") return false;

  const normalizedMessage = message.trim();
  if (!normalizedMessage) return false;

  return [
    /当前还没有/,
    /当前还有/,
    /当前选中的 .*缺少参考图/,
    /至少需要/,
    /需要先/,
    /先整理/,
    /先补齐/,
    /才能进入/,
    /不能切换/,
    /再进入视频生成会更稳/,
    /再继续推进视频生成/,
    /再编译镜头指令包/,
  ].some((pattern) => pattern.test(normalizedMessage));
}

function upsertRecentProject(
  recentProjects: ConversationProjectSnapshot[],
  snapshot: ConversationProjectSnapshot,
): ConversationProjectSnapshot[] {
  return [snapshot, ...recentProjects.filter((item) => item.projectId !== snapshot.projectId)].slice(
    0,
    RECENT_PROJECT_RUNTIME_LIMIT,
  );
}

function createArtifactRevisionKey(
  artifact: ConversationProjectSnapshot["artifacts"][number],
): string {
  return JSON.stringify({
    id: artifact.id,
    kind: artifact.kind,
    label: artifact.label,
    summary: artifact.summary,
    content: artifact.content,
    presentation: artifact.presentation,
    payload: artifact.payload,
    actions: artifact.actions,
    editor: artifact.editor,
  });
}

function collectChangedArtifactIds(
  previousSnapshot: ConversationProjectSnapshot | null | undefined,
  nextSnapshot: ConversationProjectSnapshot | null | undefined,
): string[] {
  if (!nextSnapshot?.artifacts.length) return [];

  const previousSignatures = new Map(
    previousSnapshot?.artifacts.map((artifact) => [artifact.id, createArtifactRevisionKey(artifact)]) ?? [],
  );

  const changedArtifactIds: string[] = [];
  for (const artifact of nextSnapshot.artifacts) {
    const nextSignature = createArtifactRevisionKey(artifact);
    const previousSignature = previousSignatures.get(artifact.id);
    if (previousSignature === undefined || previousSignature !== nextSignature) {
      changedArtifactIds.push(artifact.id);
    }
  }

  return [...new Set(changedArtifactIds)];
}

const ACTION_ARTIFACT_KIND_FILTERS: Partial<Record<string, ArtifactKind[]>> = {
  analyze_reference_script: ["reference"],
  generate_creative_plan: ["plan"],
  generate_structure_transform: ["plan"],
  generate_characters: ["characters"],
  generate_character_transform: ["characters"],
  generate_directory: ["directory"],
  generate_outlines: ["outline"],
  generate_episode: ["episode"],
  generate_episode_batch: ["episode"],
  set_episode_duration_preference: ["episode"],
  review_episode_quality: ["episode-review"],
  rewrite_episode_from_review: ["episode", "episode-review"],
  run_compliance_review: ["compliance"],
  auto_adjust_compliance: ["compliance"],
  resolve_compliance_revisions: ["compliance"],
  reopen_compliance_revisions: ["compliance"],
  export_project: ["export"],
  analyze_script_for_video: ["video-brief"],
  extract_video_entities: ["characters", "scene-settings"],
  prepare_storyboard_batch: ["storyboard-plan"],
  prepare_video_prompt_batch: ["video-prompt-batch"],
  prepare_segment_video_prompt: ["report"],
  export_storyboard_xlsx: ["storyboard-plan"],
  create_video_bridge_artifact: ["video-brief"],
};

function collectActionScopedArtifactIds(params: {
  action: string;
  input?: Record<string, unknown>;
  previousSnapshot: ConversationProjectSnapshot | null | undefined;
  nextSnapshot: ConversationProjectSnapshot | null | undefined;
}): string[] {
  const { action, input, previousSnapshot, nextSnapshot } = params;
  const changedArtifactIds = collectChangedArtifactIds(previousSnapshot, nextSnapshot);
  if (!changedArtifactIds.length || !nextSnapshot?.artifacts.length) {
    return changedArtifactIds;
  }

  const preferredKinds =
    action === "enter_drama_step"
      ? resolveDramaStepArtifactKinds(input)
      : ACTION_ARTIFACT_KIND_FILTERS[action];
  if (!preferredKinds?.length) {
    return changedArtifactIds;
  }

  const preferredKindSet = new Set(preferredKinds);
  const filteredArtifactIds = changedArtifactIds.filter((artifactId) => {
    const artifact = nextSnapshot.artifacts.find((item) => item.id === artifactId);
    return artifact ? preferredKindSet.has(artifact.kind) : false;
  });
  if (filteredArtifactIds.length) {
    return filteredArtifactIds;
  }

  return nextSnapshot.artifacts
    .filter((artifact) => preferredKindSet.has(artifact.kind))
    .map((artifact) => artifact.id);
}

const DRAMA_STEP_ARTIFACT_KIND_FILTERS: Partial<Record<string, ArtifactKind[]>> = {
  setup: ["setup", "dramaSetup"],
  "reference-script": ["reference"],
  "creative-plan": ["plan"],
  "structure-transform": ["plan"],
  characters: ["characters"],
  "character-transform": ["characters"],
  directory: ["directory"],
  outlines: ["outline"],
  episodes: ["episode"],
  compliance: ["compliance"],
  export: ["export"],
};

function resolveDramaStepArtifactKinds(
  input: Record<string, unknown> | undefined,
): ArtifactKind[] | undefined {
  const step = typeof input?.step === "string" ? input.step : "";
  return DRAMA_STEP_ARTIFACT_KIND_FILTERS[step];
}

export function mergeRuntimeWithWorkflowDelta(
  previous: StudioRuntimeState,
  delta?: WorkflowRuntimeDelta,
  options?: {
    deferRecentProjectUpsert?: boolean;
  },
): StudioRuntimeState {
  if (!delta) return previous;

  const nextProjectSnapshot = delta.projectSnapshot ?? previous.currentProjectSnapshot;
  const shouldDeferRecentProjectUpsert = Boolean(
    options?.deferRecentProjectUpsert &&
      nextProjectSnapshot &&
      !previous.currentProjectSnapshot?.projectId &&
      !previous.recentProjects.some((item) => item.projectId === nextProjectSnapshot.projectId),
  );
  return {
    ...previous,
    currentDramaProject: delta.dramaProject === undefined ? previous.currentDramaProject : delta.dramaProject,
    currentVideoProject: delta.videoProject === undefined ? previous.currentVideoProject : delta.videoProject,
    currentProjectSnapshot: nextProjectSnapshot,
    skillDrafts: delta.skillDrafts ?? previous.skillDrafts,
    maintenanceReports: delta.maintenanceReports ?? previous.maintenanceReports,
    recentProjects: nextProjectSnapshot
      ? shouldDeferRecentProjectUpsert
        ? previous.recentProjects
        : upsertRecentProject(previous.recentProjects, nextProjectSnapshot)
      : previous.recentProjects,
    recentMessageSummary:
      delta.recentMessageSummary === undefined ? previous.recentMessageSummary : delta.recentMessageSummary,
  };
}

type WorkflowActionRunner = (
  action: string,
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
  onProgress?: import("./types").WorkflowActionProgressCallback,
) => Promise<WorkflowActionResult>;

type WorkflowShortcutUiBridge = {
  activateConversation: () => void;
  clearChoiceUi: () => void;
  commitRuntime: (runtime: StudioRuntimeState, projectId?: string) => void;
  getSuggestedQuestion: (
    snapshot: ConversationProjectSnapshot | null,
    runtime: StudioRuntimeState,
  ) => ComposerQuestion | null;
  pushAssistant: (content: string, artifactIds?: string[], artifactSnapshots?: ConversationArtifact[]) => void;
  pushUser: (content: string) => void;
  resetComposerDraft: () => void;
  setPopoverQuestion: (
    question: ComposerQuestion | null,
    snapshot?: ConversationProjectSnapshot | null,
  ) => void;
  setStreaming: (streaming: boolean) => void;
  setSuggested: (question: ComposerQuestion | null) => void;
};

type WorkflowShortcutStep = {
  action: string;
  input: Record<string, unknown>;
};

type WorkflowShortcutFollowupAction = {
  action: string;
  input: Record<string, unknown>;
};

type WorkflowShortcutCompletion = {
  action: string;
  summary: string;
  runtime: StudioRuntimeState;
  projectSnapshot: ConversationProjectSnapshot | null;
  data?: WorkflowActionResult["data"];
  nextSuggestion: ComposerQuestion | null;
  pendingFollowup: WorkflowShortcutFollowupAction | null;
};

function hasVideoCompletedFirstCycle(snapshot: ConversationProjectSnapshot | null): boolean {
  if (!snapshot || snapshot.projectKind !== "video") return false;
  return Boolean(
    snapshot.memory?.videoScenes?.some(
      (scene) => !!scene.videoUrl || String(scene.videoStatus || "").toLowerCase() === "failed",
    ),
  );
}

function shouldAutoOpenFollowupPopover(params: {
  action: string;
  nextSuggestion: ComposerQuestion | null;
  nextProjectSnapshot: ConversationProjectSnapshot | null;
  preferVideoPopover?: boolean;
}): boolean {
  const { action, nextSuggestion, nextProjectSnapshot, preferVideoPopover = false } = params;
  if (!nextSuggestion) return false;
  if (
    action === "enter_drama_step" &&
    nextProjectSnapshot?.projectKind !== "video" &&
    /^script-/.test(nextSuggestion.answerKey)
  ) {
    return true;
  }
  if (action === "save_setup" && nextSuggestion.answerKey === "script-creative-plan") {
    return true;
  }
  // 走完第一轮后不再自动推进面板，用户自由切换步骤
  if (hasVideoCompletedFirstCycle(nextProjectSnapshot)) return false;
  if (preferVideoPopover && nextProjectSnapshot?.projectKind === "video") {
    return true;
  }
  if (action === "create_video_bridge_artifact" && nextProjectSnapshot?.projectKind === "video") {
    return true;
  }
  return [
    "advance_video_workflow_round",
    "analyze_reference_script",
    "analyze_script_for_video",
    "confirm_adaptation_episode_count",
    "confirm_adaptation_target_market",
    "confirm_adaptation_genres",
    "continue_video_step",
    "compile_video_shot_packets",
    "generate_project_image",
    "prepare_storyboard_batch",
    "generate_storyboard_frames",
    "generate_video_assets",
    "generate_video_reference_assets",
    "generate_characters",
    "generate_character_transform",
    "generate_creative_plan",
    "generate_episode",
    "generate_episode_batch",
    "generate_outlines",
    "review_episode_quality",
    "rewrite_episode_from_review",
    "prepare_segment_video_prompt",
    "generate_segment_video",
    "refresh_segment_video",
  ].includes(action);
}

function normalizeWorkflowShortcutError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/文本模型 API Key|可用的文本模型/i.test(message)) {
    return `${message}\n\n下一步建议：打开设置补齐内置 API 配置后，再回到首页继续当前会话。`;
  }


  if (/缺少 .*API Key|缺少 Seedance \/ Gemini 可用 Key|缺少可用 API Key/i.test(message)) {
    return `${message}\n\n下一步建议：去设置补齐 Key，或切换到另一条已可用的视频通道后继续。`;
  }

  if (/恢复失败|打开目录/i.test(message)) {
    return `${message}\n\n下一步建议：先留在首页继续查看摘要或重试，不需要离开当前会话。`;
  }

  return message;
}

function isAbortLikeWorkflowError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    error.message === "Aborted" ||
    error.message === "请求已取消" ||
    error.message === "任务已取消"
  );
}

function isTimeoutLikeWorkflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|超时/i.test(message);
}

function extractArtifactDisplayContent(
  snapshot: ConversationProjectSnapshot | null | undefined,
  kind: string,
): string {
  const artifact = snapshot?.artifacts.find((item) => item.kind === kind);
  const content = typeof artifact?.content === "string" ? artifact.content : "";
  return content.trim();
}

function formatArtifactSection(title: string, content: string): string {
  if (!content) return "";
  return `${title}：\n${content}`;
}

function stripSegmentPromptDetailsForChat(summary: string): string {
  const detailSectionMarkers = [
    "最终提示词稳定性：",
    "最终提示词日志：",
    "### 片段 ",
  ];
  const cutoffIndex = detailSectionMarkers.reduce<number>((earliestIndex, marker) => {
    const markerIndex = summary.indexOf(marker);
    if (markerIndex < 0) return earliestIndex;
    if (earliestIndex < 0) return markerIndex;
    return Math.min(earliestIndex, markerIndex);
  }, -1);

  if (cutoffIndex < 0) return summary;
  return summary.slice(0, cutoffIndex).trimEnd();
}

function buildWorkflowAssistantDisplaySummary(params: {
  action: string;
  summary: string;
  nextSnapshot: ConversationProjectSnapshot | null | undefined;
}): string {
  const { action, summary } = params;
  const trimmedSummary = summary.trim();
  if (!trimmedSummary) return "";

  if (action === "prepare_segment_video_prompt") {
    return stripSegmentPromptDetailsForChat(trimmedSummary);
  }

  if (action !== "extract_video_entities") {
    return trimmedSummary;
  }

  return trimmedSummary;
  /*
  const lead = trimmedSummary;
  const characterNames = "";
  const sceneNames = "";
  const sections = [
    formatArtifactSection("角色", characterNames),
    formatArtifactSection("场景", sceneNames),
  ].filter(Boolean);

  return [lead, ...sections].filter(Boolean).join("\n\n");
  */
}

function hasInlineMediaOutput(result: Pick<WorkflowActionResult, "imageUrls" | "videoUrls">): boolean {
  return Boolean(result.imageUrls?.length || result.videoUrls?.length);
}

function shouldAlwaysShowWorkflowAssistantSummary(action: string): boolean {
  return action === "generate_video_assets";
}

function shouldSuppressWorkflowAssistantSummary(action: string): boolean {
  return (
    action === "generate_video_assets" ||
    action === "generate_video_reference_assets" ||
    action === "generate_segment_video" ||
    action === "refresh_segment_video"
  );
}

function pushWorkflowAssistantSummary(params: {
  action: string;
  input: Record<string, unknown>;
  ui: WorkflowShortcutUiBridge;
  previousSnapshot: ConversationProjectSnapshot | null | undefined;
  nextSnapshot: ConversationProjectSnapshot | null | undefined;
  summary: string;
}): void {
  const { action, input, ui, previousSnapshot, nextSnapshot, summary } = params;
  const payload = buildWorkflowAssistantMessagePayload({
    action,
    input,
    previousSnapshot,
    nextSnapshot,
    summary,
  });
  if (!payload) return;
  ui.pushAssistant(
    payload.content,
    payload.artifactIds,
    payload.artifactSnapshots,
  );
}

export function buildWorkflowAssistantMessagePayload(params: {
  action: string;
  input: Record<string, unknown>;
  previousSnapshot: ConversationProjectSnapshot | null | undefined;
  nextSnapshot: ConversationProjectSnapshot | null | undefined;
  summary: string;
}): {
  content: string;
  artifactIds: string[];
  artifactSnapshots: ConversationArtifact[];
} | null {
  const { action, input, previousSnapshot, nextSnapshot, summary } = params;
  const content = buildWorkflowAssistantDisplaySummary({
    action,
    summary,
    nextSnapshot,
  });
  if (!content) return null;
  const artifactIds = collectActionScopedArtifactIds({
    action,
    input,
    previousSnapshot,
    nextSnapshot,
  });

  return {
    content,
    artifactIds,
    artifactSnapshots: resolveArtifactSnapshots(nextSnapshot ?? null, artifactIds),
  };
}

function updateWorkflowSuggestionUi(params: {
  action: string;
  allowAutoFollowup: boolean;
  nextProjectSnapshot: ConversationProjectSnapshot | null;
  nextSuggestion: ComposerQuestion | null;
  ui: WorkflowShortcutUiBridge;
  surfaceNextSuggestion: boolean;
}): WorkflowShortcutFollowupAction | null {
  const {
    action,
    allowAutoFollowup,
    nextProjectSnapshot,
    nextSuggestion,
    ui,
    surfaceNextSuggestion,
  } = params;

  if (!surfaceNextSuggestion) return null;

  if (
    shouldAutoOpenFollowupPopover({
      action,
      nextSuggestion,
      nextProjectSnapshot,
      preferVideoPopover: allowAutoFollowup,
    })
  ) {
    ui.setPopoverQuestion(nextSuggestion, nextProjectSnapshot);
    ui.setSuggested(null);
    return null;
  }

  const pendingAutoFollowup =
    allowAutoFollowup ? resolveAutoWorkflowFollowupAction(nextProjectSnapshot, nextSuggestion) : null;
  if (pendingAutoFollowup) {
    ui.setSuggested(null);
    return pendingAutoFollowup;
  }

  if (
    shouldAutoOpenFollowupPopover({
      action,
      nextSuggestion,
      nextProjectSnapshot,
    })
  ) {
    ui.setPopoverQuestion(nextSuggestion, nextProjectSnapshot);
    ui.setSuggested(null);
    return null;
  }

  ui.setSuggested(nextSuggestion);
  return null;
}

export function resolveAutoWorkflowFollowupAction(
  _snapshot: ConversationProjectSnapshot | null,
  _nextSuggestion: ComposerQuestion | null,
): WorkflowShortcutFollowupAction | null {
  return null;
}

export function buildWorkflowContinuationPrompt(params: {
  action: string;
  summary: string;
  projectSnapshot: ConversationProjectSnapshot | null;
}): string {
  const { action, summary, projectSnapshot } = params;
  const snapshotLine = projectSnapshot
    ? `${projectSnapshot.title} / ${projectSnapshot.projectKind} / ${projectSnapshot.derivedStage}`
    : "No active project snapshot";

  const lines = [
    "A direct homepage workflow shortcut has already finished.",
    `Completed action: ${action}`,
    `Project snapshot: ${snapshotLine}`,
    "Latest workflow summary:",
    summary.trim() || "(empty summary)",
    "",
    "Continue in the same conversation instead of restarting the workflow.",
    "First identify the current workflow stage from the project snapshot before replying.",
    "Do not jump to a later workflow stage. Stay inside the current stage until it is complete.",
    "End the reply with forward guidance: either a short next-step recommendation or an AskUserQuestion for the current step.",
  ];

  if (action === "export_project") {
    lines.push(
      "If the script is ready to bridge into the video workflow, offer that bridge through AskUserQuestion and keep the user inside the same conversation.",
    );
  }

  if (
    action === "generate_video_reference_assets" ||
    action === "generate_storyboard_frames" ||
    action === "generate_project_image"
  ) {
    lines.push(
      "Image generation has just completed. The generated images are already displayed in the chat — do NOT describe or list them in text.",
      "Write 1-2 sentences acknowledging the result (e.g. how many images were generated, any notable quality notes from the summary).",
      "Then immediately call AskUserQuestion to offer the user clear next-step options (e.g. regenerate, add to asset library, proceed to next stage).",
      "Do NOT say 'images are shown above' or repeat image URLs. Keep the reply concise and action-oriented.",
    );
  }

  if (action === "generate_video_assets") {
    lines.push(
      "Video generation has just completed. The video cards are already displayed in the chat — do NOT describe or list video URLs in text.",
      "Write 1-2 sentences acknowledging the result (e.g. how many videos completed, any failures noted in the summary).",
      "Then immediately call AskUserQuestion to offer the user clear next-step options (e.g. review results, regenerate failed clips, proceed to export).",
      "Do NOT say 'videos are shown above' or repeat video URLs. Keep the reply concise and action-oriented.",
    );
  }

  if (action === "generate_segment_video") {
    lines.push(
      "Segment video generation has just completed. The video card is already displayed in the chat — do NOT describe or list video URLs in text.",
      "Write 1-2 sentences acknowledging the result.",
      "Then immediately call AskUserQuestion to offer the user clear next-step options (e.g. generate other segments, review results, proceed to export).",
      "Do NOT say 'video is shown above' or repeat video URLs. Keep the reply concise and action-oriented.",
    );
  }

  if (projectSnapshot?.projectKind === "video") {
    lines.push(
      "Continue the video workflow step-by-step, collecting only the missing details for the current stage before the next action.",
    );
  }

  return lines.join("\n");
}

export async function runWorkflowShortcut(params: {
  action: string;
  input: Record<string, unknown>;
  runtime: StudioRuntimeState;
  runAction: WorkflowActionRunner;
  ui: WorkflowShortcutUiBridge;
  userBubble: string;
  allowAutoFollowup?: boolean;
  surfaceNextSuggestion?: boolean;
  skipAssistantSummary?: boolean;
  skipInitialProgressEvent?: boolean;
  deferRecentProjectUpsert?: boolean;
  onError?: () => void;
  onErrorMessage?: (message: string, error: unknown) => void;
}): Promise<WorkflowShortcutCompletion | null> {
  const {
    action,
    input,
    runtime,
    runAction,
    ui,
    userBubble,
    allowAutoFollowup = false,
    surfaceNextSuggestion = true,
    skipAssistantSummary = false,
    skipInitialProgressEvent = false,
    deferRecentProjectUpsert = false,
    onError,
    onErrorMessage,
  } = params;

  if (userBubble.trim()) {
    ui.pushUser(userBubble);
  }
  ui.clearChoiceUi();
  ui.activateConversation();
  ui.resetComposerDraft();
  ui.setStreaming(true);

  const shortcutProgressLabel = getWorkflowShortcutProgressLabel(action);
  if (shortcutProgressLabel && !skipInitialProgressEvent) {
    dispatchWorkflowShortcutProgressEvent(action, "start", shortcutProgressLabel);
  }

  try {
    const onProgress = (partial: WorkflowActionResult) => {
      if (shortcutProgressLabel && partial.summary?.trim()) {
        dispatchWorkflowShortcutProgressEvent(action, "progress", partial.summary.trim());
      }
      if (partial.data) {
        const partialRuntime = mergeRuntimeWithWorkflowDelta(runtime, partial.data, {
          deferRecentProjectUpsert,
        });
        ui.commitRuntime(partialRuntime, partial.data.projectSnapshot?.projectId);
      }
    };

    const result = await runAction(action, input, runtime, onProgress);
    const nextProjectSnapshot = result.projectSnapshot ?? result.data?.projectSnapshot ?? null;
    const nextRuntime = result.data
      ? mergeRuntimeWithWorkflowDelta(runtime, result.data, { deferRecentProjectUpsert })
      : runtime;
    const nextSuggestion = nextProjectSnapshot ? ui.getSuggestedQuestion(nextProjectSnapshot, nextRuntime) : null;

    if (result.data) {
      ui.commitRuntime(nextRuntime, nextProjectSnapshot?.projectId);
    }

    const shouldAlwaysShowSummary = shouldAlwaysShowWorkflowAssistantSummary(action);
    if (
      !skipAssistantSummary &&
      (shouldAlwaysShowSummary || !hasInlineMediaOutput(result)) &&
      !shouldSuppressWorkflowAssistantSummary(action)
    ) {
      pushWorkflowAssistantSummary({
        action,
        input,
        ui,
        previousSnapshot: runtime.currentProjectSnapshot,
        nextSnapshot: nextProjectSnapshot,
        summary: result.summary,
      });
    }

    const pendingFollowup = updateWorkflowSuggestionUi({
      action,
      allowAutoFollowup,
      nextProjectSnapshot,
      nextSuggestion,
      ui,
      surfaceNextSuggestion,
    });

    return {
      action,
      summary: result.summary.trim(),
      runtime: nextRuntime,
      projectSnapshot: nextProjectSnapshot,
      data: result.data,
      nextSuggestion,
      pendingFollowup,
    };
  } catch (error) {
    onError?.();
    if (isAbortLikeWorkflowError(error)) {
      return null;
    }
    const normalizedMessage = normalizeWorkflowShortcutError(error);
    if (surfaceNextSuggestion) {
      const nextSuggestion = runtime.currentProjectSnapshot
        ? ui.getSuggestedQuestion(runtime.currentProjectSnapshot, runtime)
        : null;
      if (nextSuggestion) {
        if (shouldReopenPopoverForVideoWorkflowGate({
          message: normalizedMessage,
          snapshot: runtime.currentProjectSnapshot,
          nextSuggestion,
        })) {
          ui.setPopoverQuestion(nextSuggestion, runtime.currentProjectSnapshot);
          ui.setSuggested(null);
        } else {
          ui.setSuggested(nextSuggestion);
        }
      }
    }
    if (isTimeoutLikeWorkflowError(error)) {
      onErrorMessage?.(normalizedMessage, error);
    }
    ui.pushAssistant(normalizedMessage);
    return null;
  } finally {
    if (shortcutProgressLabel) {
      dispatchWorkflowShortcutProgressEvent(action, "complete", "");
    }
    ui.setStreaming(false);
  }
}

export async function runWorkflowShortcutChain(params: {
  runtime: StudioRuntimeState;
  runAction: WorkflowActionRunner;
  steps: WorkflowShortcutStep[];
  ui: WorkflowShortcutUiBridge;
  userBubble: string;
  allowAutoFollowup?: boolean;
  surfaceNextSuggestion?: boolean;
  deferRecentProjectUpsert?: boolean;
  skipInitialProgressEvent?: boolean;
  onError?: () => void;
  onErrorMessage?: (message: string, error: unknown) => void;
}): Promise<WorkflowShortcutCompletion | null> {
  const {
    runtime,
    runAction,
    steps,
    ui,
    userBubble,
    allowAutoFollowup = false,
    surfaceNextSuggestion = true,
    deferRecentProjectUpsert = false,
    skipInitialProgressEvent = false,
    onError,
    onErrorMessage,
  } = params;

  if (userBubble.trim()) {
    ui.pushUser(userBubble);
  }
  ui.clearChoiceUi();
  ui.activateConversation();
  ui.resetComposerDraft();
  ui.setStreaming(true);

  const finalAction = steps.at(-1)?.action ?? "";
  const shortcutProgressLabel = getWorkflowShortcutProgressLabel(finalAction);
  if (shortcutProgressLabel && !skipInitialProgressEvent) {
    dispatchWorkflowShortcutProgressEvent(finalAction, "start", shortcutProgressLabel);
  }

  let nextRuntime = runtime;
  let nextProjectId = runtime.currentProjectSnapshot?.projectId;
  let nextProjectSnapshot = runtime.currentProjectSnapshot;
  let nextSuggestion: ComposerQuestion | null = null;
  let lastAction = finalAction;
  const summaries: string[] = [];

  try {
    for (const step of steps) {
      const stepRuntime = nextRuntime;
      const stepOnProgress = (partial: WorkflowActionResult) => {
        if (shortcutProgressLabel && partial.summary?.trim()) {
          dispatchWorkflowShortcutProgressEvent(finalAction, "progress", partial.summary.trim());
        }
        if (partial.data) {
          const partialRuntime = mergeRuntimeWithWorkflowDelta(stepRuntime, partial.data, {
            deferRecentProjectUpsert,
          });
          ui.commitRuntime(partialRuntime, partial.data.projectSnapshot?.projectId);
        }
      };
      const result = await runAction(step.action, step.input, nextRuntime, stepOnProgress);
      const stepSnapshot = result.projectSnapshot ?? result.data?.projectSnapshot ?? null;

      lastAction = step.action;
      nextProjectSnapshot = stepSnapshot ?? nextProjectSnapshot;

      if (result.data) {
        nextRuntime = mergeRuntimeWithWorkflowDelta(nextRuntime, result.data, {
          deferRecentProjectUpsert,
        });
        nextProjectId = stepSnapshot?.projectId ?? nextProjectId;
      }

      nextSuggestion = stepSnapshot ? ui.getSuggestedQuestion(stepSnapshot, nextRuntime) : nextSuggestion;

      if (
        (shouldAlwaysShowWorkflowAssistantSummary(step.action) || !hasInlineMediaOutput(result)) &&
        !shouldSuppressWorkflowAssistantSummary(step.action) &&
        result.summary.trim()
      ) {
        summaries.push(result.summary.trim());
      }
    }

    ui.commitRuntime(nextRuntime, nextProjectId);

    const joinedSummary = summaries.join("\n\n");
    pushWorkflowAssistantSummary({
      action: lastAction,
      input: steps.at(-1)?.input ?? {},
      ui,
      previousSnapshot: runtime.currentProjectSnapshot,
      nextSnapshot: nextProjectSnapshot,
      summary: joinedSummary,
    });

    const pendingFollowup = updateWorkflowSuggestionUi({
      action: lastAction,
      allowAutoFollowup,
      nextProjectSnapshot,
      nextSuggestion,
      ui,
      surfaceNextSuggestion,
    });

    return {
      action: lastAction,
      summary: joinedSummary,
      runtime: nextRuntime,
      projectSnapshot: nextProjectSnapshot ?? null,
      nextSuggestion,
      pendingFollowup,
    };
  } catch (error) {
    onError?.();
    if (isAbortLikeWorkflowError(error)) {
      return null;
    }
    const normalizedMessage = normalizeWorkflowShortcutError(error);
    if (summaries.length > 0) {
      pushWorkflowAssistantSummary({
        action: lastAction,
        input: steps.at(-1)?.input ?? {},
        ui,
        previousSnapshot: runtime.currentProjectSnapshot,
        nextSnapshot: nextProjectSnapshot,
        summary: summaries.join("\n\n"),
      });
    }
    if (surfaceNextSuggestion) {
      const fallbackSuggestion = nextProjectSnapshot
        ? ui.getSuggestedQuestion(nextProjectSnapshot, nextRuntime)
        : runtime.currentProjectSnapshot
          ? ui.getSuggestedQuestion(runtime.currentProjectSnapshot, runtime)
          : null;
      if (fallbackSuggestion) {
        if (shouldReopenPopoverForVideoWorkflowGate({
          message: normalizedMessage,
          snapshot: nextProjectSnapshot ?? runtime.currentProjectSnapshot,
          nextSuggestion: fallbackSuggestion,
        })) {
          ui.setPopoverQuestion(fallbackSuggestion, nextProjectSnapshot ?? runtime.currentProjectSnapshot);
          ui.setSuggested(null);
        } else {
          ui.setSuggested(fallbackSuggestion);
        }
      }
    }
    if (isTimeoutLikeWorkflowError(error)) {
      onErrorMessage?.(normalizedMessage, error);
    }
    ui.pushAssistant(normalizedMessage);
    return null;
  } finally {
    if (shortcutProgressLabel) {
      dispatchWorkflowShortcutProgressEvent(finalAction, "complete", "");
    }
    ui.setStreaming(false);
  }
}
