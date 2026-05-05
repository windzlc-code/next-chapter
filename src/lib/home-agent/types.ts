import type {
  CharacterStateCard,
  ComplianceStrictness,
  ComplianceReviewMode,
  ComplianceRevisionPacket,
  ComplianceWorkspace,
  DramaProject,
  DramaSetup,
  EpisodeGenerationStatus,
  EpisodeEntry,
  EpisodeQualityReviewBatch,
  ExportPatchPlan,
  EpisodeQualityReviewPacket,
  EpisodeScript,
  OutlineBatchStatus,
  StoryBeatPacket,
} from "@/types/drama";
import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import type { AskUserQuestionRequest } from "@/lib/agent/tools/ask-user-question";
import type { ChatAttachment } from "@/lib/agent/chat-attachments";
import type {
  ProductionAssetManifest,
  VideoShotPacket,
  VideoStyleLock,
  VideoWorldModel,
  VideoGenerationModelKey,
  VideoGenerationPrefs,
  VideoImageGenerationPrefs,
  VideoImageModelFamilyKey,
} from "@/types/project";

export type AgentConversationMode = "idle" | "active" | "recovering" | "maintenance-review";
export type CreationMode = "creative" | "fast" | "pro";
/** @deprecated Legacy single-switch mode kept only for session migration compatibility. */
export type AgentControlMode = "llm" | "script-dev";
export type ConversationProjectKind = "script" | "adaptation" | "video";
export type AutomationMode = "manual" | "full-auto";
export type FullAutoRunStatus =
  | "idle"
  | "collecting"
  | "running"
  | "retrying"
  | "paused"
  | "stopped"
  | "completed"
  | "failed";
export type FullAutoRunStepStatus = "pending" | "running" | "retrying" | "stopped" | "completed" | "failed";

export interface FullAutoStageStrategy {
  key: string;
  phase: string;
  value: string;
  label: string;
}

export interface FullAutoRunStep {
  id: string;
  label: string;
  phase?: string;
  status: FullAutoRunStepStatus;
  strategyKey?: string;
  strategyValue?: string;
  workflowAction?: string;
}

export interface FullAutoRunPlan {
  id: string;
  projectKind: ConversationProjectKind;
  entryTemplateId: string;
  mode: "original-script-v1";
  createdAt: string;
  setupInput?: Record<string, unknown>;
  userBubble?: string;
  structuredSummary?: string;
  answers: Record<string, string | string[]>;
  displayAnswers: Record<string, string>;
  collectedAnswers?: Record<string, string | string[]>;
  stageStrategies?: Record<string, FullAutoStageStrategy>;
  plannedSteps?: FullAutoRunStep[];
  steps: FullAutoRunStep[];
  currentStepIndex: number;
  resumeFromStepId?: string;
  stoppedStepId?: string;
  retryCounts: Record<string, number>;
}

export interface FullAutoRunState {
  status: FullAutoRunStatus;
  plan: FullAutoRunPlan | null;
  currentStepIndex: number;
  currentStepLabel?: string;
  lastError?: string;
  stoppedByUser?: boolean;
}
export type ArtifactKind =
  | "setup"
  | "dramaSetup"
  | "reference"
  | "plan"
  | "characters"
  | "scene-settings"
  | "directory"
  | "outline"
  | "episode"
  | "episode-review"
  | "compliance"
  | "export"
  | "video-brief"
  | "storyboard-plan"
  | "video-prompt-batch"
  | "world-model"
  | "style-lock"
  | "character-card"
  | "beat-packet"
  | "compliance-revision"
  | "asset-manifest"
  | "shot-packet"
  | "review"
  | "report";

export interface ConversationArtifactAction {
  id: string;
  label: string;
  value: string;
  description?: string;
  variant?: "primary" | "secondary" | "ghost";
  disabled?: boolean;
}

export type ConversationArtifactEditorField =
  | "creativePlan"
  | "structureTransform"
  | "characters"
  | "characterTransform"
  | "directoryRaw"
  | "outlines";

export interface ConversationArtifactEditor {
  field: ConversationArtifactEditorField;
  text: string;
}

type ScriptArtifactPayloadCommon = {
  patchPlan?: ExportPatchPlan;
  complianceStatus?: "reviewed" | "skipped" | "pending";
  workspace?: ComplianceWorkspace;
  skippedAt?: string | null;
  quickExportMarkdown?: string;
};

export type ScriptArtifactPayload = (
  | {
      type: "setup";
      mode: DramaProject["mode"];
      marketLabel: string;
      audience: string;
      tone: string;
      ending: string;
      totalEpisodes: number;
      genres: string[];
      targetMarket?: string;
      customTopic?: string;
      referenceStructure?: string;
      adaptationEpisodeCountConfirmed?: boolean;
      adaptationTargetMarketConfirmed?: boolean;
      adaptationGenresConfirmed?: boolean;
    }
  | {
      type: "characters+mermaid";
      body: string;
      mermaidCode?: string;
      detailedMermaidCode?: string;
      characterCards?: CharacterStateCard[];
      diagramCollapsed?: boolean;
    }
  | {
      type: "directory+stats";
      entries: Array<
        Pick<
          EpisodeEntry,
          "number" | "title" | "summary" | "hookType" | "isKey" | "isClimax" | "isPaywall" | "emotionLevel"
        >
      >;
      stats: {
        totalEpisodes: number;
        outlinedEpisodes: number;
        writtenEpisodes: number;
        keyEpisodes: number;
        climaxEpisodes: number;
        paywallEpisodes: number;
      };
    }
  | {
      type: "outlines+batchProgress";
      totalEpisodes: number;
      entries: Array<
        Pick<
          EpisodeEntry,
          | "number"
          | "title"
          | "summary"
          | "outline"
          | "hookType"
          | "isKey"
          | "isClimax"
          | "isPaywall"
          | "emotionLevel"
        >
      >;
      batchProgress: {
        total: number;
        done: number;
        failed: number;
        processing: number;
        percent: number;
        batches: OutlineBatchStatus[];
      };
      editorText?: string;
    }
  | {
      type: "episodeReview";
      packets: EpisodeQualityReviewPacket[];
      batch?: EpisodeQualityReviewBatch | null;
      allPacketsCount?: number;
      episodes: Array<Pick<EpisodeScript, "number" | "title" | "wordCount">>;
      summary: {
        reviewedCount: number;
        averageTotal: number;
        highestEpisodeNumber?: number;
        lowestEpisodeNumber?: number;
        riskCounts: {
          blocking: number;
          warning: number;
          suggestion: number;
        };
        dimensionAverages: Record<
          "rhythm" | "satisfaction" | "dialogue" | "format" | "continuity",
          number
        >;
      };
    }
  | {
      type: "episodes+batchProgress";
      totalEpisodes: number;
      durationSeconds?: number | null;
      entries: Array<
        Pick<EpisodeEntry, "number" | "title" | "summary" | "outline"> & {
          status: EpisodeGenerationStatus["status"];
          wordCount?: number;
          content?: string;
        }
      >;
      batchProgress: {
        total: number;
        done: number;
        failed: number;
        processing: number;
        percent: number;
        batches?: OutlineBatchStatus[];
      };
    }
  | {
      type: "complianceSummary";
      mode: ComplianceReviewMode;
      strictness?: ComplianceStrictness;
      report: string;
      packets: ComplianceRevisionPacket[];
      workspace?: ComplianceWorkspace;
      skippedAt?: string | null;
      counts: {
        redLine: number;
        highRisk: number;
        suggestion: number;
        pendingPackets: number;
      };
    }
  | {
      type: "exportSummary";
      dramaTitle: string;
      completedEpisodes: number;
      totalEpisodes: number;
      totalWordCount: number;
      quickExportMarkdown: string;
      exportDocument?: string;
      creativePlan: string;
      characters: string;
      episodes: EpisodeScript[];
      setup: DramaSetup | null;
      patchPlan?: ExportPatchPlan;
      complianceStatus: "reviewed" | "skipped" | "pending";
      skippedAt?: string | null;
    }
) & ScriptArtifactPayloadCommon;

export interface ComposerQuestionOption {
  id: string;
  label: string;
  value: string;
  rationale?: string;
  selected?: boolean;
  disabled?: boolean;
  children?: ComposerQuestionOption[];
  childInput?: {
    type: "number" | "text";
    actionPrefix: string;
    buttonLabel?: string;
    labelTemplate?: string;
    max?: number;
    min?: number;
    maxLength?: number;
    minLength?: number;
    placeholder?: string;
    pattern?: string;
    suffix?: string;
  };
  /** 点击时弹出确认对话框，用户确认后才执行提交 */
  confirmDialog?: {
    title: string;
    description: string;
    confirmLabel?: string;
    cancelLabel?: string;
    /** 在弹窗中展示的配置清单，每项为一行 "标签：值" */
    summaryRows?: string[];
  };
  /** 开发者专属选项：关闭 devMode 时隐藏，开启时移至面板底部 dev 区 */
  devOnly?: boolean;
}

export interface ComposerQuestion {
  id: string;
  title: string;
  description?: string;
  options: ComposerQuestionOption[];
  presentation?: "auto" | "chip" | "card";
  allowCustomInput: boolean;
  submissionMode: "immediate" | "confirm";
  multiSelect: boolean;
  stepIndex: number;
  totalSteps: number;
  answerKey: string;
  /** 步骤指示器下方的小徽章，用于显示风险/待修订数量等状态 */
  statusBadges?: Array<{ label: string; value: string | number; tone: "default" | "warning" | "danger" }>;
}

export interface ConversationArtifact {
  id: string;
  kind: ArtifactKind;
  label: string;
  summary: string;
  content?: string;
  updatedAt: string;
  presentation?: "plain" | "script-rich";
  payload?: ScriptArtifactPayload;
  actions?: ConversationArtifactAction[];
  editor?: ConversationArtifactEditor;
}

export type ConversationMemoryKind =
  | "project-summary"
  | "conversation-summary"
  | "artifact"
  | "maintenance-report"
  | "skill-draft";

export interface ConversationVideoSceneMemory {
  id: string;
  sceneNumber: number;
  sceneName: string;
  segmentLabel?: string;
  videoStatus?: string;
  videoTaskId?: string;
  videoUrl?: string;
  videoFailureMessage?: string;
}

export interface ConversationMemoryDocument {
  id: string;
  projectId?: string;
  projectKind?: ConversationProjectKind;
  title: string;
  kind: ConversationMemoryKind;
  text: string;
  summary: string;
  updatedAt: string;
  tags: string[];
}

export interface ConversationProjectSnapshot {
  projectId: string;
  projectKind: ConversationProjectKind;
  automationMode?: AutomationMode;
  pinned?: boolean;
  title: string;
  currentObjective: string;
  derivedStage: string;
  agentSummary: string;
  recommendedActions: string[];
  artifacts: ConversationArtifact[];
  updatedAt?: string;
  memory?: {
    styleLock?: VideoStyleLock | null;
    worldModel?: VideoWorldModel | null;
    assetManifest?: ProductionAssetManifest | null;
    videoScenes?: ConversationVideoSceneMemory[];
    shotPackets?: VideoShotPacket[];
    reviewQueue?: Array<{
      id: string;
      title: string;
      summary: string;
      targetIds: string[];
      status: string;
      createdAt: string;
      updatedAt: string;
    }>;
    characterStateCards?: CharacterStateCard[];
    storyBeatPackets?: StoryBeatPacket[];
    complianceRevisionPackets?: ComplianceRevisionPacket[];
    episodeQualityReviewPackets?: EpisodeQualityReviewPacket[];
  };
}

export interface SkillDraft {
  id: string;
  sourceConversationIds: string[];
  proposedSkillName: string;
  proposedContent: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "superseded";
  createdAt: string;
}

export interface MaintenanceReport {
  id: string;
  createdAt: string;
  summary: string;
  compressedConversationCount: number;
  archivedProjectCount: number;
  clearedCacheKeys: string[];
  mergedDraftCount: number;
  notes: string[];
}

export interface HomeAgentMessage {
  id: string;
  role: "assistant" | "user" | "system";
  content: string;
  createdAt: string;
  status?: "pending" | "complete";
  streamLabel?: string;
  /** Local thumbs rating for assistant replies; persisted with session. */
  feedback?: "up" | "down";
  /** IDs of artifacts created or updated by this assistant message. */
  artifactIds?: string[];
  /** Frozen artifact snapshots bound to this message so later workflow steps cannot reshuffle them. */
  artifactSnapshots?: ConversationArtifact[];
  /** Attachments bound to this user message. */
  attachments?: ChatAttachment[];
  /** Marks a user-like message generated by the full-auto runner. */
  automationOrigin?: "full-auto";
}

export interface StudioQuestionState {
  source?: "live" | "restored" | "deferred";
  request: AskUserQuestionRequest;
  currentIndex: number;
  answers: Record<string, string>;
  displayAnswers: Record<string, string>;
}

export interface WorkflowActionResult {
  summary: string;
  artifact?: ConversationArtifact;
  projectSnapshot?: ConversationProjectSnapshot;
  recommendedActions?: string[];
  data?: WorkflowRuntimeDelta;
  /** 本次 action 新生成的图片 URL 列表，供聊天框直接展示 */
  imageUrls?: string[];
  /** 与 imageUrls 一一对应的人类可读标签，如"角色 · 沈昭 · 版本01" */
  imageLabels?: string[];
  /** 本次 action 新生成的视频 URL 列表，供聊天框直接展示 */
  videoUrls?: string[];
}

export type WorkflowActionProgressCallback = (partial: WorkflowActionResult) => void;

export interface WorkflowAction {
  id: string;
  kind: string;
  run: (
    input: Record<string, unknown>,
    context: StudioRuntimeState,
    onProgress?: WorkflowActionProgressCallback,
  ) => Promise<WorkflowActionResult>;
}

export interface WorkflowRuntimeDelta {
  dramaProject?: DramaProject | null;
  videoProject?: PersistedVideoProject | null;
  projectSnapshot?: ConversationProjectSnapshot | null;
  skillDrafts?: SkillDraft[];
  maintenanceReports?: MaintenanceReport[];
  recentMessageSummary?: string;
}

export interface AgentConversationShellState {
  mode: AgentConversationMode;
  composerState: {
    draft: string;
    isStreaming: boolean;
    placeholder: string;
  };
  popoverQuestion: ComposerQuestion | null;
  messages: HomeAgentMessage[];
  currentProjectSnapshot: ConversationProjectSnapshot | null;
  rightRailState: {
    recentProjects: ConversationProjectSnapshot[];
    skillDrafts: SkillDraft[];
    maintenanceReports: MaintenanceReport[];
  };
}

export interface StudioSessionState {
  sessionId?: string;
  compactedMessageCount?: number;
  mode: AgentConversationMode;
  creationMode?: CreationMode;
  automationMode?: AutomationMode;
  devMode?: boolean;
  /** @deprecated Legacy session field kept only for restoring old sessions. */
  agentControlMode?: AgentControlMode;
  messages: HomeAgentMessage[];
  currentProjectSnapshot: ConversationProjectSnapshot | null;
  recentMessageSummary: string;
  projectId?: string;
  selectedTextModelKey?: string;
  selectedImageModelFamily?: VideoImageModelFamilyKey;
  imageGenerationPrefs?: VideoImageGenerationPrefs;
  selectedVideoModelKey?: VideoGenerationModelKey;
  videoGenerationPrefs?: VideoGenerationPrefs;
  draft?: string;
  qState?: StudioQuestionState | null;
  deferredQuestionState?: StudioQuestionState | null;
  pendingChoiceQuestion?: ComposerQuestion | null;
  selectedValues?: string[];
  deferredSelectedValues?: string[];
  deferredDraft?: string;
  surfacedTaskIds?: string[];
  surfacedTaskFollowupKeys?: string[];
  surfacedProjectSuggestionKeys?: string[];
  fullAutoRun?: FullAutoRunState | null;
}

export interface StudioRuntimeState {
  sessionId: string;
  currentProjectSnapshot: ConversationProjectSnapshot | null;
  currentDramaProject: DramaProject | null;
  currentVideoProject: PersistedVideoProject | null;
  currentSetupDraft: DramaSetup | null;
  skillDrafts: SkillDraft[];
  maintenanceReports: MaintenanceReport[];
  recentProjects: ConversationProjectSnapshot[];
  recentProjectSessions?: StudioSessionState[];
  recentMessageSummary: string;
  fullAutoRun?: FullAutoRunState | null;
}
