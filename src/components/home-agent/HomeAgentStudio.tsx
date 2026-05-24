import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { flushSync } from "react-dom";
import {
  Wand2,
  Compass,
  PanelsTopLeft,
  X,
} from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import type { QueryEngine } from "@/lib/agent/query-engine";
import {
  buildMessageInputFromAttachments,
  inferModelInputCapabilities,
  prepareChatAttachments,
  stripAttachmentPayloadForHistory,
  type ChatAttachment,
} from "@/lib/agent/chat-attachments";
import { buildResearchPromptOverlay } from "@/lib/home-agent/auto-research";
import type {
  AgentConversationMode,
  AutomationMode,
  ComposerQuestion,
  ConversationProjectSnapshot,
  CreationMode,
  HomeAgentMessage,
  PendingWorkflowUploadKind,
  StudioQuestionState,
  StudioRuntimeState,
  StudioSessionState,
  WorkflowRuntimeDelta,
} from "@/lib/home-agent/types";
import { cn } from "@/lib/utils";
import type { JimengExecutionMode } from "@/lib/api-config";
import { API_CONFIG_UPDATED_EVENT } from "@/lib/api-config";
import {
  buildGeneratedMediaFallbackName,
  buildMediaContentSummary,
  buildPendingMediaAttachmentName,
  localizeMediaSettingValue,
} from "@/lib/home-agent/media-generation-copy";
import {
  ActiveConversationShell,
  HOME_AGENT_DESKTOP_LAYOUT_INVALIDATE_EVENT,
  HomeSurfaceBackdrop,
  IdleLanding,
  MobileTopbar,
} from "./home-agent-shell";
import HomeAgentConfirmDialog from "./HomeAgentConfirmDialog";
import {
  createAutomationModeProjectMemory,
  areProjectSnapshotsEquivalent,
  areRecentSessionsEquivalent,
  buildProjectSuggestionKey,
  createInitialStudioSeed,
  didSessionScopedProjectSwitch,
  hasSavedSessionContent,
  HOME_AGENT_HISTORY_DISPLAY_LIMIT,
  mergeRecentProjects,
  qStepKey,
  reconcileRecentProjectsWithStableOrder,
  rememberProjectForAutomationMode,
  resolveSessionProjectIdForSnapshot,
  resolveComposerDraftSnapshot,
  resolvePendingWorkflowUploadKind,
  selectRecentProjectForAutomationMode,
  upsertRecentProjectSession,
} from "./home-agent-session-utils";
import { createQuestionState, textOf, toQuery } from "./home-agent-protocol-utils";
import {
  buildBeatPacketDecisionQuestion,
  buildBeatPacketListQuestion,
  buildVideoBridgeQuestion,
  buildVideoBridgePrefixQuestion,
  buildCharacterCardDecisionQuestion,
  buildCharacterCardListQuestion,
  buildComplianceDecisionQuestion,
  buildComplianceListQuestion,
  buildEpisodeWorkflowQuestion,
  buildEpisodeDurationGateQuestion,
  buildOutlinesWorkflowQuestion,
  buildVideoGenerationQuestion,
  buildVideoGenerationSceneListQuestion,
  recQuestion,
  findBeatPacket,
  findCharacterCard,
  findCompliancePacket,
  listFailedVideoScenes,
  listGeneratableVideoScenes,
  listPendingCompliancePackets,
  listRunningSegmentVideoLabels,
  listRunningVideoScenes,
  listUnlockedBeatPackets,
  listUnlockedCharacterCards,
} from "./home-agent-project-questions";
import {
  resolveInterruptedWorkflowQuestion,
  shouldRestoreLastSuggestedAfterInterrupt,
} from "./home-agent-interrupt-recovery";
import {
  DesktopSettingsPanel,
  MobileSettingsSheet,
} from "./home-agent-settings-panels";
import {
  useHomeAgentModuleLoaders,
  type ProjectStoreModule,
} from "./use-home-agent-module-loaders";
import { mergeRuntimeWithWorkflowDelta } from "@/lib/home-agent/workflow-shortcut-runner";
import { useHomeAgentBootstrapEffects } from "./use-home-agent-bootstrap-effects";
import { useHomeAgentChoiceHandlers } from "./use-home-agent-choice-handlers";
import type { ExportLocalAction } from "./home-agent-script-choice-handlers";
import { useHomeAgentConversationEffects } from "./use-home-agent-conversation-effects";
import {
  isBridgeableVideoWorkflowSourceSnapshot,
  replacePlaceholderRecentProject,
  useHomeAgentRuntimeActions,
  waitForAbortableDelay,
} from "./use-home-agent-runtime-actions";
import { useHomeAgentRecoveryFlow } from "./use-home-agent-recovery-flow";
import { useHomeAgentQuestionView } from "./use-home-agent-question-view";
import { useHomeAgentShellHandlers } from "./use-home-agent-shell-handlers";
import { useHomeAgentSurfaceState } from "./use-home-agent-surface-state";
import type { HomeAgentMaintenanceHintNotice } from "./use-home-agent-surface-state";
import { useHomeAgentLastSessionRecovery } from "./use-home-agent-last-session-recovery";
import {
  areTaskListsEquivalent,
  buildTaskResultMessage,
  isTaskVisibleForSession,
  parseTaskHeading,
  truncateCopy,
} from "./home-agent-task-utils";
import { useHomeAgentWorkflowShortcuts } from "./use-home-agent-workflow-shortcuts";
import { useHomeAgentComposerBindings } from "./use-home-agent-composer-bindings";
import { shouldForceSilentWorkflowShortcut } from "./workflow-shortcut-silence";
import { getAllTasks, stopTask, type Task } from "@/lib/agent/tools/task-tools";
import type { CreationGuideDimensionId } from "@/lib/home-agent/creation-guide-presets";
import { recordAssistantFeedbackLog } from "@/lib/home-agent/assistant-feedback-log";
import { readHomeAgentLaunchReadiness, type HomeAgentLaunchReadiness } from "@/lib/home-agent/launch-readiness";
import {
  getHomeAgentTextModelOption,
  groupHomeAgentTextModelOptions,
  normalizeHomeAgentTextModelKey,
  readStoredHomeAgentTextModelKey,
  resolveHomeAgentTextModelRuntime,
  writeStoredHomeAgentTextModelKey,
} from "@/lib/home-agent/text-models";
import {
  applyVideoImageViewModeConstraints,
  DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
  buildVideoImageGenerationSummary,
  buildVideoImageStyleSummary,
  getHomeAgentImageModelFamilyOption,
  listHomeAgentImageModelFamilies,
  normalizeHomeAgentImageModelFamilyKey,
  normalizeVideoImageGenerationPrefs,
  readStoredHomeAgentImageGenerationPrefs,
  resolveVideoImageProjectArtStyle,
  writeStoredHomeAgentImageGenerationPrefs,
} from "@/lib/home-agent/image-models";
import {
  DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
  getHomeAgentVideoModelOption,
  listHomeAgentVideoModels,
  normalizeHomeAgentVideoModelKey,
  normalizeVideoGenerationPrefs,
  readStoredHomeAgentVideoGenerationPrefs,
  writeStoredHomeAgentVideoGenerationPrefs,
} from "@/lib/home-agent/video-models";
import {
  analyzeHomeAgentImageStyleFiles,
  buildImagePrefsPatchFromRecognition,
  type HomeAgentImageStyleRecognitionResult,
  isSupportedImageFile,
} from "@/lib/home-agent/image-style-analysis";
import { buildQuickExportMarkdown } from "@/lib/home-agent/script-artifact-helpers";
import {
  HOME_AGENT_WORKFLOW_RUNTIME_DELTA_EVENT,
  type HomeAgentWorkflowRuntimeDeltaDetail,
} from "@/lib/home-agent/workflow-runtime-events";
import {
  VIDEO_WORKFLOW_TEMPLATE_ID,
  buildVideoWorkflowKickoffIntro,
  buildVideoWorkflowKickoffRequest,
} from "@/lib/home-agent/video-workflow-kickoff";
import {
  loadStoredVideoProjectById,
  upsertStoredVideoProject,
  type PersistedVideoProject,
} from "@/hooks/use-local-persistence";
import { useSmartScroll } from "@/hooks/use-smart-scroll";
import {
  exportChatHistory,
  importChatHistory,
  importChatHistoryAsNewProject,
  parseChatHistoryPreview,
  recordLastExportedChatHistory,
  revealExportedChatHistoryFile,
  type ChatHistoryPreview,
} from "@/lib/home-agent/chat-history-io";
import {
  hasSessionResetMarkerForProject,
  listStudioProjectSessions,
  readStudioSession,
  readProjectSessionFromFile,
  readStudioProjectSession,
  queueStudioSessionWrite,
  writeProjectStudioSession,
  writeStudioSession,
} from "@/lib/home-agent/session-store";
import {
  HOME_AGENT_AUTOMATION_MODE_EVENT,
  normalizeAutomationMode,
  readStoredAutomationMode,
} from "@/lib/home-agent/automation-mode";
import {
  CHARACTER_AUDIO_PRESET_PICKER_ANSWER_KEY,
  buildCharacterAudioPresetPickerQuestion,
  loadCharacterAudioPresetLibrary,
  type CharacterAudioPresetBindSelection,
} from "@/lib/home-agent/character-audio-preset-library";
import type {
  VideoGenerationModelKey,
  VideoGenerationPrefs,
  VideoImageGenerationPrefs,
  VideoImageModelFamilyKey,
  ProductionAssetManifest,
  ProductionAssetRecord,
} from "@/types/project";
import {
  isLocalSidebarAssetUrl,
  type SidebarAssetItem,
} from "./home-agent-sidebar-utils";
import { resolveArtifactSnapshots } from "@/lib/home-agent/message-artifact-snapshots";
import {
  cacheProjectVideoSource,
  resolveVideoAttachmentSource,
} from "@/lib/home-agent/video-cache";
import { synchronizeVideoProductionState } from "@/lib/home-agent/video-production-memory";
import {
  isExpiredRemoteSignedMediaUrl,
  isMediaAssetDefinitelyMissing,
  isKnownPlaceholderMediaUrl,
  resolveLocalMediaPreviewDataUrl,
} from "@/lib/home-agent/media-url";
const { useCallback, useEffect, useMemo, useRef, useState, startTransition } = React;
type DesktopSidebarProps = React.ComponentProps<typeof import("./home-agent-sidebar")["DesktopSidebar"]>;
type MobileSidebarSheetProps = React.ComponentProps<typeof import("./home-agent-sidebar")["MobileSidebarSheet"]>;

const LazyDesktopSidebar = React.lazy(async () => {
  const mod = await import("./home-agent-sidebar");
  return { default: mod.DesktopSidebar };
});
const LazyMobileSidebarSheet = React.lazy(async () => {
  const mod = await import("./home-agent-sidebar");
  return { default: mod.MobileSidebarSheet };
});

let videoWorkflowServiceModulePromise:
  | Promise<typeof import("@/lib/home-agent/services/video-workflow-service")>
  | null = null;

function loadVideoWorkflowService() {
  if (!videoWorkflowServiceModulePromise) {
    videoWorkflowServiceModulePromise = import("@/lib/home-agent/services/video-workflow-service");
  }
  return videoWorkflowServiceModulePromise;
}

type UtilityPanelId = "settings" | undefined;
type ActiveVideoProject = NonNullable<StudioRuntimeState["currentVideoProject"]>;
type AssetLibraryImageSubTab = "角色" | "场景" | "分镜" | "其他";
type AssetLibraryTarget = {
  action:
    | "generate_video_reference_assets"
    | "generate_storyboard_frames"
    | "generate_video_assets"
    | "generate_project_image"
    | "generate_segment_video"
    | "replace_segment_video";
  projectId?: string;
  targetId?: string;
  regenerateMode?: "generate" | "redo-and-generate";
};
type AssetLibraryEventDetail = {
  url?: string;
  localPath?: string;
  fileName?: string;
  kind?: "image" | "video";
  files?: File[];
  target?: AssetLibraryTarget;
  preferredTab?: "image" | "video";
  preferredImageSubTab?: AssetLibraryImageSubTab;
  isHistoricalVersion?: boolean;
  historyEntryId?: string;
};
type IncomingAssetItem = {
  url: string;
  fileName: string;
  kind: "image" | "video";
  target?: AssetLibraryTarget;
  preferredTab?: "image" | "video";
  preferredImageSubTab?: AssetLibraryImageSubTab;
  isHistoricalVersion?: boolean;
  historyEntryId?: string;
};
type PendingWorkflowPopoverAfterAssistantReply = {
  question: ComposerQuestion;
  lastAssistantMessageId: string | null;
  projectId: string | null;
};
type PendingDeferredQuestionRestoreAfterAssistantReply = {
  stepKey: string;
  lastAssistantMessageId: string | null;
  projectId: string | null;
};
type PendingCharacterAudioUploadRestoreContext = {
  question: ComposerQuestion | null;
  qState: StudioQuestionState | null;
  selectedValues: string[];
  draft: string;
};
type PendingCharacterAudioUploadRequest = {
  label: string;
  characterId: string;
  characterName?: string;
  restoreQuestion?: ComposerQuestion | null;
  restoreContext?: PendingCharacterAudioUploadRestoreContext | null;
};
type CharacterAudioPresetPickerRequest = {
  characterId: string;
  characterName?: string;
  restoreQuestion?: ComposerQuestion | null;
};

type SubmittedStyleReferenceRecognitionResult =
  HomeAgentImageStyleRecognitionResult & {
    handledLocally?: boolean;
  };

const STYLE_REFERENCE_RECOGNITION_TIMEOUT_MS = 12_000;

function DesktopSidebarFallback({
  collapsed,
  expandedWidth,
  collapsedWidth,
}: Pick<DesktopSidebarProps, "collapsed" | "expandedWidth" | "collapsedWidth">) {
  const width = collapsed ? collapsedWidth : expandedWidth;
  return (
    <aside
      aria-hidden="true"
      className="fixed inset-y-0 left-0 z-40 hidden border-r border-border/60 bg-background/70 backdrop-blur-sm lg:block"
      style={{ width }}
    >
      <div className="flex h-full animate-pulse flex-col gap-3 px-3 py-4">
        <div className="h-10 rounded-2xl bg-muted/70" />
        <div className="h-9 rounded-xl bg-muted/50" />
        <div className="h-9 rounded-xl bg-muted/45" />
        <div className="h-9 rounded-xl bg-muted/40" />
      </div>
    </aside>
  );
}

function MobileSidebarFallback({
  open,
}: Pick<MobileSidebarSheetProps, "open">) {
  if (!open) return null;

  return (
    <div aria-hidden="true" className="fixed inset-0 z-50 lg:hidden">
      <div className="absolute inset-0 bg-black/58" />
      <div className="absolute inset-y-0 left-0 w-full max-w-[440px] border-r border-border bg-background p-4 shadow-[18px_0_48px_rgba(0,0,0,0.4)]">
        <div className="flex animate-pulse flex-col gap-3">
          <div className="h-10 rounded-2xl bg-muted/70" />
          <div className="h-9 rounded-xl bg-muted/50" />
          <div className="h-9 rounded-xl bg-muted/45" />
          <div className="h-9 rounded-xl bg-muted/40" />
        </div>
      </div>
    </div>
  );
}

function projectMatchesAutomationMode(
  snapshot: Pick<ConversationProjectSnapshot, "automationMode"> | null | undefined,
  mode: AutomationMode,
): boolean {
  if (!snapshot) return false;
  return normalizeAutomationMode(snapshot?.automationMode) === mode;
}

export function resolveModeIsolationAction(params: {
  currentSnapshot: Pick<ConversationProjectSnapshot, "projectId" | "automationMode"> | null | undefined;
  targetMode: AutomationMode;
  nextProjectId?: string | null;
  activeProjectId?: string | null;
  hasMessages: boolean;
  hasDraft: boolean;
  mode: "idle" | "active" | "recovering" | "maintenance-review";
}): { type: "activate-mode-only" | "open-project" | "reset-home"; projectId?: string } {
  const {
    currentSnapshot,
    targetMode,
    nextProjectId = null,
    activeProjectId = null,
    hasMessages,
    hasDraft,
    mode,
  } = params;

  if (projectMatchesAutomationMode(currentSnapshot, targetMode)) {
    return { type: "activate-mode-only" };
  }

  if (nextProjectId) {
    return nextProjectId !== currentSnapshot?.projectId
      ? { type: "open-project", projectId: nextProjectId }
      : { type: "reset-home" };
  }

  const shouldResetHomeSurface = Boolean(
    currentSnapshot ||
    activeProjectId ||
    hasMessages ||
    hasDraft ||
    mode !== "idle",
  );

  return shouldResetHomeSurface ? { type: "reset-home" } : { type: "activate-mode-only" };
}

function decodeMediaFileName(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function collectMediaMatchKeys(...values: Array<string | undefined>): Set<string> {
  const keys = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    keys.add(trimmed.toLowerCase());
    const withoutQuery = trimmed.split("?")[0] || trimmed;
    keys.add(withoutQuery.toLowerCase());
    const withoutFileScheme = withoutQuery.replace(/^file:\/*/i, "");
    keys.add(withoutFileScheme.toLowerCase());
    const baseName = decodeMediaFileName(withoutFileScheme.split(/[\\/]/).pop() || "");
    if (baseName) {
      keys.add(baseName.toLowerCase());
    }
  }
  return keys;
}

function matchesMediaUrl(lookup: Set<string>, ...values: Array<string | undefined>): boolean {
  for (const raw of values) {
    const keys = collectMediaMatchKeys(raw);
    for (const key of keys) {
      if (lookup.has(key)) return true;
    }
  }
  return false;
}

function isHistoricalProjectVideo(project: ActiveVideoProject, candidateUrl: string | undefined): boolean {
  if (!candidateUrl) return false;
  const lookup = collectMediaMatchKeys(candidateUrl);
  for (const scene of project.scenes ?? []) {
    if (matchesMediaUrl(lookup, ...(scene.videoHistory ?? []).map((entry) => entry.videoUrl))) {
      return true;
    }
  }
  return false;
}

function isVideoAssetFile(url: string | undefined, fileName: string | undefined): boolean {
  const value = `${url || ""} ${fileName || ""}`;
  return /\.(mp4|mov|webm|avi|mkv)$/i.test(value);
}

function normalizeAssetLibraryFileName(fileName: string | undefined, url: string): string {
  const fallback = decodeMediaFileName(url.split(/[\\/]/).pop()?.split("?")[0] || "").trim();
  return String(fileName || fallback || "generated").trim() || "generated";
}

function buildImageHistory(
  currentUrl: string | undefined,
  nextUrl: string,
  description: string,
  previousHistory: Array<{ imageUrl: string; description: string; createdAt: string }> | undefined,
) {
  if (!currentUrl || currentUrl === nextUrl) return previousHistory || [];
  if (previousHistory?.some((entry) => entry.imageUrl === currentUrl)) {
    return previousHistory;
  }
  return [
    ...(previousHistory || []),
    {
      imageUrl: currentUrl,
      description,
      createdAt: new Date().toISOString(),
    },
  ];
}

function buildVideoHistory(
  currentUrl: string | undefined,
  nextUrl: string,
  previousHistory: Array<{ videoUrl: string; createdAt: string }> | undefined,
) {
  if (!currentUrl || currentUrl === nextUrl) return previousHistory || [];
  if (previousHistory?.some((entry) => entry.videoUrl === currentUrl)) {
    return previousHistory;
  }
  return [
    ...(previousHistory || []),
    {
      videoUrl: currentUrl,
      createdAt: new Date().toISOString(),
    },
  ];
}

function deriveAssetIdFromTarget(target: AssetLibraryTarget | undefined): string | null {
  if (!target?.targetId) return null;
  if (target.action === "generate_storyboard_frames") {
    return `shot:${target.targetId}:storyboard`;
  }
  if (target.action === "generate_video_assets") {
    return `shot:${target.targetId}:video`;
  }
  if (target.action === "generate_segment_video" || target.action === "replace_segment_video") {
    return target.targetId ? `segment:${target.targetId}` : null;
  }
  if (target.action !== "generate_video_reference_assets") return null;
  if (target.targetId.startsWith("reference-character-variant:")) {
    const [, characterId, costumeId] = target.targetId.split(":");
    return characterId && costumeId ? `char:${characterId}:costume:${costumeId}` : null;
  }
  if (target.targetId.startsWith("reference-character:")) {
    const [, characterId] = target.targetId.split(":");
    return characterId ? `char:${characterId}:primary` : null;
  }
  if (target.targetId.startsWith("reference-scene-variant:")) {
    const [, sceneId, variantId] = target.targetId.split(":");
    return sceneId && variantId ? `scene:${sceneId}:time:${variantId}` : null;
  }
  if (target.targetId.startsWith("reference-scene:")) {
    const [, sceneId] = target.targetId.split(":");
    return sceneId ? `scene:${sceneId}:primary` : null;
  }
  return null;
}

function clearAssetFromVideoProject(
  project: ActiveVideoProject,
  assetId: string,
): ActiveVideoProject {
  const segmentContinuityGridMatch = assetId.match(/^segment:(.+):continuity-grid$/);
  if (segmentContinuityGridMatch) {
    const segmentLabel = segmentContinuityGridMatch[1];
    if (!segmentLabel || !project.segmentContinuityGridImages?.[segmentLabel]) return project;
    const { [segmentLabel]: _removed, ...rest } = project.segmentContinuityGridImages;
    return {
      ...project,
      segmentContinuityGridImages: Object.keys(rest).length ? rest : undefined,
    };
  }

  if (assetId.startsWith("manual:")) {
    return {
      ...project,
      assetManifest: project.assetManifest
        ? {
            ...project.assetManifest,
            items: project.assetManifest.items.filter((item) => item.id !== assetId),
          }
        : project.assetManifest,
    };
  }

  if (assetId.startsWith("segment:")) {
    const segmentLabel = assetId.slice("segment:".length);
    if (!segmentLabel || !project.segmentVideos) return project;
    const { [segmentLabel]: _removed, ...rest } = project.segmentVideos;
    return { ...project, segmentVideos: rest };
  }

  const sceneVideoMatch = assetId.match(/^shot:(.+):video$/);
  if (sceneVideoMatch) {
    const sceneId = sceneVideoMatch[1];
    return {
      ...project,
      scenes: project.scenes.map((scene) =>
        scene.id === sceneId
          ? {
              ...scene,
              videoUrl: undefined,
              videoTaskId: undefined,
              videoProvider: undefined,
              videoStatus: undefined,
              videoFailure: undefined,
            }
          : scene,
      ),
    };
  }

  const sceneStoryboardMatch = assetId.match(/^shot:(.+):storyboard$/);
  if (sceneStoryboardMatch) {
    const sceneId = sceneStoryboardMatch[1];
    return {
      ...project,
      scenes: project.scenes.map((scene) =>
        scene.id === sceneId
          ? {
              ...scene,
              storyboardUrl: undefined,
            }
          : scene,
      ),
    };
  }

  const characterCostumeMatch = assetId.match(/^char:(.+):costume:(.+)$/);
  if (characterCostumeMatch) {
    const [, characterId, costumeId] = characterCostumeMatch;
    return {
      ...project,
      characters: project.characters.map((character) =>
        character.id === characterId
          ? {
              ...character,
              costumes: (character.costumes ?? []).map((costume) =>
                costume.id === costumeId
                  ? {
                      ...costume,
                      imageUrl: undefined,
                    }
                  : costume,
              ),
            }
          : character,
      ),
    };
  }

  const characterPrimaryMatch = assetId.match(/^char:(.+):primary$/);
  if (characterPrimaryMatch) {
    const characterId = characterPrimaryMatch[1];
    return {
      ...project,
      characters: project.characters.map((character) =>
        character.id === characterId
          ? {
              ...character,
              imageUrl: undefined,
            }
          : character,
      ),
    };
  }

  const sceneVariantMatch = assetId.match(/^scene:(.+):time:(.+)$/);
  if (sceneVariantMatch) {
    const [, sceneId, variantId] = sceneVariantMatch;
    return {
      ...project,
      sceneSettings: project.sceneSettings.map((sceneSetting) =>
        sceneSetting.id === sceneId
          ? {
              ...sceneSetting,
              timeVariants: (sceneSetting.timeVariants ?? []).map((variant) =>
                variant.id === variantId
                  ? {
                      ...variant,
                      imageUrl: undefined,
                    }
                  : variant,
              ),
            }
          : sceneSetting,
      ),
    };
  }

  const scenePrimaryMatch = assetId.match(/^scene:(.+):primary$/);
  if (scenePrimaryMatch) {
    const sceneId = scenePrimaryMatch[1];
    return {
      ...project,
      sceneSettings: project.sceneSettings.map((sceneSetting) =>
        sceneSetting.id === sceneId
          ? {
              ...sceneSetting,
              imageUrl: undefined,
            }
          : sceneSetting,
      ),
    };
  }

  return project;
}

export function shouldAutoCleanupInvalidAsset(
  asset: Pick<ProductionAssetRecord, "kind" | "origin">,
): boolean {
  return asset.kind === "video-segment";
}

export function hasSegmentContinuityGridForProject(
  project: Pick<ActiveVideoProject, "segmentContinuityGridImages">,
  segmentLabel: string,
): boolean {
  const normalizedSegmentLabel = String(segmentLabel || "").trim();
  if (!normalizedSegmentLabel) return false;
  return Boolean(project.segmentContinuityGridImages?.[normalizedSegmentLabel]?.imageUrl?.trim());
}

function resolveLocalSegmentContinuityBackfillVideoUrl(
  project: Pick<ActiveVideoProject, "segmentVideos" | "assetManifest">,
  segmentLabel: string,
): string | undefined {
  const normalizedSegmentLabel = String(segmentLabel || "").trim();
  if (!normalizedSegmentLabel) return undefined;

  const directSegmentUrl = String(project.segmentVideos?.[normalizedSegmentLabel] || "").trim();
  if (isLocalSidebarAssetUrl(directSegmentUrl)) return directSegmentUrl;

  const manifestCandidates = (project.assetManifest?.items ?? [])
    .filter((item) => item.kind === "video-segment")
    .filter((item) => {
      const sourceEntityId = String(item.sourceEntityId || "").trim();
      const assetId = String(item.id || "").trim();
      return (
        sourceEntityId === normalizedSegmentLabel ||
        assetId === `segment:${normalizedSegmentLabel}:video`
      );
    })
    .map((item) => String(item.url || "").trim())
    .filter((url) => isLocalSidebarAssetUrl(url));

  return manifestCandidates[0] || undefined;
}

function applyAssetReplacement(
  project: ActiveVideoProject,
  target: AssetLibraryTarget,
  incoming: IncomingAssetItem,
): ActiveVideoProject {
  const nextUrl = incoming.url;
  if (!target.targetId) return project;

  if (target.action === "generate_storyboard_frames") {
    return {
      ...project,
      scenes: project.scenes.map((scene) =>
        scene.id === target.targetId
          ? {
              ...scene,
              storyboardHistory: scene.storyboardUrl && scene.storyboardUrl !== nextUrl
                ? [...(scene.storyboardHistory ?? []), scene.storyboardUrl]
                : scene.storyboardHistory,
              storyboardUrl: nextUrl,
            }
          : scene,
      ),
    };
  }

  if (target.action === "generate_video_assets") {
    return {
      ...project,
      scenes: project.scenes.map((scene) =>
        scene.id === target.targetId
          ? {
              ...scene,
              videoHistory: buildVideoHistory(scene.videoUrl, nextUrl, scene.videoHistory),
              videoUrl: nextUrl,
              videoTaskId: undefined,
              videoProvider: undefined,
              videoStatus: "completed",
              videoFailure: undefined,
            }
          : scene,
      ),
    };
  }

  if (target.action === "generate_segment_video" || target.action === "replace_segment_video") {
    if (!target.targetId) return project;
    return {
      ...project,
      segmentVideos: {
        ...(project.segmentVideos ?? {}),
        [target.targetId]: nextUrl,
      },
    };
  }

  if (target.action !== "generate_video_reference_assets") {
    return project;
  }

  if (target.targetId.startsWith("reference-character-variant:")) {
    const [, characterId, costumeId] = target.targetId.split(":");
    return {
      ...project,
      characters: project.characters.map((character) =>
        character.id === characterId
          ? {
              ...character,
              costumes: (character.costumes ?? []).map((costume) =>
                costume.id === costumeId
                  ? {
                      ...costume,
                      imageHistory: buildImageHistory(
                        costume.imageUrl,
                        nextUrl,
                        "manual asset replacement",
                        costume.imageHistory,
                      ),
                      imageUrl: nextUrl,
                    }
                  : costume,
              ),
            }
          : character,
      ),
    };
  }

  if (target.targetId.startsWith("reference-character:")) {
    const [, characterId] = target.targetId.split(":");
    return {
      ...project,
      characters: project.characters.map((character) =>
        character.id === characterId
          ? {
              ...character,
              imageHistory: buildImageHistory(
                character.imageUrl,
                nextUrl,
                "manual asset replacement",
                character.imageHistory,
              ),
              imageUrl: nextUrl,
            }
          : character,
      ),
    };
  }

  if (target.targetId.startsWith("reference-scene-variant:")) {
    const [, sceneId, variantId] = target.targetId.split(":");
    return {
      ...project,
      sceneSettings: project.sceneSettings.map((sceneSetting) =>
        sceneSetting.id === sceneId
          ? {
              ...sceneSetting,
              timeVariants: (sceneSetting.timeVariants ?? []).map((variant) =>
                variant.id === variantId
                  ? {
                      ...variant,
                      imageHistory: buildImageHistory(
                        variant.imageUrl,
                        nextUrl,
                        "manual asset replacement",
                        variant.imageHistory,
                      ),
                      imageUrl: nextUrl,
                    }
                  : variant,
              ),
            }
          : sceneSetting,
      ),
    };
  }

  if (target.targetId.startsWith("reference-scene:")) {
    const [, sceneId] = target.targetId.split(":");
    return {
      ...project,
      sceneSettings: project.sceneSettings.map((sceneSetting) =>
        sceneSetting.id === sceneId
          ? {
              ...sceneSetting,
              imageHistory: buildImageHistory(
                sceneSetting.imageUrl,
                nextUrl,
                "manual asset replacement",
                sceneSetting.imageHistory,
              ),
              imageUrl: nextUrl,
            }
          : sceneSetting,
      ),
    };
  }

  return project;
}

type LocalScriptExportResult = { status: "saved" } | { status: "cancelled" };
const INLINE_MEDIA_REGENERATE_GUARD_DELAY_MS =
  import.meta.env.MODE === "test" ? 0 : 3000;

function isMissingSaveBinaryHandler(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("storage:saveBinaryFile") && message.includes("No handler registered");
}

function encodeUtf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function sanitizeExportFileName(value: string, fallback: string): string {
  const normalized = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "");
  return normalized || fallback;
}

const CHARACTER_AUDIO_REFERENCE_EXTENSIONS = new Set([
  "mp3",
  "wav",
  "m4a",
  "aac",
  "ogg",
  "flac",
  "opus",
]);

function isSupportedCharacterAudioFile(file: Pick<File, "name" | "type">): boolean {
  const mimeType = String(file.type || "").trim().toLowerCase();
  if (mimeType.startsWith("audio/")) return true;
  const extension = file.name.split(".").pop()?.trim().toLowerCase();
  return Boolean(extension && CHARACTER_AUDIO_REFERENCE_EXTENSIONS.has(extension));
}

export function collectSupportedCharacterAudioFiles<T extends Pick<File, "name" | "type">>(
  files: T[],
): T[] {
  return files.filter(isSupportedCharacterAudioFile);
}

function resolveCharacterAudioReferenceUrl(
  attachment: Pick<ChatAttachment, "localPath" | "mimeType" | "base64">,
): string | undefined {
  const localPath = typeof attachment.localPath === "string" ? attachment.localPath.trim() : "";
  if (localPath) return localPath;
  const base64 = typeof attachment.base64 === "string" ? attachment.base64.trim() : "";
  if (!base64) return undefined;
  const mimeType = attachment.mimeType?.trim() || "application/octet-stream";
  return `data:${mimeType};base64,${base64}`;
}

const PENDING_CHARACTER_AUDIO_RETURN_MENU_VALUE =
  "home:pending-character-audio:return-menu";
const PENDING_CHARACTER_AUDIO_CANCEL_VALUE =
  "home:pending-character-audio:cancel-upload";
const PENDING_CHARACTER_AUDIO_QUESTION_KEY = "pending-character-audio-upload";

function parsePendingCharacterAudioUploadQuestion(
  question: Pick<ComposerQuestion, "id" | "title" | "answerKey"> | null | undefined,
): {
  characterId: string;
  characterName?: string;
  canReturnToMenu: boolean;
} | null {
  if (question?.answerKey !== PENDING_CHARACTER_AUDIO_QUESTION_KEY) {
    return null;
  }

  const parts = question.id.split(":");
  const characterId = parts.at(-2)?.trim();
  const mode = parts.at(-1)?.trim();
  if (!characterId) {
    return null;
  }

  const titleMatch = question.title.match(/《(.+?)》/u);
  const characterName = titleMatch?.[1]?.trim() || undefined;

  return {
    characterId,
    characterName,
    canReturnToMenu: mode === "restore",
  };
}

function markQuestionForExactRestore(
  question: ComposerQuestion | null | undefined,
): ComposerQuestion | null {
  if (!question) return null;
  if (question.preserveExactOnRestore) return question;
  return {
    ...question,
    preserveExactOnRestore: true,
  };
}

function buildPendingCharacterAudioUploadQuestion(params: {
  projectId?: string | null;
  characterId: string;
  characterName?: string;
  canReturnToMenu: boolean;
}): ComposerQuestion {
  const { projectId, characterId, characterName, canReturnToMenu } = params;
  const resolvedCharacterName = characterName?.trim();
  const optionLabel = canReturnToMenu ? "返回菜单" : "取消上传";
  const optionValue = canReturnToMenu
    ? PENDING_CHARACTER_AUDIO_RETURN_MENU_VALUE
    : PENDING_CHARACTER_AUDIO_CANCEL_VALUE;

  return {
    id: `${PENDING_CHARACTER_AUDIO_QUESTION_KEY}:${projectId ?? "video"}:${characterId}:${
      canReturnToMenu ? "restore" : "cancel"
    }`,
    title: resolvedCharacterName
      ? `正在等待上传《${resolvedCharacterName}》的音频参考`
      : "正在等待上传角色音频参考",
    description: canReturnToMenu
      ? "上传 1 个音频文件并发送即可绑定。若不继续上传，可点“返回菜单”取消当前操作并回到刚才的菜单。"
      : "上传 1 个音频文件并发送即可绑定。若不继续上传，可点“取消上传”退出当前等待状态。",
    options: [
      {
        id: `${characterId}-${canReturnToMenu ? "return-menu" : "cancel-upload"}`,
        label: optionLabel,
        value: optionValue,
        rationale: canReturnToMenu
          ? "取消当前音频上传，并回到刚才打开的素材菜单。"
          : "取消当前音频上传，关闭本次等待状态。",
      },
    ],
    presentation: "card",
    allowCustomInput: true,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: 0,
    totalSteps: 1,
    answerKey: PENDING_CHARACTER_AUDIO_QUESTION_KEY,
  };
}

function triggerBrowserTextDownload(fileName: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function exportMarkdownFileLocally(
  fileName: string,
  content: string,
): Promise<LocalScriptExportResult> {
  const saveBinaryFile = window.electronAPI?.storage?.saveBinaryFile;
  if (saveBinaryFile) {
    try {
      const result = await saveBinaryFile({
        defaultFileName: fileName,
        filters: [{ name: "Markdown", extensions: ["md"] }],
        base64: encodeUtf8ToBase64(content),
      });
      if (!result.ok) {
        throw new Error(result.error || "导出 Markdown 失败，请稍后重试。");
      }
      if (result.cancelled) {
        return { status: "cancelled" };
      }
      return { status: "saved" };
    } catch (error) {
      if (!isMissingSaveBinaryHandler(error)) {
        throw error;
      }
    }
  }

  triggerBrowserTextDownload(fileName, content);
  return { status: "saved" };
}

async function exportEpisodeMarkdownFilesLocally(
  episodes: Array<{ number: number; title?: string; content?: string | null }>,
): Promise<LocalScriptExportResult> {
  const storage = window.electronAPI?.storage;
  if (storage?.selectFolder && storage.writeText) {
    const destRoot = await storage.selectFolder();
    if (!destRoot) {
      return { status: "cancelled" };
    }

    const normalizedRoot = destRoot.replace(/[\\/]+$/g, "");
    for (const episode of episodes) {
      const fileName = sanitizeExportFileName(
        `ep${episode.number}-${episode.title || "episode"}.md`,
        `ep${episode.number}.md`,
      );
      const filePath = `${normalizedRoot}/${fileName}`;
      const result = await storage.writeText(filePath, episode.content ?? "");
      if (!result.ok) {
        throw new Error(result.error || `导出第 ${episode.number} 集失败，请稍后重试。`);
      }
    }
    return { status: "saved" };
  }

  for (const episode of episodes) {
    triggerBrowserTextDownload(
      sanitizeExportFileName(
        `ep${episode.number}-${episode.title || "episode"}.md`,
        `ep${episode.number}.md`,
      ),
      episode.content ?? "",
    );
  }
  return { status: "saved" };
}

interface Props {
  initialUtility?: UtilityPanelId;
  onUtilityChange?: (panel?: UtilityPanelId) => void;
}

type QState = StudioQuestionState;

export const HOMEPAGE_IDENTITY_GUIDANCE =
  "当用户问“你是谁”“你能做什么”或“这个产品是干什么的”时，先按项目定位介绍自己：你是 InFinio 首页里的主控创作 Agent，这是一站式 AI 创作与视频生产工作台，负责把原创剧本、参考改编、视频工作流、素材沉淀、审阅返工和导出交付留在同一会话里持续推进。除非用户明确追问底层模型、供应商或接口实现，否则不要主动先报 Claude、Anthropic、模型 ID 等底层信息。";

const PROMPT = [
  "你是 InFinio 首页里的主控创作 Agent。",
  "整个产品只有这一张首页工作台。所有推进都优先留在当前会话里完成，不要把用户推回模块页、步骤页、工作台或手动表单。",
  "你的默认工作顺序是：先分析，再追问，再执行。",
  "当需要结构化选择时，优先调用 AskUserQuestion。每一步都要给出足够清晰、可点击的选项，必要时支持多步追问和自定义输入。",
  "不要只把下一步选项写成 Markdown 列表让用户自己读；需要用户决策时，要真正调用 AskUserQuestion 并等待用户选择。",
  "当需要推进项目动作时调用 HomeStudioWorkflow；当适合并行研究或后台长任务时可以启动 Agent，但最终结果必须收口回当前首页会话。",
  "默认使用简体中文，保持简洁、克制、专业，不暴露内部推理。",
  "一次只推进一个关键决策；如果信息不够，不要猜，继续追问。",
  "如果用户只是打招呼或闲聊，先简短回应，不要主动汇报项目状态；等用户提出明确需求后再推进。",
  HOMEPAGE_IDENTITY_GUIDANCE,
  "当用户处于剧本或视频工作流中时，不要跳步。先完成当前阶段，再进入下一阶段。",
].join("\\n");
const ASSET_CREATION_PROMPT_OVERRIDE = [
  "[Asset Creation Override]",
  "OVERRIDE: generate_video_reference_assets, generate_storyboard_frames, and generate_project_image are asset-creation actions.",
  "They must go straight to the real generation tool call.",
  "Do NOT call query_asset_status before these three actions.",
  "This override supersedes any earlier instruction that implies only manually added assets count as valid library items.",
  "Project images and videos that are generated for the current video workflow are automatically registered into assetManifest, so they already count as asset-library items after generation.",
  "query_asset_status only applies to steps that need to consume assets that should already exist in the asset library, such as generate_video_assets, review, export, or explicit asset-library inspection.",
].join("\n");

const LLM_CONTROL_MODE_APPENDIX = [
  "[Normal LLM Mode Rules]",
  "In normal llm mode, you own the decision layer.",
  "Natural-language discussion is allowed. Answer the user's question normally when that helps the current step, then guide them back into the workflow.",
  "For identity or product-introduction questions, introduce yourself from the InFinio product role first: the homepage creative/workflow agent for script, adaptation, video production, asset accumulation, review, and export. Only mention the underlying model as secondary context when the user explicitly asks for it.",
  "If the user asks you to compare, explain, or clarify the options of an existing standard popup, answer in text first and then restore that same popup. Do not replace it with a new generic AskUserQuestion unless the current popup is truly no longer valid.",
  "When information is missing, the workflow reaches a turning point, or a workflow action finishes, usually reply with a brief status summary and then use AskUserQuestion for the next choice.",
  "At major decisions or explicit tradeoffs, briefly explain the choices in text and use AskUserQuestion when a structured popup will genuinely help.",
  "Do not assume the UI will auto-open a scripted next-step panel for you.",
  "Do not silently execute the next workflow action. Offer choices first.",
  "Proactively gather missing structured details through AskUserQuestion, following the same level of specificity as the dev-mode step popups such as duration, batch scope, export choices, and bridge decisions, but do not force every turn into a popup if a short natural-language reply is more helpful.",
  "If the user goes off-topic during a workflow or question flow, answer the user's current request first.",
  "Do not treat free-text input or uploaded files as the answer to a paused workflow question unless the user explicitly confirms that intent.",
  "After answering the off-topic request, gently restore the paused step through AskUserQuestion instead of forcing the flow.",
  "When a script is ready to move into video, keep the same conversation alive and guide the user step by step through the video workflow instead of treating it as a disconnected module.",
  "In the video workflow, code only controls the big stages and whether the current stage is ready. You must self-loop inside the current stage, keep collecting missing details with AskUserQuestion, and only ask the user to enter the next stage after the current one is complete.",
  "If a video stage requires a file, explicitly ask the user to upload it with the paperclip and continue the same stage after the upload arrives.",
  "In 视频工作流 / 剧本拆解, required configuration such as script source, single-episode duration, and video pace should be collected through AskUserQuestion popup options instead of broad free-text questions.",
  "If the user does not know which option to choose in 视频工作流 / 剧本拆解, recommend the best-fit option based on the existing script and explain the recommendation briefly.",
  "In 视频工作流 / 剧本拆解, all decomposition and extension must stay strictly within the existing script content. Do not invent new key characters, key scenes, or major plot turns.",
  "Every uploaded file must still receive an LLM response, even when you can only reason from extracted text, metadata, or a fallback digest.",
].join("\n");

const MOBILE_NAV_SHEET =
  "w-full border-r border-border bg-background p-0 text-foreground shadow-[18px_0_48px_rgba(0,0,0,0.2)] overscroll-contain sm:max-w-[360px]";
const IDLE =
  "和 Agent 说出你的目标，例如：我想做一部面向女性市场的都市反转短剧，请一步一步带我完成。";
const ACTIVE =
  "继续补充目标、修改意见、素材条件或你想推进的下一步，整个生产都会在这一页完成。";
const CUSTOM = "也可以跳过上方建议，直接输入你的自定义回答。";
const TITLE = "InFinio-一站式智能体自动化平台";
const HOME_RECENT_PROJECTS_LIMIT = HOME_AGENT_HISTORY_DISPLAY_LIMIT;
const SIDEBAR_BRAND = "InFinio";
const DESKTOP_SIDEBAR_WIDTH = 272;
const DESKTOP_SIDEBAR_COLLAPSED_WIDTH = 80;
const DESKTOP_SIDEBAR_OFFSET = 296;
const DESKTOP_SIDEBAR_COLLAPSED_OFFSET = 108;
const DESKTOP_SETTINGS_WIDTH = 456;
const DESKTOP_SIDEBAR_COLLAPSE_KEY = "storyforge-home-agent-desktop-sidebar-collapsed-v1";
const DESKTOP_SIDEBAR_WIDTH_KEY = "infinio-sidebar-width-v1";
const VIDEO_PROJECT_SAVED_EVENT = "home-agent:video-project-saved";
const DESKTOP_SIDEBAR_MIN_WIDTH = 200;
const DESKTOP_SIDEBAR_MAX_WIDTH = 480;
const ACTIVE_TRACK_CLASS = "max-w-[820px]";
const IDLE_TRACK_CLASS = "max-w-[800px]";
type RuntimeTask = Task;

function isMessageTailSubset(
  currentMessages: HomeAgentMessage[],
  candidateMessages: HomeAgentMessage[],
): boolean {
  if (currentMessages.length === 0) return candidateMessages.length > 0;
  if (candidateMessages.length < currentMessages.length) return false;
  const offset = candidateMessages.length - currentMessages.length;
  for (let index = 0; index < currentMessages.length; index += 1) {
    const current = currentMessages[index];
    const candidate = candidateMessages[offset + index];
    if (!candidate) return false;
    if (current.id && candidate.id && current.id !== candidate.id) return false;
    if (current.role !== candidate.role) return false;
    if (current.content !== candidate.content) return false;
    if (current.createdAt !== candidate.createdAt) return false;
  }
  return true;
}

function scheduleBackgroundTask(task: () => void, timeout = 500): () => void {
  if (typeof window === "undefined") return () => {};

  const idleWindow = window as Window &
    typeof globalThis & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

  if (typeof idleWindow.requestIdleCallback === "function") {
    const handle = idleWindow.requestIdleCallback(() => task(), { timeout });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }

  const handle = window.setTimeout(task, Math.min(timeout, 180));
  return () => window.clearTimeout(handle);
}

function readDesktopSidebarCollapsed(): boolean {
  if (typeof window === "undefined") return false;

  try {
    return JSON.parse(window.localStorage.getItem(DESKTOP_SIDEBAR_COLLAPSE_KEY) ?? "false") === true;
  } catch {
    return false;
  }
}

function writeDesktopSidebarCollapsed(collapsed: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(DESKTOP_SIDEBAR_COLLAPSE_KEY, JSON.stringify(collapsed));
}

const HOME_CREATION_MODE_STORAGE_KEY = "infinio_creation_mode";
const HOME_DEV_MODE_STORAGE_KEY = "infinio_dev_mode_v2";
const LEGACY_DEV_MODE_STORAGE_KEY = "infinio_dev_mode";

function readStoredCreationMode(): CreationMode {
  if (typeof window === "undefined") return "fast";
  try {
    const stored = window.localStorage.getItem(HOME_CREATION_MODE_STORAGE_KEY);
    return stored === "pro" ? "pro" : "fast";
  } catch {
    return "fast";
  }
}

function writeStoredCreationMode(mode: CreationMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HOME_CREATION_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore persistence failures and keep runtime mode.
  }
}

function readStoredDevMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const stored = window.localStorage.getItem(HOME_DEV_MODE_STORAGE_KEY);
    if (stored === "1") return true;
    if (stored === "0") return false;
    return window.localStorage.getItem(LEGACY_DEV_MODE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStoredDevMode(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HOME_DEV_MODE_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Ignore persistence failures and keep runtime mode.
  }
}

function sortConversationSnapshots(items: ConversationProjectSnapshot[]): ConversationProjectSnapshot[] {
  return [...items].sort((a, b) => {
    const pinnedDelta = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
    if (pinnedDelta !== 0) return pinnedDelta;
    const aDate = new Date(a.updatedAt ?? 0).getTime();
    const bDate = new Date(b.updatedAt ?? 0).getTime();
    return bDate - aDate;
  });
}

// 灏嗘秷鎭垪琛ㄤ腑鎵€鏈?pending 闄勪欢鏍囪涓?cancelled锛岀敤浜?streaming 鍋滄鎴?session 鎭㈠鏃舵竻鐞嗗绔嬪崰浣嶇
function sanitizePendingAttachments(messages: HomeAgentMessage[]): HomeAgentMessage[] {
  if (!messages.some((m) => m.attachments?.some((a) => a.pending))) return messages;
  return messages.map((m) => {
    if (!m.attachments?.some((a) => a.pending)) return m;
    const attachments = m.attachments.map((a) =>
      a.pending && a.kind !== "video"
        ? { ...a, pending: false, cancelled: true }
        : a,
    );
    const hasPendingAttachments = attachments.some((a) => a.pending);
    if (attachments.every((attachment, index) => attachment === m.attachments?.[index])) {
      return m;
    }
    return {
      ...m,
      status: !hasPendingAttachments && m.status === "pending" ? ("complete" as const) : m.status,
      streamLabel: !hasPendingAttachments && m.status === "pending" ? undefined : m.streamLabel,
      attachments,
    };
  });
}


const templates = [
  {
    id: "script",
    title: "原创剧本",
    description: "从一个想法开始，由 Agent 逐步追问市场、风格、受众和人物关系。",
    prompt:
      "我想开启一个原创剧本项目。请先分析我的目标，再一步一步追问目标市场、风格类型、受众和创作方向，最终带我完成创作。",
    icon: Wand2,
  },
  {
    id: "adaptation",
    title: "参考改编",
    description: "拆解参考内容，在同一场会话里完成结构转译、角色重塑和内容生成。",
    prompt:
      "我要做参考改编。请先问我目标市场和改编方向，然后接收参考内容，在首页会话里继续推进结构转译和角色设计。",
    icon: Compass,
  },
  {
    id: "video",
    title: "视频工作流",
    description: "把脚本、分镜、提示词批次和出片准备统一放进同一套首页会话。",
    prompt:
      "我要继续视频工作流。请先分析我现有的脚本或项目，再在当前首页会话里继续推进分镜、提示词批次和出片准备。",
    icon: PanelsTopLeft,
  },
];

const mk = (
  role: HomeAgentMessage["role"],
  content: string,
  artifactIds?: string[],
  attachments?: ChatAttachment[],
  artifactSnapshots?: import("@/lib/home-agent/types").ConversationArtifact[],
  messageExtras?: Partial<Pick<HomeAgentMessage, "automationOrigin" | "workflowRefresh">>,
): HomeAgentMessage => ({
  id: crypto.randomUUID(),
  role,
  content,
  createdAt: new Date().toISOString(),
  status: "complete",
  ...(artifactIds?.length ? { artifactIds } : {}),
  ...(artifactSnapshots?.length ? { artifactSnapshots } : {}),
  ...(attachments?.length ? { attachments } : {}),
  ...messageExtras,
});

function formatMediaDetailLine(parts: Array<string | null | undefined>): string {
  return parts.map((part) => String(part || "").trim()).filter(Boolean).join(" · ");
}

function extractPrimaryMediaContentLabel(contentSummary?: string | null): string {
  const summary = String(contentSummary || "").trim();
  if (!summary) return "";

  const parts = summary
    .split(/\s+(?:·|路)\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length <= 1) return summary;

  const [first, second] = parts;
  if (
    /^镜头\s+\d+$/u.test(first) &&
    second &&
    !/^(视图|变体|模式|模型|分辨率|比例|通道)\s+/u.test(second)
  ) {
    return `${first} · ${second}`;
  }

  return first;
}

function buildMediaStatusHeading(params: {
  phase: "start" | "done";
  fallbackLabel: string;
  contentSummary?: string;
}) {
  const primaryLabel = extractPrimaryMediaContentLabel(params.contentSummary);
  if (params.phase === "start") {
    return primaryLabel ? `正在生成${primaryLabel}，请稍等…` : `正在生成${params.fallbackLabel}，请稍等…`;
  }
  return primaryLabel ? `已生成${primaryLabel}` : `${params.fallbackLabel}已生成`;
}

function extractCompactMediaContentLabel(contentSummary?: string | null): string {
  const summary = String(contentSummary || "").trim();
  if (!summary) return "";

  const parts = summary
    .split(/\s+(?:\u00b7|路)\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length <= 1) return summary;

  const [first, second] = parts;
  if (
    /^\u955c\u5934\s+\d+$/u.test(first) &&
    second &&
    !/^(?:\u89c6\u56fe|\u53d8\u4f53|\u6a21\u5f0f|\u6a21\u578b|\u5206\u8fa8\u7387|\u6bd4\u4f8b|\u901a\u9053)\s+/u.test(second)
  ) {
    return `${first} \u00b7 ${second}`;
  }

  return first;
}

function buildCompactMediaStatusHeading(params: {
  phase: "start" | "done";
  fallbackLabel: string;
  contentSummary?: string;
}) {
  const primaryLabel = extractCompactMediaContentLabel(params.contentSummary);
  if (params.phase === "start") {
    return primaryLabel
      ? `\u6b63\u5728\u751f\u6210${primaryLabel}\uff0c\u8bf7\u7a0d\u7b49\u2026`
      : `\u6b63\u5728\u751f\u6210${params.fallbackLabel}\uff0c\u8bf7\u7a0d\u7b49\u2026`;
  }

  return primaryLabel
    ? `\u5df2\u751f\u6210${primaryLabel}`
    : `${params.fallbackLabel}\u5df2\u751f\u6210`;
}

function buildImageMediaMessage(detail: {
  count?: number;
  action?: string;
  modelFamily?: string;
  resolution?: string;
  aspectRatio?: string;
  contentSummary?: string;
}) {
  const count = Math.max(1, detail.count ?? 1);
  const targetLabel =
    detail.action === "generate_storyboard_frames"
      ? "分镜图"
      : detail.action === "generate_video_reference_assets"
        ? "视频参考素材"
        : "图片";
  const detailLine = formatMediaDetailLine([
    `${count} 张${targetLabel}`,
    detail.contentSummary ? `内容 ${detail.contentSummary}` : "",
    detail.modelFamily ? `模型 ${detail.modelFamily}` : "",
    detail.resolution ? `分辨率 ${localizeMediaSettingValue(detail.resolution, "resolution")}` : "",
    detail.aspectRatio ? `比例 ${detail.aspectRatio}` : "",
  ]);
  return {
    start: [detail.action === "generate_storyboard_frames" ? "正在生成分镜图，请稍等…" : `正在生成${targetLabel}，请稍等…`, detailLine]
      .filter(Boolean)
      .join("\n"),
    done: [`${targetLabel}已生成`, detailLine].filter(Boolean).join("\n"),
  };
}

function buildVideoMediaMessage(detail: {
  count?: number;
  model?: string;
  resolution?: string;
  provider?: string;
  mode?: string;
  contentSummary?: string;
}) {
  const count = Math.max(1, detail.count ?? 1);
  const modeLabel = localizeMediaSettingValue(detail.mode, "mode") || "视频生成";
  const detailLine = formatMediaDetailLine([
    `${count} 条视频`,
    detail.contentSummary ? `内容 ${detail.contentSummary}` : "",
    `模式 ${modeLabel}`,
    detail.model ? `模型 ${detail.model}` : "",
    detail.resolution ? `分辨率 ${localizeMediaSettingValue(detail.resolution, "resolution")}` : "",
    detail.provider ? `通道 ${localizeMediaSettingValue(detail.provider, "provider")}` : "",
  ]);
  return {
    start: ["正在生成视频，请稍等…", detailLine].filter(Boolean).join("\n"),
    done: ["视频已生成", detailLine].filter(Boolean).join("\n"),
  };
}

function extractCompactMediaContentLabelV2(contentSummary?: string | null): string {
  const summary = String(contentSummary || "").trim();
  if (!summary) return "";

  const parts = summary
    .split(/\s+(?:\u00b7|路)\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length <= 1) return summary;

  const [first, second] = parts;
  if (
    /^\u955c\u5934\s+\d+$/u.test(first) &&
    second &&
    !/^(?:\u89c6\u56fe|\u53d8\u4f53|\u6a21\u5f0f|\u6a21\u578b|\u5206\u8fa8\u7387|\u6bd4\u4f8b|\u901a\u9053)\s+/u.test(second)
  ) {
    return `${first} \u00b7 ${second}`;
  }

  return first;
}

function buildCompactMediaStatusHeadingV2(params: {
  phase: "start" | "done";
  fallbackLabel: string;
  contentSummary?: string;
}) {
  const primaryLabel = extractCompactMediaContentLabelV2(params.contentSummary);
  if (params.phase === "start") {
    return primaryLabel
      ? `\u6b63\u5728\u751f\u6210${primaryLabel}\uff0c\u8bf7\u7a0d\u7b49\u2026`
      : `\u6b63\u5728\u751f\u6210${params.fallbackLabel}\uff0c\u8bf7\u7a0d\u7b49\u2026`;
  }

  return primaryLabel
    ? `\u5df2\u751f\u6210${primaryLabel}`
    : `${params.fallbackLabel}\u5df2\u751f\u6210`;
}

function buildPendingMediaStreamLabelV2(params: {
  fallbackLabel: string;
  contentSummary?: string;
}) {
  const primaryLabel = extractCompactMediaContentLabelV2(params.contentSummary);
  return primaryLabel ? `\u6b63\u5728\u751f\u6210${primaryLabel}` : `\u6b63\u5728\u751f\u6210${params.fallbackLabel}`;
}

function resolveImageFailureReason(reason?: string): string {
  if (!reason) return "\u751f\u6210\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5";
  const r = reason.toLowerCase();
  if (r.includes("timeouterror") || r.includes("timeout") || r.includes("timed out")) {
    return "\u751f\u6210\u8d85\u65f6\uff08\u8d85\u8fc74\u5206\u949f\uff09\uff0c\u8bf7\u91cd\u8bd5";
  }
  if (r.includes("abort") || r.includes("cancel")) {
    return "\u751f\u6210\u5df2\u53d6\u6d88";
  }
  if (r.includes("network") || r.includes("fetch") || r.includes("connect")) {
    return "\u7f51\u7edc\u9519\u8bef\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u540e\u91cd\u8bd5";
  }
  if (r.includes("rate limit") || r.includes("429") || r.includes("too many")) {
    return "\u8bf7\u6c42\u8fc7\u4e8e\u9891\u7e41\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5";
  }
  if (r.includes("quota") || r.includes("balance") || r.includes("insufficient")) {
    return "\u8d26\u6237\u4f59\u989d\u4e0d\u8db3\u6216\u914d\u989d\u5df2\u7528\u5c3d";
  }
  if (r.includes("invalid") || r.includes("400") || r.includes("bad request")) {
    return "\u8bf7\u6c42\u53c2\u6570\u6709\u8bef\uff0c\u8bf7\u68c0\u67e5\u751f\u6210\u8bbe\u7f6e";
  }
  if (r.includes("500") || r.includes("server") || r.includes("internal")) {
    return "\u670d\u52a1\u5668\u9519\u8bef\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5";
  }
  return "\u751f\u6210\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5";
}

function resolveVideoFailureReason(reason?: string): string {
  if (!reason) return "\u89c6\u9891\u751f\u6210\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5";
  const normalized = reason.trim();
  if (!normalized) return "\u89c6\u9891\u751f\u6210\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5";
  const lower = normalized.toLowerCase();
  if (lower.includes("timeouterror") || lower.includes("timeout") || lower.includes("timed out")) {
    return "\u89c6\u9891\u751f\u6210\u8d85\u65f6\uff0c\u8bf7\u91cd\u8bd5";
  }
  if (lower.includes("abort") || lower.includes("cancel")) {
    return "\u89c6\u9891\u751f\u6210\u5df2\u53d6\u6d88";
  }
  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}

function buildMediaFailureCompletionContent(params: {
  kind: "image" | "video";
  label?: string;
  failureReason?: string;
}): string {
  const subject = params.label?.trim() || (params.kind === "image" ? "\u56fe\u7247" : "\u89c6\u9891");
  const detail = params.failureReason?.trim();
  return detail ? `${subject} \u751f\u6210\u5931\u8d25\uff1a${detail}` : `${subject} \u751f\u6210\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5`;
}

export function finalizeMediaMessageIfSettled(
  message: HomeAgentMessage,
  kind: ChatAttachment["kind"],
  nextAttachments: ChatAttachment[],
  completionContent?: string,
): HomeAgentMessage {
  const nextMessage: HomeAgentMessage = {
    ...message,
    attachments: nextAttachments,
  };
  const hasPendingAttachments = nextAttachments.some((attachment) => attachment.kind === kind && attachment.pending);
  if (hasPendingAttachments) {
    return nextMessage;
  }
  return {
    ...nextMessage,
    status: "complete",
    streamLabel: undefined,
    ...(completionContent ? { content: completionContent } : {}),
  };
}

export function markFailedMediaAttachmentsInMessage(
  message: HomeAgentMessage,
  params: {
    kind: "image" | "video";
    failureReason: string;
    index?: number;
    label?: string;
    settleAll?: boolean;
    completionContent?: string;
    attachmentOverrides?: Partial<ChatAttachment>;
  },
): HomeAgentMessage {
  if (!message.attachments?.length) return message;
  const mediaAttachments = message.attachments.filter((attachment) => attachment.kind === params.kind);
  const targetIds = params.settleAll
    ? new Set(
        mediaAttachments
          .filter((attachment) => attachment.pending)
          .map((attachment) => attachment.id),
      )
    : (() => {
        const targetAttachment =
          typeof params.index === "number"
            ? mediaAttachments[params.index]
            : mediaAttachments.find((attachment) => attachment.pending);
        return targetAttachment ? new Set([targetAttachment.id]) : new Set<string>();
      })();
  if (!targetIds.size) return message;

  const nextAttachments = message.attachments.map((attachment) =>
    targetIds.has(attachment.id)
      ? {
          ...attachment,
          ...params.attachmentOverrides,
          pending: false,
          cancelled: false,
          failed: true,
          failureReason: params.failureReason,
          label: params.label || attachment.label,
        }
      : attachment,
  );
  return finalizeMediaMessageIfSettled(
    message,
    params.kind,
    nextAttachments,
    params.completionContent,
  );
}

async function buildGeneratedVideoAttachmentFromEvent(detail: {
  url: string;
  label?: string;
  sceneId?: string;
  projectId?: string;
  segmentLabel?: string;
  fallbackProjectId?: string | null;
}): Promise<ChatAttachment> {
  const currentProjectId = detail.projectId ?? detail.fallbackProjectId ?? undefined;
  const rawFileName =
    detail.url.split(/[\\/]/).pop()?.split("?")[0] || buildGeneratedMediaFallbackName("video", 1, 0);
  let urlFileName = rawFileName;
  try {
    urlFileName = decodeURIComponent(rawFileName);
  } catch {
    urlFileName = rawFileName;
  }
  const contentStem = detail.label ? detail.label.replace(/\s*·\s*版本\d+$/, "") : urlFileName.replace(/\.[^.]+$/, "");
  const fileName = contentStem ? `${contentStem}.mp4` : urlFileName;
  const cachedVideo = currentProjectId
    ? await cacheProjectVideoSource(detail.url, fileName, currentProjectId)
    : null;
  const fallbackVideo = resolveVideoAttachmentSource(detail.url);

  return {
    id: crypto.randomUUID(),
    fileName,
    label: contentStem || undefined,
    mimeType: cachedVideo?.mimeType ?? "video/mp4",
    size: cachedVideo?.size ?? 0,
    kind: "video",
    localPath: cachedVideo?.localPath ?? fallbackVideo.localPath,
    previewUrl: cachedVideo?.previewUrl ?? fallbackVideo.previewUrl,
    ...(detail.segmentLabel && currentProjectId
      ? {
          generationContext: {
            action: "generate_segment_video" as const,
            projectId: currentProjectId,
            targetId: detail.segmentLabel,
            regenerateMode: "redo-and-generate" as const,
          },
        }
      : detail.sceneId && currentProjectId
        ? {
            generationContext: {
              action: "generate_video_assets" as const,
              projectId: currentProjectId,
              targetId: detail.sceneId,
              regenerateMode: "redo-and-generate" as const,
            },
          }
        : {}),
  };
}

function buildImageMediaMessageV2(detail: {
  count?: number;
  action?: string;
  modelFamily?: string;
  resolution?: string;
  aspectRatio?: string;
  contentSummary?: string;
  imageLabels?: string[];
  failedCount?: number;
}) {
  const count = Math.max(1, detail.count ?? 1);
  const isMultiple = count > 1;
  const failedCount = detail.failedCount ?? 0;
  const successCount = count - failedCount;
  const targetLabel =
    detail.action === "generate_storyboard_frames"
      ? "分镜图"
      : detail.action === "generate_video_reference_assets"
        ? "视频参考素材"
        : "图片";

  let detailLine: string;
  if (isMultiple && detail.imageLabels?.length) {
    const labels = detail.imageLabels;
    const countLabel = failedCount > 0
      ? `${successCount} 张${targetLabel}成功，${failedCount} 张失败`
      : `${count} 张${targetLabel}`;
    if (labels.length <= 3) {
      detailLine = formatMediaDetailLine([countLabel, ...labels]);
    } else {
      detailLine = [countLabel, ...labels.map((l) => `- ${l}`)].join("\n");
    }
  } else {
    const countLabel = failedCount > 0
      ? `${successCount} 张${targetLabel}成功，${failedCount} 张失败`
      : `${count} 张${targetLabel}`;
    detailLine = formatMediaDetailLine([
      countLabel,
      detail.contentSummary ? `内容 ${detail.contentSummary}` : "",
    ]);
  }

  const headingContentSummary = isMultiple ? undefined : detail.contentSummary;

  return {
    start: [
      buildCompactMediaStatusHeadingV2({
        phase: "start",
        fallbackLabel: targetLabel,
        contentSummary: headingContentSummary,
      }),
      detailLine,
    ]
      .filter(Boolean)
      .join("\n"),
    done: [
      buildCompactMediaStatusHeadingV2({
        phase: "done",
        fallbackLabel: targetLabel,
        contentSummary: headingContentSummary,
      }),
      detailLine,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function buildVideoMediaMessageV2(detail: {
  count?: number;
  model?: string;
  resolution?: string;
  aspectRatio?: string;
  provider?: string;
  mode?: string;
  contentSummary?: string;
  videoLabels?: string[];
  routeHint?: string;
}) {
  const count = Math.max(1, detail.count ?? 1);
  const isMultiple = count > 1;
  const modeLabel = localizeMediaSettingValue(detail.mode, "mode") || "\u89c6\u9891\u751f\u6210";
  const defaultDetailLine =
    isMultiple && detail.videoLabels?.length
      ? detail.videoLabels.length <= 3
        ? formatMediaDetailLine([`${count} \u6761\u89c6\u9891`, ...detail.videoLabels])
        : [`${count} \u6761\u89c6\u9891`, ...detail.videoLabels.map((label) => `- ${label}`)].join("\n")
      : formatMediaDetailLine([
          `${count} \u6761\u89c6\u9891`,
          detail.contentSummary ? `\u5185\u5bb9 ${detail.contentSummary}` : "",
          `\u6a21\u5f0f ${modeLabel}`,
          detail.resolution ? `\u5206\u8fa8\u7387 ${localizeMediaSettingValue(detail.resolution, "resolution")}` : "",
          detail.aspectRatio ? `\u6bd4\u4f8b ${detail.aspectRatio}` : "",
          detail.model ? `\u6a21\u578b ${detail.model}` : "",
          detail.provider ? `\u901a\u9053 ${localizeMediaSettingValue(detail.provider, "provider")}` : "",
        ]);
  const routeHint = String(detail.routeHint || "").trim();
  const startDetailLine = routeHint || defaultDetailLine;

  // \u590d\u6570\u65f6\u6807\u9898\u4e0d\u8ffd\u52a0\u8d44\u4ea7\u540d\u79f0\uff0c\u5355\u6761\u65f6\u663e\u793a
  const headingContentSummary = isMultiple ? undefined : detail.contentSummary;

  return {
    start: [
      buildCompactMediaStatusHeadingV2({
        phase: "start",
        fallbackLabel: "\u89c6\u9891",
        contentSummary: headingContentSummary,
      }),
      startDetailLine,
    ]
      .filter(Boolean)
      .join("\n"),
    done: [
      buildCompactMediaStatusHeadingV2({
        phase: "done",
        fallbackLabel: "\u89c6\u9891",
        contentSummary: headingContentSummary,
      }),
      defaultDetailLine,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function preserveExistingMediaDetailLines(params: {
  existingContent?: string;
  nextContent: string;
  preserveExistingDetails?: boolean;
}): string {
  const nextContent = String(params.nextContent || "").trim();
  if (!params.preserveExistingDetails) return nextContent;

  const existingLines = String(params.existingContent || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (existingLines.length <= 1) return nextContent;

  const nextLines = nextContent
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!nextLines.length) return nextContent;

  return [nextLines[0], ...existingLines.slice(1)].join("\n");
}

function hasRunningVideoGenerationTasks(
  project: Pick<NonNullable<StudioRuntimeState["currentVideoProject"]>, "scenes"> | null | undefined,
): boolean {
  return Boolean(
    project?.scenes?.some((scene) => {
      const status = String(scene.videoStatus || "").toLowerCase();
      return Boolean(scene.videoTaskId) && (status === "queued" || status === "processing");
    }),
  );
}

function buildCompletedMediaAttachmentSignature(
  attachment: Pick<ChatAttachment, "kind" | "pending" | "cancelled" | "localPath" | "previewUrl" | "fileName">,
): string | null {
  if (attachment.pending || attachment.cancelled) return null;
  const primarySource =
    String(attachment.localPath || "").trim() ||
    String(attachment.previewUrl || "").trim();
  return JSON.stringify([
    attachment.kind,
    primarySource,
    primarySource ? "" : String(attachment.fileName || "").trim(),
  ]);
}

function buildRecentlyProcessedVideoMarker(url: string, mediaEventId?: string): string {
  return mediaEventId ? `${mediaEventId}::${url}` : url;
}

function wasVideoRecentlyProcessed(
  processed: ReadonlySet<string>,
  url: string,
  mediaEventId?: string,
): boolean {
  const normalizedUrl = String(url || "").trim();
  if (!normalizedUrl) return false;
  if (mediaEventId) {
    return processed.has(buildRecentlyProcessedVideoMarker(normalizedUrl, mediaEventId));
  }
  return processed.has(normalizedUrl);
}

function markVideoAsRecentlyProcessed(
  processed: Set<string>,
  url: string,
  mediaEventId?: string,
): void {
  const normalizedUrl = String(url || "").trim();
  if (!normalizedUrl) return;

  const markers = new Set<string>([normalizedUrl]);
  if (mediaEventId) {
    markers.add(buildRecentlyProcessedVideoMarker(normalizedUrl, mediaEventId));
  }

  markers.forEach((marker) => processed.add(marker));
  setTimeout(() => {
    markers.forEach((marker) => processed.delete(marker));
  }, 30_000);
}

function hasMatchingCompletedMediaMessage(
  messages: HomeAgentMessage[],
  attachments: ChatAttachment[],
): boolean {
  const targetSignatures = attachments
    .map((attachment) => buildCompletedMediaAttachmentSignature(attachment))
    .filter((value): value is string => Boolean(value))
    .sort();

  if (!targetSignatures.length) return false;

  return messages.some((message) => {
    if (message.role !== "assistant" || !message.attachments?.length) return false;
    const messageSignatures = message.attachments
      .map((attachment) => buildCompletedMediaAttachmentSignature(attachment))
      .filter((value): value is string => Boolean(value))
      .sort();

    return (
      messageSignatures.length === targetSignatures.length &&
      messageSignatures.every((signature, index) => signature === targetSignatures[index])
    );
  });
}

// eslint-disable-next-line react-refresh/only-export-components
export function findPendingMediaMessageIndex(
  messages: HomeAgentMessage[],
  kind: ChatAttachment["kind"],
  mediaEventId?: string,
): number {
  if (mediaEventId) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (
        message?.role === "assistant" &&
        message.status === "pending" &&
        message.mediaEventId === mediaEventId &&
        message.attachments?.some((attachment) => attachment.kind === kind)
      ) {
        return index;
      }
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === "assistant" &&
      message.status === "pending" &&
      message.attachments?.some((attachment) => attachment.kind === kind)
    ) {
      return index;
    }
  }

  return -1;
}

function isSettledVideoAttachment(attachment: ChatAttachment): boolean {
  return attachment.kind === "video" && !attachment.pending && !attachment.cancelled;
}

// eslint-disable-next-line react-refresh/only-export-components
export function mergeCompletedVideoAttachments(
  currentAttachments: ChatAttachment[] | undefined,
  incomingAttachments: ChatAttachment[],
): ChatAttachment[] {
  const settledVideos = (currentAttachments ?? []).filter(isSettledVideoAttachment);
  if (!settledVideos.length) return incomingAttachments;

  const existingBySignature = new Map<string, ChatAttachment>();
  for (const attachment of settledVideos) {
    const signature = buildCompletedMediaAttachmentSignature(attachment);
    if (!signature || existingBySignature.has(signature)) continue;
    existingBySignature.set(signature, attachment);
  }

  const incomingSignatures = new Set<string>();
  const merged = incomingAttachments.map((attachment) => {
    const signature = buildCompletedMediaAttachmentSignature(attachment);
    if (!signature) return attachment;
    incomingSignatures.add(signature);
    return existingBySignature.get(signature) ?? attachment;
  });

  for (const attachment of settledVideos) {
    const signature = buildCompletedMediaAttachmentSignature(attachment);
    if (!signature || incomingSignatures.has(signature)) continue;
    merged.push(attachment);
  }

  return merged;
}

function mergeCompletedImageAttachments(
  existingAttachments: ChatAttachment[] | undefined,
  finalAttachments: ChatAttachment[],
): ChatAttachment[] {
  if (!existingAttachments?.length) return finalAttachments;
  if (!finalAttachments.length) return existingAttachments;

  const merged = [...existingAttachments];

  for (const finalAttachment of finalAttachments) {
    let targetIndex = merged.findIndex(
      (attachment) =>
        attachment.kind === "image" &&
        ((attachment.localPath && finalAttachment.localPath && attachment.localPath === finalAttachment.localPath) ||
          (attachment.label && finalAttachment.label && attachment.label === finalAttachment.label)),
    );

    if (targetIndex === -1) {
      targetIndex = merged.findIndex(
        (attachment) =>
          attachment.kind === "image" &&
          (attachment.pending || attachment.failed || attachment.cancelled) &&
          (!finalAttachment.label || !attachment.label || attachment.label === finalAttachment.label),
      );
    }

    if (targetIndex === -1) {
      targetIndex = merged.findIndex(
        (attachment) =>
          attachment.kind === "image" && (attachment.pending || attachment.failed || attachment.cancelled),
      );
    }

    if (targetIndex === -1) {
      merged.push(finalAttachment);
      continue;
    }

    merged[targetIndex] = finalAttachment;
  }

  return merged;
}

function buildPendingMediaStreamLabel(params: {
  fallbackLabel: string;
  contentSummary?: string;
}) {
  const primaryLabel = extractCompactMediaContentLabel(params.contentSummary);
  return primaryLabel ? `\u6b63\u5728\u751f\u6210${primaryLabel}` : `\u6b63\u5728\u751f\u6210${params.fallbackLabel}`;
}

export default function HomeAgentStudio({ initialUtility, onUtilityChange }: Props) {
  const isMobile = useIsMobile();
  const shouldUseMobileLayout =
    isMobile || (typeof window !== "undefined" && window.innerWidth < 768);
  const seedRef = useRef<{
    session: StudioSessionState | null;
    runtime: StudioRuntimeState;
    needsSessionHydration: boolean;
  }>();
  if (!seedRef.current) seedRef.current = createInitialStudioSeed();

  const session = seedRef.current.session;
  const needsBootstrapSessionHydration = seedRef.current.needsSessionHydration;
  const initialImageGenerationPrefs = normalizeVideoImageGenerationPrefs({
    ...readStoredHomeAgentImageGenerationPrefs(),
    ...(session?.imageGenerationPrefs ?? {}),
    ...(session?.selectedImageModelFamily ? { familyKey: session.selectedImageModelFamily } : {}),
  });
  const initialVideoGenerationPrefs = normalizeVideoGenerationPrefs({
    ...readStoredHomeAgentVideoGenerationPrefs(),
    ...(session?.videoGenerationPrefs ?? {}),
    ...(session?.selectedVideoModelKey ? { modelKey: session.selectedVideoModelKey } : {}),
  });
  const hasInitialSession = hasSavedSessionContent(session) || !!session?.currentProjectSnapshot;
  const [runtime, setRuntime] = useState(seedRef.current.runtime);
  const [messages, setMessages] = useState<HomeAgentMessage[]>(sanitizePendingAttachments(session?.messages ?? []));
  const [creationMode, setCreationMode] = useState<CreationMode>(
    session?.creationMode ?? readStoredCreationMode(),
  );
  const [automationMode, setAutomationMode] = useState<AutomationMode>(() =>
    normalizeAutomationMode(session?.automationMode ?? session?.currentProjectSnapshot?.automationMode ?? readStoredAutomationMode()),
  );
  const [historyAutomationMode, setHistoryAutomationMode] = useState<AutomationMode>(() => readStoredAutomationMode());
  const [homepageIsolationRequestEpoch, setHomepageIsolationRequestEpoch] = useState(0);
  const [devMode, setDevMode] = useState<boolean>(session?.devMode ?? readStoredDevMode());

  useEffect(() => {
    if (typeof window === "undefined") return;

    const warmHomeAgentChunks = () => {
      void import("./home-agent-sidebar");
      void import("./AssistantCreationGuideBody");
    };

    if (typeof window.requestIdleCallback === "function") {
      const idleId = window.requestIdleCallback(warmHomeAgentChunks, { timeout: 1_500 });
      return () => window.cancelIdleCallback?.(idleId);
    }

    const timeoutId = window.setTimeout(warmHomeAgentChunks, 300);
    return () => window.clearTimeout(timeoutId);
  }, []);

  const [mode, setMode] = useState<AgentConversationMode>(
    session?.mode === "recovering" || session?.mode === "maintenance-review"
      ? session.mode
      : hasInitialSession
        ? "active"
        : "idle",
  );
  const [streaming, setStreaming] = useState(false);
  const [tasks, setTasks] = useState<RuntimeTask[]>([]);
  const [qState, setQState] = useState<QState | null>(session?.qState ?? null);
  const [deferredQuestionState, setDeferredQuestionState] = useState<QState | null>(
    session?.deferredQuestionState ?? null,
  );
  const [suggested, setSuggested] = useState<ComposerQuestion | null>(null);
  const [
    pendingWorkflowPopoverAfterAssistantReply,
    setPendingWorkflowPopoverAfterAssistantReply,
  ] = useState<PendingWorkflowPopoverAfterAssistantReply | null>(null);
  const [
    pendingDeferredQuestionRestoreAfterAssistantReply,
    setPendingDeferredQuestionRestoreAfterAssistantReply,
  ] = useState<PendingDeferredQuestionRestoreAfterAssistantReply | null>(null);
  const lastSuggestedRef = useRef<ComposerQuestion | null>(null);
  const [pendingWorkflowUploadKind, setPendingWorkflowUploadKind] = useState<PendingWorkflowUploadKind | null>(
    () => resolvePendingWorkflowUploadKind(session),
  );
  const [popoverOverride, setPopoverOverride] = useState<ComposerQuestion | null>(() => {
    if (resolvePendingWorkflowUploadKind(session)) return null;
    const stored = session?.pendingChoiceQuestion ?? session?.interruptedChoiceQuestion ?? null;
    if (!stored || stored.answerKey !== "video-bridge-panel") return stored;
    const currentMode =
      seedRef.current?.runtime.currentVideoProject?.videoGenerationPrefs?.mode ??
      DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.mode;
    const isT2V = stored.id.endsWith("-t2v");
    const compatible = currentMode === "text-to-video" ? isT2V : !isT2V;
    return compatible ? stored : null;
  });
  const [interruptedChoiceQuestion, setInterruptedChoiceQuestion] = useState<ComposerQuestion | null>(
    resolvePendingWorkflowUploadKind(session) ? null : (session?.interruptedChoiceQuestion ?? null),
  );
  const [selectedValues, setSelectedValues] = useState<string[]>(session?.selectedValues ?? []);
  const [deferredSelectedValues, setDeferredSelectedValues] = useState<string[]>(
    session?.deferredSelectedValues ?? [],
  );
  const [draftInitialValue, setDraftInitialValue] = useState(session?.draft ?? "");
  const [draftResetVersion, setDraftResetVersion] = useState(0);
  const [draftPresence, setDraftPresence] = useState(Boolean(session?.draft?.trim()));
  const [persistedDraft, setPersistedDraft] = useState(session?.draft ?? "");
  const [deferredDraft, setDeferredDraft] = useState(session?.deferredDraft ?? "");
  const [fullAutoChecklistCollapsed, setFullAutoChecklistCollapsed] = useState(
    session?.fullAutoChecklistCollapsed ?? true,
  );
  const [recentProjectsReady, setRecentProjectsReady] = useState(false);
  const [isRefreshingProjects, setIsRefreshingProjects] = useState(false);
  const [metaReady, setMetaReady] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [importPreviewState, setImportPreviewState] = useState<{
    filePath: string;
    preview: ChatHistoryPreview;
    snapshot: ConversationProjectSnapshot;
  } | null>(null);
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(readDesktopSidebarCollapsed);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = localStorage.getItem(DESKTOP_SIDEBAR_WIDTH_KEY);
      if (saved) {
        const w = parseInt(saved, 10);
        if (w >= DESKTOP_SIDEBAR_MIN_WIDTH && w <= DESKTOP_SIDEBAR_MAX_WIDTH) return w;
      }
    } catch { /* ignore */ }
    return DESKTOP_SIDEBAR_WIDTH;
  });
  const handleSidebarWidthChange = useCallback((width: number) => {
    setSidebarWidth(width);
    try { localStorage.setItem(DESKTOP_SIDEBAR_WIDTH_KEY, String(width)); } catch { /* ignore */ }
  }, []);
  /** Settings open state comes from the route (`?utility=settings`) via `initialUtility`; avoid duplicate React state so toggles are not overwritten by URL sync. */
  const utilityPanel: UtilityPanelId = initialUtility;
  const [activeProjectId, setActiveProjectId] = useState(
    session?.projectId ?? session?.currentProjectSnapshot?.projectId,
  );
  const [compactedMessageCount, setCompactedMessageCount] = useState(session?.compactedMessageCount ?? 0);
  const [maintenanceHints, setMaintenanceHints] = useState<HomeAgentMaintenanceHintNotice[]>([]);
  const [sidebarAssetFocus, setSidebarAssetFocus] = useState<{ assetId: string; message: string } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ projectId: string; title: string } | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pendingDeleteSnapshot, setPendingDeleteSnapshot] = useState<ConversationProjectSnapshot | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [jimengExecutionMode, setJimengExecutionMode] = useState<JimengExecutionMode>("api");
  const [launchReadiness, setLaunchReadiness] = useState<HomeAgentLaunchReadiness | null>(null);
  const [suppressedLaunchNoticeKey, setSuppressedLaunchNoticeKey] = useState<string | null>(null);
  const [activeWorkflowAction, setActiveWorkflowAction] = useState<string | null>(null);
  const [selectedTextModelKey, setSelectedTextModelKey] = useState(() =>
    normalizeHomeAgentTextModelKey(session?.selectedTextModelKey ?? readStoredHomeAgentTextModelKey()),
  );
  const [imageGenerationPrefs, setImageGenerationPrefs] = useState<VideoImageGenerationPrefs>(
    initialImageGenerationPrefs,
  );
  const [selectedImageModelFamily, setSelectedImageModelFamily] = useState<VideoImageModelFamilyKey>(() =>
    normalizeHomeAgentImageModelFamilyKey(
      session?.selectedImageModelFamily ?? initialImageGenerationPrefs.familyKey,
    ),
  );
  const [videoGenerationPrefs, setVideoGenerationPrefs] = useState<VideoGenerationPrefs>(
    initialVideoGenerationPrefs,
  );
  const [selectedVideoModelKey, setSelectedVideoModelKey] = useState<VideoGenerationModelKey>(() =>
    normalizeHomeAgentVideoModelKey(
      session?.selectedVideoModelKey ?? initialVideoGenerationPrefs.modelKey,
    ),
  );
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [awaitingVideoKickoffStyleReferenceUpload, setAwaitingVideoKickoffStyleReferenceUpload] = useState(false);
  const [awaitingCharacterAudioReferenceUpload, setAwaitingCharacterAudioReferenceUpload] = useState(false);

  useEffect(() => {
    writeStoredCreationMode(creationMode);
  }, [creationMode]);

  useEffect(() => {
    writeStoredDevMode(devMode);
  }, [devMode]);
  useEffect(() => {
    if (runtime.currentProjectSnapshot?.projectKind === "video") return;
    pendingVideoKickoffStyleReferenceUploadRef.current = null;
    pendingCharacterAudioReferenceUploadRef.current = null;
    characterAudioPresetPickerRef.current = null;
    setAwaitingVideoKickoffStyleReferenceUpload(false);
    setAwaitingCharacterAudioReferenceUpload(false);
  }, [runtime.currentProjectSnapshot?.projectId, runtime.currentProjectSnapshot?.projectKind]);

  // 鍚屾 activeProjectId 鍒?localStorage锛屼緵 uploadImageToStorage 绛夊伐鍏峰嚱鏁拌鍙?
  useEffect(() => {
    if (activeProjectId) {
      localStorage.setItem("storyforge_current_project", activeProjectId);
    }
  }, [activeProjectId]);

  const runtimeRef = useRef(runtime);
  const messagesRef = useRef(messages);
  const inlineAttachmentGuardAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const compactedMessageCountRef = useRef(compactedMessageCount);
  const draftRef = useRef(session?.draft ?? "");
  const draftPersistTimerRef = useRef<number | null>(null);
  const engineRef = useRef<QueryEngine | null>(null);
  const handoffRef = useRef(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const surfacedTaskIdsRef = useRef<Set<string>>(new Set());
  const surfacedTaskFollowupIdsRef = useRef<Set<string>>(new Set());
  const restoredTaskFollowupSuppressionRef = useRef<{
    sessionId: string;
    restoredAt: number;
  } | null>(null);
  const backgroundResearchGroupsRef = useRef<import("./home-agent-task-utils").BackgroundResearchGroup[]>([]);
  const surfacedProjectSuggestionKeysRef = useRef<Set<string>>(new Set());
  const restoredProjectSuggestionKeysRef = useRef<Set<string>>(new Set());
  const dismissedProjectSuggestionKeysRef = useRef<Set<string>>(new Set());
  const dismissedDeferredQuestionStepRef = useRef<string | null>(null);
  const pendingVideoKickoffStyleReferenceUploadRef = useRef<{ label: string } | null>(null);
  const pendingCharacterAudioReferenceUploadRef = useRef<PendingCharacterAudioUploadRequest | null>(
    null,
  );
  const characterAudioPresetPickerRef = useRef<CharacterAudioPresetPickerRequest | null>(null);
  const preferredVideoWorkflowSourceSnapshotRef = useRef<ConversationProjectSnapshot | null>(
    isBridgeableVideoWorkflowSourceSnapshot(runtime.currentProjectSnapshot)
      ? runtime.currentProjectSnapshot
      : null,
  );
  // 璁板綍鐢ㄦ埛涓诲姩鏀惧純鐨勯」鐩?ID锛岄槻姝㈠叾鍚庡彴 delta 浜嬩欢姹℃煋鏂伴」鐩潰鏉?
  const staleProjectIdsRef = useRef<Set<string>>(new Set());
  const filterRecentlyDeletedProjectSnapshots = useCallback(
    (items: ConversationProjectSnapshot[]) =>
      items.filter((item) => {
        const projectId = item.projectId?.trim();
        if (!projectId) return false;
        if (staleProjectIdsRef.current.has(projectId)) return false;
        if (hasSessionResetMarkerForProject(projectId)) return false;
        return true;
      }),
    [],
  );
  // 防止 workflow shortcut 和后台轮询同时 dispatch agent:video-generated 导致重复消息
  const recentlyProcessedVideoUrlsRef = useRef<Set<string>>(new Set());
  const pendingHomepageIsolationModeRef = useRef<AutomationMode | null>(null);
  const previousHistoryAutomationModeRef = useRef(historyAutomationMode);
  const hasSkippedInitialRecentProjectRefreshRef = useRef(false);
  const lastIsolationHistoryRefreshKeyRef = useRef<string | null>(null);
  const rememberedProjectIdsByModeRef = useRef(
    createAutomationModeProjectMemory(session?.currentProjectSnapshot ?? null),
  );
  const maintenanceHintTimerRef = useRef<Map<string, number>>(new Map());
  const lastVideoGenerationModeNoticeKeyRef = useRef<string | null>(null);
  const compactionJobVersionRef = useRef(0);
  const projectHydrationInFlightRef = useRef<string | null>(null);
  const segmentContinuityBackfillSeenRef = useRef<Set<string>>(new Set());
  const segmentContinuityBackfillInFlightRef = useRef<Set<string>>(new Set());
  const previousComposerProjectIdRef = useRef(activeProjectId);
  const hasObservedComposerProjectSelectionRef = useRef(false);
  const selectedTextModelKeyRef = useRef(selectedTextModelKey);
  // 鍒囨崲椤圭洰鍓嶅悓姝?flush 褰撳墠浼氳瘽锛岄槻姝㈤槻鎶栦繚瀛樿鍙栨秷瀵艰嚧鐘舵€佷涪澶?
  const flushSessionRef = useRef<() => void>(() => {});
  const previousQuestionStepRef = useRef<string | null>(
    session?.qState ? `${session.qState.request.id}:${session.qState.currentIndex}` : null,
  );
  const handleRequestOlderHistory = useCallback(async (): Promise<boolean> => {
    const projectId = activeProjectId ?? runtimeRef.current.currentProjectSnapshot?.projectId;
    if (!projectId) return false;

    const persistedSession =
      (await readProjectSessionFromFile(projectId)) ??
      readStudioProjectSession(projectId);
    if (!persistedSession?.messages?.length) return false;

    const currentMessages = messagesRef.current;
    if (persistedSession.messages.length <= currentMessages.length) return false;
    if (!isMessageTailSubset(currentMessages, persistedSession.messages)) return false;

    startTransition(() => {
      setMessages(persistedSession.messages);
      setCompactedMessageCount((previous) =>
        Math.max(previous, persistedSession.compactedMessageCount ?? previous),
      );
      setRuntime((prev) => ({
        ...prev,
        recentMessageSummary: persistedSession.recentMessageSummary ?? prev.recentMessageSummary,
        recentProjectSessions: upsertRecentProjectSession(prev.recentProjectSessions, persistedSession),
      }));
    });
    return true;
  }, [activeProjectId, setRuntime]);
  const interruptRestoreQuestionRef = useRef<ComposerQuestion | null>(session?.interruptedChoiceQuestion ?? null);
  const workflowRefreshShortcutRunnerRef = useRef<
    | ((
        action: string,
        input: Record<string, unknown>,
        label: string,
        options?: {
          restoreQuestionOnInterrupt?: ComposerQuestion | null;
          restoreQuestionOnCancel?: ComposerQuestion | null;
          restoreQuestionOnError?: ComposerQuestion | null;
          restoreQuestionAfterRun?: ComposerQuestion | null;
          skipUserBubble?: boolean;
        },
      ) => void)
    | null
  >(null);
  const workflowRefreshShortcutChainRunnerRef = useRef<
    | ((
        steps: Array<{ action: string; input: Record<string, unknown> }>,
        label: string,
        options?: {
          restoreQuestionOnInterrupt?: ComposerQuestion | null;
          restoreQuestionOnError?: ComposerQuestion | null;
          restoreQuestionAfterRun?: ComposerQuestion | null;
          skipUserBubble?: boolean;
        },
      ) => void)
    | null
  >(null);
  useEffect(() => {
    if (!isBridgeableVideoWorkflowSourceSnapshot(runtime.currentProjectSnapshot)) return;
    preferredVideoWorkflowSourceSnapshotRef.current = runtime.currentProjectSnapshot;
  }, [runtime.currentProjectSnapshot]);
  if (surfacedTaskIdsRef.current.size === 0 && session?.surfacedTaskIds?.length) {
    surfacedTaskIdsRef.current = new Set(session.surfacedTaskIds);
  }
  if (surfacedTaskFollowupIdsRef.current.size === 0 && session?.surfacedTaskFollowupKeys?.length) {
    surfacedTaskFollowupIdsRef.current = new Set(session.surfacedTaskFollowupKeys);
  }
  if (surfacedProjectSuggestionKeysRef.current.size === 0 && session?.surfacedProjectSuggestionKeys?.length) {
    surfacedProjectSuggestionKeysRef.current = new Set(session.surfacedProjectSuggestionKeys);
  }
  if (restoredProjectSuggestionKeysRef.current.size === 0 && session?.surfacedProjectSuggestionKeys?.length) {
    restoredProjectSuggestionKeysRef.current = new Set(session.surfacedProjectSuggestionKeys);
  }
  useEffect(() => {
    dismissedProjectSuggestionKeysRef.current.clear();
    dismissedDeferredQuestionStepRef.current = null;
    setPendingDeferredQuestionRestoreAfterAssistantReply(null);
  }, [activeProjectId]);
  useEffect(() => {
    if (!runtime.currentProjectSnapshot?.projectId) return;
    rememberedProjectIdsByModeRef.current = rememberProjectForAutomationMode(
      rememberedProjectIdsByModeRef.current,
      runtime.currentProjectSnapshot,
    );
  }, [runtime.currentProjectSnapshot]);
  useEffect(() => {
    const previousProjectId = previousComposerProjectIdRef.current;
    if (
      didSessionScopedProjectSwitch(
        hasObservedComposerProjectSelectionRef.current,
        previousProjectId,
        activeProjectId,
      )
    ) {
      setAttachedFiles([]);
      pendingVideoKickoffStyleReferenceUploadRef.current = null;
      setAwaitingVideoKickoffStyleReferenceUpload(false);
    }
    previousComposerProjectIdRef.current = activeProjectId;
    hasObservedComposerProjectSelectionRef.current = true;
  }, [activeProjectId]);
  const {
    loadEngineDeps,
    loadProjectStore,
    loadApiConfigModule,
    loadAskUserQuestionModule,
    loadStructuredQuestionParser,
    loadWorkflowActionsModule,
    loadSemanticSummaryModule,
    loadConversationMemoryModule,  } = useHomeAgentModuleLoaders();

  const { currentProject, question } = useHomeAgentQuestionView({
    runtime,
    qState,
    popoverOverride,
    interruptedChoiceQuestion:
      activeWorkflowAction || streaming ? null : interruptedChoiceQuestion,
    suggested,
    selectedValues,
    dismissedProjectSuggestionKeys: dismissedProjectSuggestionKeysRef.current,
    dismissedQuestionStepKey: dismissedDeferredQuestionStepRef.current,
    devMode,
  });
  useEffect(() => {
    interruptRestoreQuestionRef.current = interruptedChoiceQuestion;
  }, [interruptedChoiceQuestion]);

  useEffect(() => {
    if (!question || !interruptedChoiceQuestion) return;
    if (question.id === interruptedChoiceQuestion.id) return;
    setInterruptedChoiceQuestion(null);
  }, [interruptedChoiceQuestion, question]);
  const maintenanceHint = maintenanceHints.length ? maintenanceHints[maintenanceHints.length - 1]?.message ?? null : null;
  const persistedVisibleChoiceQuestion =
    pendingWorkflowUploadKind || qState || deferredQuestionState
      ? null
      : (question ?? popoverOverride ?? suggested ?? interruptedChoiceQuestion ?? null);

  const {
    idle,
    activeTheme,
    placeholder,
    deferredMessages,
    deferredProjectSnapshot,
    deferredRecentProjects,
    reduceMotion,
    settingsOpen,
    desktopSidebarOffset,
    recentSessionSummary,
    flashMaintenanceHint,
    dismissMaintenanceHint,
    syncComposerDraft,
    resetComposerDraft,
    composerShellClass,
    deferredSidebarAssets,
    visibleTasks,
    deferredVisibleTasks,
  } = useHomeAgentSurfaceState({
    mode,
    messages,
    currentProject,
    question,
    utilityPanel,
    desktopSidebarCollapsed,
    mobileNavOpen,
    runtime,
    tasks,
    activeProjectId,
    maintenanceHintTimerRef,
    draftPersistTimerRef,
    draftRef,
    setMaintenanceHints,
    setDraftPresence,
    setPersistedDraft,
    setDraftInitialValue,
    setDraftResetVersion,
    truncateCopy,
    isTaskVisibleForSession,
    idlePlaceholder: IDLE,
    activePlaceholder: ACTIVE,
    customPlaceholder: CUSTOM,
    desktopSidebarOffsetExpanded: sidebarWidth + (DESKTOP_SIDEBAR_OFFSET - DESKTOP_SIDEBAR_WIDTH),
    desktopSidebarOffsetCollapsed: DESKTOP_SIDEBAR_COLLAPSED_OFFSET,
  });

  useEffect(() => {
    const notice = runtime.currentVideoProject?.videoGenerationModeNotice;
    if (!notice?.message) return;
    const noticeKey = [
      runtime.currentVideoProject?.id ?? "",
      notice.activeMode,
      notice.updatedAt,
      notice.message,
    ].join(":");
    if (lastVideoGenerationModeNoticeKeyRef.current === noticeKey) return;
    lastVideoGenerationModeNoticeKeyRef.current = noticeKey;
    flashMaintenanceHint(notice.message, 9000);
  }, [
    flashMaintenanceHint,
    runtime.currentVideoProject?.id,
    runtime.currentVideoProject?.videoGenerationModeNotice?.activeMode,
    runtime.currentVideoProject?.videoGenerationModeNotice?.message,
    runtime.currentVideoProject?.videoGenerationModeNotice?.updatedAt,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(HOME_AGENT_DESKTOP_LAYOUT_INVALIDATE_EVENT));
  }, [desktopSidebarOffset]);

  const lastMessageForScroll = messages[messages.length - 1];
  const lastMessageHasMedia = Boolean(
    lastMessageForScroll?.attachments?.some((attachment) => attachment.kind === "image" || attachment.kind === "video"),
  );
  const lastAttachmentScrollKey =
    lastMessageForScroll?.attachments
      ?.map((attachment) =>
        [
          attachment.id,
          attachment.pending ? "pending" : "ready",
          attachment.failed ? "failed" : "ok",
          attachment.previewUrl ?? attachment.localPath ?? "",
        ].join(":"),
      )
      .join("|") ?? "";
  const preferPhysicalBottomWhileStreaming =
    Boolean(streaming) && lastMessageForScroll?.role === "assistant";
  const { hasUnreadMessage, scrollToPhysicalBottom } = useSmartScroll({
    containerRef: scrollContainerRef,
    endRef,
    active: !idle,
    forceBottomDependency:
      lastMessageForScroll?.role === "user" ||
      (lastMessageForScroll?.role === "assistant" && lastMessageHasMedia) ||
      qState?.source === "restored"
        ? `${lastMessageForScroll.id}:${lastMessageForScroll.content.length}:${lastAttachmentScrollKey}`
        : null,
    followTargetSelector: "[data-home-agent-message-row]",
    followTargetOffsetRatio: 0.36,
    resetKey: activeProjectId ?? runtime.currentProjectSnapshot?.projectId ?? null,
    showUnreadOnBlocked: lastMessageForScroll?.role === "assistant",
    preferPhysicalBottomWhenLocked: preferPhysicalBottomWhileStreaming,
    dependency: `${messages.length}:${lastMessageForScroll?.id ?? ""}:${lastMessageForScroll?.content.length ?? 0}:${lastAttachmentScrollKey}:${streaming ? "streaming" : "idle"}`,
  });
  const previousStreamingForScrollRef = useRef(streaming);
  useEffect(() => {
    const wasStreaming = previousStreamingForScrollRef.current;
    previousStreamingForScrollRef.current = streaming;
    if (!wasStreaming || streaming) return;
    if (lastMessageForScroll?.role !== "assistant") return;

    const snapToBottom = () => {
      scrollToPhysicalBottom(true);
    };

    snapToBottom();
    const rafId = window.requestAnimationFrame(snapToBottom);
    const timeoutId = window.setTimeout(snapToBottom, 80);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(timeoutId);
    };
  }, [lastMessageForScroll?.id, lastMessageForScroll?.role, scrollToPhysicalBottom, streaming]);
  const requestScrollToBottomAfterQuickLaunch = useCallback(() => {
    if (typeof window === "undefined") return;
    const requestPhysicalBottom = () => {
      scrollToPhysicalBottom(true);
    };
    requestPhysicalBottom();
    window.requestAnimationFrame(() => {
      requestPhysicalBottom();
      window.requestAnimationFrame(() => {
        requestPhysicalBottom();
      });
    });
    window.setTimeout(requestPhysicalBottom, 80);
    window.setTimeout(requestPhysicalBottom, 220);
  }, [scrollToPhysicalBottom]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (qState?.source !== "restored") return;

    const forcePhysicalBottom = () => {
      const element = scrollContainerRef.current;
      if (!element) return;
      element.scrollTop = element.scrollHeight;
      scrollToPhysicalBottom(true);
    };

    forcePhysicalBottom();
    const rafId = window.requestAnimationFrame(() => {
      forcePhysicalBottom();
    });
    const timeoutIds = [80, 220].map((delay) => window.setTimeout(forcePhysicalBottom, delay));
    return () => {
      window.cancelAnimationFrame(rafId);
      timeoutIds.forEach((id) => window.clearTimeout(id));
    };
  }, [qState?.request.id, qState?.source, scrollToPhysicalBottom]);
  useEffect(() => {
    if (!sidebarAssetFocus) return;
    const timer = window.setTimeout(() => {
      setSidebarAssetFocus((current) =>
        current?.assetId === sidebarAssetFocus.assetId ? null : current,
      );
    }, 2600);
    return () => window.clearTimeout(timer);
  }, [sidebarAssetFocus]);
  const textModelGroups = useMemo(() => groupHomeAgentTextModelOptions(), []);
  const imageModelOptions = useMemo(() => listHomeAgentImageModelFamilies(), []);
  const videoModelOptions = useMemo(() => listHomeAgentVideoModels(), []);
  const selectedTextModelOption = useMemo(
    () => getHomeAgentTextModelOption(selectedTextModelKey),
    [selectedTextModelKey],
  );
  const selectedImageModelOption = useMemo(
    () => getHomeAgentImageModelFamilyOption(selectedImageModelFamily),
    [selectedImageModelFamily],
  );
  const selectedVideoModelOption = useMemo(
    () => getHomeAgentVideoModelOption(selectedVideoModelKey),
    [selectedVideoModelKey],
  );
  const sidebarTemplates = useMemo(
    () =>
      templates.map((template) => {
        if (automationMode !== "full-auto") return template;
        if (template.id === "script") {
          return {
            ...template,
            badge: "全自动",
            description: "一次确认参数后自动推进原创剧本到视频导出。",
          };
        }
        if (template.id === "adaptation") {
          return {
            ...template,
            badge: "全自动",
            disabled: false,
            description: "上传或粘贴参考文本后，自动完成改编、视频生成和导出。",
          };
        }
        if (template.id === "video") {
          return {
            ...template,
            badge: "全自动",
            disabled: false,
            description: "接入当前剧本或上传正文后，自动完成拆解、分镜、生成和导出。",
          };
        }
        return template;
      }),
    [automationMode],
  );

  const refreshLaunchReadiness = useCallback(async () => {
    try {
      const nextReadiness = await readHomeAgentLaunchReadiness();
      setLaunchReadiness(nextReadiness);
      setJimengExecutionMode((current) =>
        current === nextReadiness.video.mode ? current : nextReadiness.video.mode,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "启动前检查失败";
      setLaunchReadiness({
        checkedAt: new Date().toISOString(),
        textReady: false,
        textMessage: message,
        image: {
          ready: false,
          label: "图像生成待配置",
          detail: message,
          tone: "warning",
        },
        video: {
          mode: "api",
          ready: false,
          label: "当前默认走 API",
          detail: message,
          tone: "warning",
        },
        notice: {
          level: "critical",
          title: "启动前检查失败",
          description: message,
          actions: [{ id: "open_settings", label: "去设置检查" }],
        },
      });
      setJimengExecutionMode("api");
    }
  }, []);

  useEffect(() => {
    runtimeRef.current = runtime;
  }, [runtime]);

  const refreshSegmentContinuityArtifactsInProject = useCallback(
    async (params: {
      project: ActiveVideoProject;
      segmentLabel: string;
      videoUrl?: string;
      progressPreset?: "default" | "history-backfill";
    }) => {
      const { refreshSegmentContinuityArtifactsFromSegmentVideoSource } = await loadVideoWorkflowService();
      return synchronizeVideoProductionState(
        await refreshSegmentContinuityArtifactsFromSegmentVideoSource({
          project: params.project,
          segmentLabel: params.segmentLabel,
          videoUrl: params.videoUrl,
          progressPreset: params.progressPreset,
        }),
      );
    },
    [],
  );

  const refreshAndPersistSegmentContinuityArtifacts = useCallback(
    async (params: {
      project: ActiveVideoProject;
      segmentLabel: string;
      videoUrl?: string;
      progressPreset?: "default" | "history-backfill";
    }) => {
      const refreshedProject = await refreshSegmentContinuityArtifactsInProject({
        project: params.project,
        segmentLabel: params.segmentLabel,
        videoUrl: params.videoUrl,
        progressPreset: params.progressPreset,
      });
      const savedProject = await upsertStoredVideoProject(refreshedProject);

      startTransition(() => {
        setRuntime((prev) => {
          if (prev.currentVideoProject?.id !== savedProject.id) return prev;
          return {
            ...prev,
            currentVideoProject: savedProject,
            currentProjectSnapshot:
              prev.currentProjectSnapshot?.projectId === savedProject.id
                ? {
                    ...prev.currentProjectSnapshot,
                    memory: {
                      ...prev.currentProjectSnapshot.memory,
                      assetManifest: savedProject.assetManifest,
                    },
                  }
                : prev.currentProjectSnapshot,
          };
        });
      });

      return savedProject;
    },
    [refreshSegmentContinuityArtifactsInProject, setRuntime],
  );

  useEffect(() => {
    const snapshot = runtime.currentProjectSnapshot;
    const project = runtime.currentVideoProject;
    if (!snapshot || !project || snapshot.projectId !== project.id) return;

    const candidate = Object.keys(project.segmentVideos ?? {})
      .map((segmentLabel) => {
        const localVideoUrl = resolveLocalSegmentContinuityBackfillVideoUrl(project, segmentLabel);
        const hasContinuityGrid = hasSegmentContinuityGridForProject(project, segmentLabel);
        const key = `${project.id}:${segmentLabel}:${localVideoUrl || ""}`;
        return {
          segmentLabel,
          localVideoUrl,
          hasContinuityGrid,
          key,
        };
      })
      .find(({ localVideoUrl, hasContinuityGrid, key }) =>
        Boolean(localVideoUrl) &&
        !hasContinuityGrid &&
        !segmentContinuityBackfillSeenRef.current.has(key) &&
        !segmentContinuityBackfillInFlightRef.current.has(key),
      );

    if (!candidate?.localVideoUrl) return;

    let cancelled = false;
    segmentContinuityBackfillInFlightRef.current.add(candidate.key);
    void (async () => {
      try {
        await refreshAndPersistSegmentContinuityArtifacts({
          project,
          segmentLabel: candidate.segmentLabel,
          videoUrl: candidate.localVideoUrl,
          progressPreset: "history-backfill",
        });
        if (cancelled) return;
      } catch {
        /* ignore backfill failures; the sidebar progress event already reflects them when available */
      } finally {
        segmentContinuityBackfillInFlightRef.current.delete(candidate.key);
        segmentContinuityBackfillSeenRef.current.add(candidate.key);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [runtime.currentProjectSnapshot, runtime.currentVideoProject, setRuntime]);

  const handleRefreshSegmentContinuityAsset = useCallback(
    async (asset: SidebarAssetItem) => {
      if (asset.kind !== "video" || asset.subKind !== "segment") return;

      const segmentLabel = String(asset.segmentLabel || "").trim();
      const snapshot = runtimeRef.current.currentProjectSnapshot;
      const project = runtimeRef.current.currentVideoProject;
      if (!segmentLabel || !snapshot || !project || snapshot.projectId !== project.id) {
        flashMaintenanceHint("仅正式片段支持更新六格。", 2400);
        return;
      }

      const localVideoUrl =
        resolveLocalSegmentContinuityBackfillVideoUrl(project, segmentLabel) ||
        (isLocalSidebarAssetUrl(asset.url) ? asset.url : undefined);
      if (!localVideoUrl) {
        flashMaintenanceHint("当前片段暂无本地正式视频，无法更新六格。", 2600);
        return;
      }

      const refreshKey = `${project.id}:${segmentLabel}:${localVideoUrl}`;
      if (segmentContinuityBackfillInFlightRef.current.has(refreshKey)) {
        flashMaintenanceHint("这个片段的六宫格正在更新中。", 2000);
        return;
      }

      const alreadyReady = Boolean(project.segmentContinuityGridImages?.[segmentLabel]?.imageUrl?.trim());
      segmentContinuityBackfillInFlightRef.current.add(refreshKey);
      const extractingMessage = alreadyReady
        ? `正在更新片段 ${segmentLabel} 六格…`
        : `正在为片段 ${segmentLabel} 组六格…`;
      flashMaintenanceHint(
        extractingMessage,
        2200,
      );

      try {
        await refreshAndPersistSegmentContinuityArtifacts({
          project,
          segmentLabel,
          videoUrl: localVideoUrl,
        });
        segmentContinuityBackfillSeenRef.current.add(refreshKey);
        setSidebarAssetFocus({
          assetId: asset.id,
          message: alreadyReady ? "六格已更新" : "已组六格",
        });
        flashMaintenanceHint(
          alreadyReady ? `片段 ${segmentLabel} 六格已更新。` : `片段 ${segmentLabel} 已组六格。`,
          2200,
        );
      } catch (error) {
        flashMaintenanceHint(error instanceof Error ? error.message : "更新六格失败。", 2600);
      } finally {
        segmentContinuityBackfillInFlightRef.current.delete(refreshKey);
      }
    },
    [flashMaintenanceHint, refreshAndPersistSegmentContinuityArtifacts],
  );

  useEffect(() => {
    if (!needsBootstrapSessionHydration || !session?.sessionId) return;

    let cancelled = false;
    const seedSessionId = session.sessionId;
    const seedMessageCount = session.messages.length;
    const seedCompactedMessageCount = session.compactedMessageCount ?? 0;
    const seedDraft = session.draft ?? "";
    const cancelTask = scheduleBackgroundTask(async () => {
      const localHydratedSession = readStudioSession();
      const fileHydratedSession = localHydratedSession?.projectId
        ? await readProjectSessionFromFile(localHydratedSession.projectId)
        : null;
      const hydratedSession =
        fileHydratedSession &&
        (!localHydratedSession || fileHydratedSession.messages.length >= localHydratedSession.messages.length)
          ? fileHydratedSession
          : localHydratedSession;
      if (cancelled || !hydratedSession || hydratedSession.sessionId !== seedSessionId) return;

      React.startTransition(() => {
        setRuntime((prev) => {
          if (prev.sessionId !== seedSessionId) return prev;
          return {
            ...prev,
            currentProjectSnapshot: hydratedSession.currentProjectSnapshot ?? prev.currentProjectSnapshot,
            recentMessageSummary: hydratedSession.recentMessageSummary ?? prev.recentMessageSummary,
          };
        });
        setMessages((prev) => (prev.length === seedMessageCount ? sanitizePendingAttachments(hydratedSession.messages) : prev));
        setCompactedMessageCount((prev) =>
          prev === seedCompactedMessageCount ? (hydratedSession.compactedMessageCount ?? prev) : prev,
        );
        setFullAutoChecklistCollapsed(hydratedSession.fullAutoChecklistCollapsed ?? true);
        if (resolveComposerDraftSnapshot(draftRef.current, persistedDraft) === seedDraft) {
          resetComposerDraft(hydratedSession.draft ?? "");
        }
      });
    }, 1200);

    return () => {
      cancelled = true;
      cancelTask();
    };
  }, [
    needsBootstrapSessionHydration,
    persistedDraft,
    resetComposerDraft,
    session,
    setCompactedMessageCount,
    setMessages,
    setRuntime,
  ]);

  useEffect(() => {
    if (suggested !== null) {
      lastSuggestedRef.current = suggested;
    }
  }, [suggested]);

  const restoreInterruptedChoiceQuestion = useCallback(
    (questionToRestore: ComposerQuestion | null) => {
      const resolvedQuestion = questionToRestore ?? interruptRestoreQuestionRef.current;
      if (!resolvedQuestion) return false;

      const snapshot = runtimeRef.current.currentProjectSnapshot;
      const suggestionKey = buildProjectSuggestionKey(snapshot, resolvedQuestion);
      if (suggestionKey) {
        dismissedProjectSuggestionKeysRef.current.delete(suggestionKey);
        restoredProjectSuggestionKeysRef.current.add(suggestionKey);
        surfacedProjectSuggestionKeysRef.current.add(suggestionKey);
      }

      setMode("active");
      setQState(null);
      setSelectedValues([]);
      resetComposerDraft("");
      setSuggested(null);
      setInterruptedChoiceQuestion(resolvedQuestion);
      setPopoverOverride(resolvedQuestion);
      return true;
    },
    [
      resetComposerDraft,
      setMode,
      setInterruptedChoiceQuestion,
      setPopoverOverride,
      setQState,
      setSelectedValues,
      setSuggested,
    ],
  );

  const openWorkflowPopoverQuestion = useCallback(
    (nextQuestion: ComposerQuestion | null) => {
      if (!nextQuestion) return false;

      const snapshot = runtimeRef.current.currentProjectSnapshot;
      const suggestionKey = buildProjectSuggestionKey(snapshot, nextQuestion);
      if (suggestionKey) {
        dismissedProjectSuggestionKeysRef.current.delete(suggestionKey);
        surfacedProjectSuggestionKeysRef.current.add(suggestionKey);
      }

      setMode("active");
      setQState(null);
      setSelectedValues([]);
      resetComposerDraft("");
      setSuggested(null);
      setInterruptedChoiceQuestion(null);
      setPopoverOverride(nextQuestion);
      return true;
    },
    [
      resetComposerDraft,
      setMode,
      setInterruptedChoiceQuestion,
      setPopoverOverride,
      setQState,
      setSelectedValues,
      setSuggested,
    ],
  );

  const queueWorkflowPopoverAfterAssistantReply = useCallback(
    (nextQuestion: ComposerQuestion | null) => {
      if (!nextQuestion) {
        setPendingWorkflowPopoverAfterAssistantReply(null);
        return;
      }

      const lastAssistantMessage =
        [...messages].reverse().find((message) => message.role === "assistant") ?? null;
      setPendingWorkflowPopoverAfterAssistantReply({
        question: nextQuestion,
        lastAssistantMessageId: lastAssistantMessage?.id ?? null,
        projectId: runtimeRef.current.currentProjectSnapshot?.projectId ?? null,
      });
    },
    [messages, runtimeRef],
  );

  const restorePendingCharacterAudioUploadContext = useCallback(
    (restoreContext: PendingCharacterAudioUploadRestoreContext | null) => {
      if (!restoreContext) return false;

      const {
        question: questionToRestore,
        qState: questionStateToRestore,
        selectedValues: selectedValuesToRestore,
        draft: draftToRestore,
      } = restoreContext;

      if (questionStateToRestore) {
        const suggestionKey = buildProjectSuggestionKey(
          runtimeRef.current.currentProjectSnapshot,
          questionToRestore,
        );
        if (suggestionKey) {
          dismissedProjectSuggestionKeysRef.current.delete(suggestionKey);
          restoredProjectSuggestionKeysRef.current.add(suggestionKey);
          surfacedProjectSuggestionKeysRef.current.add(suggestionKey);
        }

        dismissedDeferredQuestionStepRef.current = null;
        setPendingDeferredQuestionRestoreAfterAssistantReply(null);
        setDeferredQuestionState(null);
        setDeferredSelectedValues([]);
        setDeferredDraft("");
        setMode("active");
        setPopoverOverride(null);
        setInterruptedChoiceQuestion(null);
        setSuggested(null);
        setQState({ ...questionStateToRestore });
        setSelectedValues([...selectedValuesToRestore]);
        resetComposerDraft(draftToRestore);
        return true;
      }

      if (!questionToRestore) return false;

      setPendingDeferredQuestionRestoreAfterAssistantReply(null);
      setDeferredQuestionState(null);
      setDeferredSelectedValues([]);
      setDeferredDraft("");
      const restored = restoreInterruptedChoiceQuestion(questionToRestore);
      if (!restored) return false;
      setSelectedValues([...selectedValuesToRestore]);
      resetComposerDraft(draftToRestore);
      return true;
    },
    [
      resetComposerDraft,
      restoreInterruptedChoiceQuestion,
      runtimeRef,
      setMode,
      setPopoverOverride,
      setInterruptedChoiceQuestion,
      setQState,
      setSelectedValues,
      setSuggested,
    ],
  );

  const queuePendingCharacterAudioRestoreAfterAssistantReply = useCallback(
    (restoreContext: PendingCharacterAudioUploadRestoreContext | null) => {
      if (!restoreContext) return false;

      if (restoreContext.qState) {
        const currentProjectId = resolveSessionProjectIdForSnapshot({
          currentSessionProjectId: activeProjectId,
          snapshot: runtimeRef.current.currentProjectSnapshot,
          fallbackProjectId:
            runtimeRef.current.currentProjectSnapshot?.projectId ?? activeProjectId,
        });
        const stepKey = `${restoreContext.qState.request.id}:${restoreContext.qState.currentIndex}`;
        const lastAssistantMessage =
          [...messages].reverse().find((message) => message.role === "assistant") ??
          null;

        dismissedDeferredQuestionStepRef.current = stepKey;
        setDeferredQuestionState({
          ...restoreContext.qState,
          source: "deferred",
        });
        setDeferredSelectedValues([...restoreContext.selectedValues]);
        setDeferredDraft(restoreContext.draft);
        setPendingDeferredQuestionRestoreAfterAssistantReply({
          stepKey,
          lastAssistantMessageId: lastAssistantMessage?.id ?? null,
          projectId: currentProjectId ?? null,
        });
        return true;
      }

      if (restoreContext.question) {
        queueWorkflowPopoverAfterAssistantReply(restoreContext.question);
        return true;
      }

      return false;
    },
    [
      activeProjectId,
      messages,
      queueWorkflowPopoverAfterAssistantReply,
      runtimeRef,
    ],
  );

  const resolvePendingCharacterAudioUploadRequest = useCallback(
    (
      currentQuestion: ComposerQuestion | null = question,
      options?: {
        preferredRestoreQuestion?: ComposerQuestion | null;
      },
    ): PendingCharacterAudioUploadRequest | null => {
      const existingRequest = pendingCharacterAudioReferenceUploadRef.current;
      if (existingRequest) {
        return existingRequest;
      }

      const parsedQuestion = parsePendingCharacterAudioUploadQuestion(currentQuestion);
      if (!parsedQuestion) {
        return null;
      }

      const fallbackRestoreQuestion = markQuestionForExactRestore(
        options?.preferredRestoreQuestion ??
          (interruptedChoiceQuestion?.answerKey === PENDING_CHARACTER_AUDIO_QUESTION_KEY
            ? null
            : interruptedChoiceQuestion),
      );
      const fallbackRequest: PendingCharacterAudioUploadRequest = {
        label:
          currentQuestion?.options[0]?.label?.trim() ||
          (parsedQuestion.canReturnToMenu ? "返回菜单" : "取消上传"),
        characterId: parsedQuestion.characterId,
        characterName: parsedQuestion.characterName,
        restoreQuestion: fallbackRestoreQuestion ?? null,
        restoreContext: {
          question: fallbackRestoreQuestion ?? null,
          qState,
          selectedValues: [...selectedValues],
          draft: resolveComposerDraftSnapshot(draftRef.current, persistedDraft) || "",
        },
      };
      pendingCharacterAudioReferenceUploadRef.current = fallbackRequest;
      return fallbackRequest;
    },
    [draftRef, interruptedChoiceQuestion, persistedDraft, qState, question, selectedValues],
  );

  useEffect(() => {
    const pendingRequest = resolvePendingCharacterAudioUploadRequest(question);
    if (!pendingRequest) return;
    if (!awaitingCharacterAudioReferenceUpload) {
      setAwaitingCharacterAudioReferenceUpload(true);
    }
  }, [
    awaitingCharacterAudioReferenceUpload,
    question,
    resolvePendingCharacterAudioUploadRequest,
  ]);

  const reopenWorkflowPopupAfterMediaCompletion = useCallback(() => {
    if (qState || draftPresence) return false;

    const snapshot = runtimeRef.current.currentProjectSnapshot;
    if (!snapshot) return false;
    if (hasRunningVideoGenerationTasks(runtimeRef.current.currentVideoProject)) return false;

    const nextQuestion = recQuestion(snapshot, runtimeRef.current.currentVideoProject);
    if (!nextQuestion) return false;

    if (popoverOverride?.id && popoverOverride.id !== nextQuestion.id) {
      return false;
    }

    const suggestionKey = buildProjectSuggestionKey(snapshot, nextQuestion);
    if (suggestionKey) {
      dismissedProjectSuggestionKeysRef.current.delete(suggestionKey);
      surfacedProjectSuggestionKeysRef.current.add(suggestionKey);
    }

    setMode("active");
    setSelectedValues([]);
    resetComposerDraft("");
    setSuggested(null);
    setInterruptedChoiceQuestion(nextQuestion);
    setPopoverOverride(nextQuestion);
    return true;
  }, [
    draftPresence,
    setInterruptedChoiceQuestion,
    popoverOverride,
    qState,
    resetComposerDraft,
    setMode,
    setPopoverOverride,
    setSelectedValues,
    setSuggested,
  ]);

  useEffect(() => {
    writeStoredHomeAgentTextModelKey(selectedTextModelKey);
  }, [selectedTextModelKey]);

  const haveImageStylePrefsChanged = useCallback(
    (
      currentPrefs: Partial<VideoImageGenerationPrefs> | null | undefined,
      nextPrefs: VideoImageGenerationPrefs,
    ) => {
      const normalizedCurrent = normalizeVideoImageGenerationPrefs(currentPrefs);
      return (
        normalizedCurrent.styleCategory !== nextPrefs.styleCategory ||
        normalizedCurrent.stylePreset !== nextPrefs.stylePreset ||
        String(normalizedCurrent.customStylePrompt || "").trim() !==
          String(nextPrefs.customStylePrompt || "").trim()
      );
    },
    [],
  );

  const commitEffectiveImagePrefs = useCallback(
    async (
      nextPrefsInput: Partial<VideoImageGenerationPrefs>,
      options?: {
        referenceStyleSummary?: string | null;
        projectPatch?: Partial<PersistedVideoProject>;
      },
    ) => {
      const nextPrefs = applyVideoImageViewModeConstraints(nextPrefsInput);
      setSelectedImageModelFamily(nextPrefs.familyKey);
      setImageGenerationPrefs(nextPrefs);
      writeStoredHomeAgentImageGenerationPrefs(nextPrefs);

      const currentVideoProject = runtimeRef.current.currentVideoProject;
      if (!currentVideoProject) {
        return;
      }

      const styleChanged = haveImageStylePrefsChanged(currentVideoProject.imageGenerationPrefs, nextPrefs);
      const hasExplicitReferenceStyleSummary =
        options && Object.prototype.hasOwnProperty.call(options, "referenceStyleSummary");
      const nextReferenceStyleSummary = hasExplicitReferenceStyleSummary
        ? String(options?.referenceStyleSummary || "").trim() || undefined
        : styleChanged
          ? undefined
          : currentVideoProject.referenceStyleSummary;

      const nextProject = await upsertStoredVideoProject({
        ...currentVideoProject,
        artStyle: resolveVideoImageProjectArtStyle(
          nextPrefs,
          currentVideoProject.artStyle || "live-action",
        ),
        imageGenerationPrefs: nextPrefs,
        referenceStyleSummary: nextReferenceStyleSummary,
        styleLock: null,
        ...(options?.projectPatch ?? {}),
      });

      startTransition(() => {
        setRuntime((previous) => ({
          ...previous,
          currentVideoProject:
            previous.currentVideoProject?.id === nextProject.id ? nextProject : previous.currentVideoProject,
        }));
      });

      return nextProject;
    },
    [haveImageStylePrefsChanged, runtimeRef, setRuntime],
  );

  const handleSelectImageModel = useCallback(
    (familyKey: string) => {
      void commitEffectiveImagePrefs({
        ...imageGenerationPrefs,
        familyKey: normalizeHomeAgentImageModelFamilyKey(familyKey),
      });
    },
    [commitEffectiveImagePrefs, imageGenerationPrefs],
  );

  const handleConfirmImageSettings = useCallback(
    (nextPrefs: VideoImageGenerationPrefs) => {
      void commitEffectiveImagePrefs({
        ...nextPrefs,
        familyKey: selectedImageModelFamily,
      });
    },
    [commitEffectiveImagePrefs, selectedImageModelFamily],
  );

  const commitEffectiveVideoPrefs = useCallback(
    async (nextPrefsInput: Partial<VideoGenerationPrefs>) => {
      const nextPrefs = normalizeVideoGenerationPrefs(nextPrefsInput);
      setSelectedVideoModelKey(nextPrefs.modelKey);
      setVideoGenerationPrefs(nextPrefs);
      writeStoredHomeAgentVideoGenerationPrefs(nextPrefs);

      const currentVideoProject = runtimeRef.current.currentVideoProject;
      if (!currentVideoProject) {
        return;
      }

      const nextProject = await upsertStoredVideoProject({
        ...currentVideoProject,
        videoGenerationPrefs: nextPrefs,
      });

      startTransition(() => {
        setRuntime((previous) => ({
          ...previous,
          currentVideoProject:
            previous.currentVideoProject?.id === nextProject.id ? nextProject : previous.currentVideoProject,
        }));
      });
    },
    [runtimeRef, setRuntime],
  );

  const commitCurrentVideoProjectPatch = useCallback(
    async (patch: Partial<PersistedVideoProject>) => {
      const currentVideoProject = runtimeRef.current.currentVideoProject;
      if (!currentVideoProject) {
        return;
      }

      const nextProject = await upsertStoredVideoProject({
        ...currentVideoProject,
        ...patch,
      });

      startTransition(() => {
        setRuntime((previous) => ({
          ...previous,
          currentVideoProject:
            previous.currentVideoProject?.id === nextProject.id ? nextProject : previous.currentVideoProject,
        }));
      });
    },
    [runtimeRef, setRuntime],
  );

  const handleSelectVideoModel = useCallback(
    (modelKey: string) => {
      void commitEffectiveVideoPrefs({
        ...videoGenerationPrefs,
        modelKey: normalizeHomeAgentVideoModelKey(modelKey),
      });
    },
    [commitEffectiveVideoPrefs, videoGenerationPrefs],
  );

  const handleConfirmVideoResolution = useCallback(
    (nextPrefs: VideoGenerationPrefs) => {
      void commitEffectiveVideoPrefs({
        ...nextPrefs,
        modelKey: selectedVideoModelKey,
      });
    },
    [commitEffectiveVideoPrefs, selectedVideoModelKey],
  );

  const handleDevVideoGenerationModeChange = useCallback(
    (mode: VideoGenerationPrefs["mode"]) => {
      setPopoverOverride(null);
      void commitEffectiveVideoPrefs({
        ...videoGenerationPrefs,
        modelKey: selectedVideoModelKey,
        mode,
      });
    },
    [commitEffectiveVideoPrefs, selectedVideoModelKey, videoGenerationPrefs, setPopoverOverride],
  );

  const handleDevImageViewModeChange = useCallback(
    (viewMode: NonNullable<VideoImageGenerationPrefs["viewMode"]>) => {
      void commitEffectiveImagePrefs({
        ...imageGenerationPrefs,
        familyKey: selectedImageModelFamily,
        viewMode,
      });
    },
    [commitEffectiveImagePrefs, imageGenerationPrefs, selectedImageModelFamily],
  );

  const analyzeImageStyleWithFallback = useCallback(
    async (
      imageFiles: File[],
      userPrompt: string,
    ): Promise<HomeAgentImageStyleRecognitionResult> => {
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timeoutId =
        typeof window !== "undefined"
          ? window.setTimeout(() => controller?.abort(), STYLE_REFERENCE_RECOGNITION_TIMEOUT_MS)
          : null;

      try {
        return await analyzeHomeAgentImageStyleFiles(imageFiles, {
          userPrompt,
          signal: controller?.signal,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "No supported image files were provided for style recognition."
        ) {
          throw error;
        }

        const normalizedPrefs = normalizeVideoImageGenerationPrefs(imageGenerationPrefs);
        const degradedReason =
          error instanceof Error && error.name === "AbortError"
            ? "自动识别超时，先按参考图继续。"
            : "自动识别暂时不可用，先按参考图继续。";
        return {
          styleCategory: normalizedPrefs.styleCategory,
          stylePreset: normalizedPrefs.stylePreset,
          customStylePrompt: normalizedPrefs.customStylePrompt,
          summary: `已收到参考图，${degradedReason}后续会沿用参考图的整体氛围、色彩与构图作为画面风格参考。`,
          confidence: 0.28,
          reasons: [degradedReason],
          imageSummaries: imageFiles.slice(0, 4).map((file) => ({
            fileName: file.name,
            summary: "已收录这张参考图，将作为后续画面风格参考。",
            stylePreset: normalizedPrefs.stylePreset,
            confidence: 0.28,
          })),
        };
      } finally {
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
        }
      }
    },
    [imageGenerationPrefs],
  );

  const handleRecognizeImageStyle = useCallback(async () => {
    const imageFiles = attachedFiles.filter(isSupportedImageFile);
    if (!imageFiles.length) {
      throw new Error("请先上传至少一张图片参考图。");
    }
    return analyzeImageStyleWithFallback(
      imageFiles,
      resolveComposerDraftSnapshot(draftRef.current, persistedDraft) || "识别当前上传参考图的画面风格。",
    );
  }, [analyzeImageStyleWithFallback, attachedFiles, persistedDraft]);

  useEffect(() => {
    if (selectedTextModelKeyRef.current === selectedTextModelKey) return;
    selectedTextModelKeyRef.current = selectedTextModelKey;
    engineRef.current?.interrupt();
    engineRef.current = null;
  }, [selectedTextModelKey]);

  useEffect(() => {
    if (settingsOpen) {
      void refreshLaunchReadiness();
      return;
    }
    const cancelTask = scheduleBackgroundTask(() => {
      void refreshLaunchReadiness();
    }, 1600);
    return cancelTask;
  }, [refreshLaunchReadiness, scheduleBackgroundTask, settingsOpen]);

  useEffect(() => {
    const handleConfigUpdated = () => {
      void refreshLaunchReadiness();
    };
    window.addEventListener(API_CONFIG_UPDATED_EVENT, handleConfigUpdated);
    return () => window.removeEventListener(API_CONFIG_UPDATED_EVENT, handleConfigUpdated);
  }, [refreshLaunchReadiness]);

  const handleSettingsSaved = useCallback(() => {
    void refreshLaunchReadiness();
  }, [refreshLaunchReadiness]);

  useEffect(() => {
    const handleAutomationModeUpdated = (event: Event) => {
      const mode = normalizeAutomationMode(
        (event as CustomEvent<{ mode?: AutomationMode }>).detail?.mode ?? readStoredAutomationMode(),
      );
      setHistoryAutomationMode(mode);
    };
    window.addEventListener(HOME_AGENT_AUTOMATION_MODE_EVENT, handleAutomationModeUpdated as EventListener);
    return () =>
      window.removeEventListener(HOME_AGENT_AUTOMATION_MODE_EVENT, handleAutomationModeUpdated as EventListener);
  }, []);

  useEffect(() => {
    const handleVideoProjectSaved = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          projectId?: string;
          videoProject?: StudioRuntimeState["currentVideoProject"];
          projectSnapshot?: ConversationProjectSnapshot | null;
        }>
      ).detail;
      const nextProjectId = typeof detail?.projectId === "string" ? detail.projectId.trim() : "";
      if (!nextProjectId || !detail?.videoProject || !detail.projectSnapshot) return;
      if (!activeProjectId || activeProjectId === nextProjectId) {
        setActiveProjectId(nextProjectId);
      }

      setRuntime((prev) => {
        const currentProjectId =
          prev.currentVideoProject?.id ||
          prev.currentProjectSnapshot?.projectId ||
          activeProjectId ||
          "";
        if (currentProjectId && currentProjectId !== nextProjectId) {
          return prev;
        }

        const nextSnapshot: ConversationProjectSnapshot = {
          ...detail.projectSnapshot,
          memory: {
            ...(detail.projectSnapshot.memory ?? {}),
            assetManifest:
              detail.videoProject?.assetManifest ??
              detail.projectSnapshot.memory?.assetManifest,
          },
        };

        return {
          ...prev,
          currentVideoProject: detail.videoProject,
          currentProjectSnapshot: nextSnapshot,
          recentProjects: mergeRecentProjects(prev.recentProjects, nextSnapshot),
        };
      });
    };

    window.addEventListener(VIDEO_PROJECT_SAVED_EVENT, handleVideoProjectSaved as EventListener);
    return () =>
      window.removeEventListener(VIDEO_PROJECT_SAVED_EVENT, handleVideoProjectSaved as EventListener);
  }, [activeProjectId, setRuntime]);

  useEffect(() => {
    if (previousHistoryAutomationModeRef.current === historyAutomationMode) return;
    previousHistoryAutomationModeRef.current = historyAutomationMode;
    pendingHomepageIsolationModeRef.current = historyAutomationMode;
    setHomepageIsolationRequestEpoch((value) => value + 1);
  }, [historyAutomationMode]);

  useEffect(() => {
    if (!hasSkippedInitialRecentProjectRefreshRef.current) {
      hasSkippedInitialRecentProjectRefreshRef.current = true;
      return;
    }

    let cancelled = false;

    void loadProjectStore()
      .then((store) => store.listRecentConversationSnapshots(HOME_RECENT_PROJECTS_LIMIT, { fast: true }))
      .then((items) => {
        if (cancelled) return;
        const filteredItems = filterRecentlyDeletedProjectSnapshots(items);
        React.startTransition(() => {
          setRuntime((prev) => {
            const shouldPreserveRicherList =
              filteredItems.length > 0 &&
              prev.recentProjects.length > filteredItems.length &&
              filteredItems.every((item) => prev.recentProjects.some((project) => project.projectId === item.projectId));
            const nextRecentProjects = reconcileRecentProjectsWithStableOrder(
              prev.recentProjects,
              filteredItems,
            );
            if (shouldPreserveRicherList || areProjectSnapshotsEquivalent(nextRecentProjects, prev.recentProjects)) {
              return prev;
            }
            return { ...prev, recentProjects: nextRecentProjects };
          });
          setRecentProjectsReady(true);
        });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [filterRecentlyDeletedProjectSnapshots, historyAutomationMode, loadProjectStore, setRecentProjectsReady, setRuntime]);

  const push = useCallback((
    role: HomeAgentMessage["role"],
    content: string,
    artifactIds?: string[],
    attachments?: ChatAttachment[],
    artifactSnapshots?: import("@/lib/home-agent/types").ConversationArtifact[],
    messageExtras?: Partial<Pick<HomeAgentMessage, "automationOrigin" | "workflowRefresh">>,
  ) => {
    if (!content.trim()) return null;
    const resolvedArtifactSnapshots =
      artifactSnapshots?.length
        ? artifactSnapshots
        : resolveArtifactSnapshots(runtimeRef.current.currentProjectSnapshot, artifactIds);
    const trimmedContent = content.trim();
    const derivedMessageExtras = {
      ...(role === "user" && (trimmedContent.startsWith("全自动：") || trimmedContent.startsWith("AI代理："))
        ? { automationOrigin: "full-auto" as const }
        : {}),
      ...messageExtras,
    };
    const message = {
      ...mk(role, trimmedContent, artifactIds, attachments, resolvedArtifactSnapshots, derivedMessageExtras),
    };
    setMessages((prev) => {
      const next = [...prev, message];
      messagesRef.current = next;
      return next;
    });
    return message.id;
  }, [messagesRef]);

  const appendAttachmentOnlyUserMessage = useCallback(
    (preparedAttachments: ChatAttachment[]) => {
      const historyAttachments = preparedAttachments.map((attachment) =>
        stripAttachmentPayloadForHistory(attachment),
      );
      const submittedMessage: HomeAgentMessage = {
        ...mk("user", "", undefined, historyAttachments),
      };
      setMessages((prev) => {
        const next = [...prev, submittedMessage];
        messagesRef.current = next;
        return next;
      });
    },
    [messagesRef, setMessages],
  );

  const appendSubmittedStyleReferenceUserMessage = useCallback(
    async (files: File[]) => {
      const preparedAttachments = await prepareChatAttachments(files);
      appendAttachmentOnlyUserMessage(preparedAttachments);
    },
    [appendAttachmentOnlyUserMessage],
  );

  const appendPendingStyleReferenceAssistantMessage = useCallback(
    async () => {
      const pendingMessage: HomeAgentMessage = {
        ...mk("assistant", "正在识别参考图风格，请稍候。"),
        status: "pending",
        streamLabel: "正在识别参考图风格",
      };
      setMessages((prev) => {
        const next = [...prev, pendingMessage];
        messagesRef.current = next;
        return next;
      });
      return pendingMessage.id;
    },
    [messagesRef, setMessages],
  );

  const finalizeStyleReferenceAssistantMessage = useCallback(
    (messageId: string, content: string) => {
      const applyFinalState = () => {
        setMessages((prev) => {
          const index = prev.findIndex((message) => message.id === messageId);
          if (index === -1) return prev;
          const currentMessage = prev[index];
          if (
            currentMessage.status === "complete" &&
            currentMessage.streamLabel === undefined &&
            currentMessage.content === content
          ) {
            return prev;
          }
          const next = [...prev];
          next[index] = {
            ...currentMessage,
            content,
            status: "complete",
            streamLabel: undefined,
          };
          messagesRef.current = next;
          return next;
        });
      };

      applyFinalState();

      if (typeof window !== "undefined") {
        [80, 320, 1200].forEach((delay) => {
          window.setTimeout(() => applyFinalState(), delay);
        });
      }
    },
    [messagesRef, setMessages],
  );

  const runVideoKickoffStyleReferenceRecognition = useCallback(
    async (
      currentFiles: File[],
      rawText: string,
    ): Promise<HomeAgentImageStyleRecognitionResult> => {
      const imageFiles = currentFiles.filter(isSupportedImageFile);
      if (!imageFiles.length) {
        throw new Error("请先上传至少一张图片参考图。");
      }

      pendingVideoKickoffStyleReferenceUploadRef.current = null;
      flushSync(() => {
        setAwaitingVideoKickoffStyleReferenceUpload(true);
        setAttachedFiles([]);
        setMode("active");
        setQState(null);
        setPopoverOverride(null);
        setSuggested(null);
        setSelectedValues([]);
        resetComposerDraft("");
      });

      await appendSubmittedStyleReferenceUserMessage(imageFiles);
      const pendingAssistantMessageId =
        await appendPendingStyleReferenceAssistantMessage();

      try {
        const recognition = await analyzeImageStyleWithFallback(
          imageFiles,
          rawText.trim() ||
            resolveComposerDraftSnapshot(draftRef.current, persistedDraft) ||
            "识别当前上传参考图的画面风格。",
        );
        const nextImagePrefs = normalizeVideoImageGenerationPrefs({
          ...imageGenerationPrefs,
          ...buildImagePrefsPatchFromRecognition(recognition),
        });
        const nextProject = await commitEffectiveImagePrefs(nextImagePrefs, {
          referenceStyleSummary: recognition.summary,
          projectPatch: {
            kickoffModeConfirmed: true,
            kickoffStyleConfirmed: true,
          },
        });
        const currentSnapshot = runtimeRef.current.currentProjectSnapshot;
        const nextQuestion =
          currentSnapshot?.projectKind === "video"
            ? (
                buildVideoBridgePrefixQuestion(
                  currentSnapshot,
                  nextProject ?? runtimeRef.current.currentVideoProject,
                ) ??
                recQuestion(
                  currentSnapshot,
                  nextProject ?? runtimeRef.current.currentVideoProject,
                )
              )
            : null;

        queueWorkflowPopoverAfterAssistantReply(nextQuestion);
        finalizeStyleReferenceAssistantMessage(
          pendingAssistantMessageId,
          [
            "已识别参考图风格，摘要如下：",
            `画面风格：${buildVideoImageStyleSummary(nextImagePrefs)}`,
            `参考图摘要：${recognition.summary}`,
            nextQuestion?.answerKey === "video-bridge-prefix"
              ? "前置参数已写入。下一步请先点“补齐平台与镜头偏好”。"
              : "前置参数已写入，继续后续视频工作流。",
          ].join("\n"),
        );
        return recognition;
      } catch (error) {
        finalizeStyleReferenceAssistantMessage(
          pendingAssistantMessageId,
          `${
            error instanceof Error ? error.message : "参考图风格识别失败。"
          }请重新上传参考图，或改用自定义风格说明。`,
        );
        throw error;
      } finally {
        setAwaitingVideoKickoffStyleReferenceUpload(false);
      }
    },
    [
      appendSubmittedStyleReferenceUserMessage,
      appendPendingStyleReferenceAssistantMessage,
      analyzeImageStyleWithFallback,
      commitEffectiveImagePrefs,
      finalizeStyleReferenceAssistantMessage,
      imageGenerationPrefs,
      persistedDraft,
      queueWorkflowPopoverAfterAssistantReply,
      resetComposerDraft,
      runtimeRef,
      setMode,
      setQState,
      setAttachedFiles,
      setPopoverOverride,
      setSelectedValues,
      setSuggested,
    ],
  );

  const handleSubmitAttachedStyleReference = useCallback(
    async (_label: string): Promise<SubmittedStyleReferenceRecognitionResult | null> => {
      const currentFiles = [...attachedFiles];
      const recognition = await runVideoKickoffStyleReferenceRecognition(
        currentFiles,
        resolveComposerDraftSnapshot(draftRef.current, persistedDraft) ||
          "识别当前上传参考图的画面风格。",
      );
      return {
        ...recognition,
        handledLocally: true,
      };
    },
    [attachedFiles, persistedDraft, runVideoKickoffStyleReferenceRecognition],
  );

  const bindPendingCharacterAudioReferenceUpload = useCallback(
    async (currentFiles: File[]) => {
      const pendingRequest = resolvePendingCharacterAudioUploadRequest();
      if (!pendingRequest) return false;

      const audioFiles = collectSupportedCharacterAudioFiles(currentFiles);
      if (!audioFiles.length) {
        push(
          "assistant",
          pendingRequest.characterName
            ? `我正在等你上传角色《${pendingRequest.characterName}》的音频参考。请至少上传 1 个音频文件，并且一次只能绑定 1 个音色；发送后我会自动绑定到该角色。`
            : "我正在等你上传角色音频参考。请至少上传 1 个音频文件，并且一次只能绑定 1 个音色；发送后我会自动绑定到当前角色。",
        );
        return true;
      }

      if (audioFiles.length > 1) {
        const limitMessage = pendingRequest.characterName
          ? `角色《${pendingRequest.characterName}》一次只能绑定 1 个音色。当前输入框里有 ${audioFiles.length} 个音频文件，请只保留 1 个后再发送。`
          : `当前角色一次只能绑定 1 个音色。当前输入框里有 ${audioFiles.length} 个音频文件，请只保留 1 个后再发送。`;
        flashMaintenanceHint(limitMessage, 3200);
        push("assistant", limitMessage);
        return true;
      }

      let currentVideoProject = runtimeRef.current.currentVideoProject;
      if (!currentVideoProject) {
        const fallbackProjectId = runtimeRef.current.currentProjectSnapshot?.projectId;
        if (fallbackProjectId) {
          currentVideoProject =
            (await loadStoredVideoProjectById(fallbackProjectId, { fast: true })) ??
            (await loadStoredVideoProjectById(fallbackProjectId));
        }
      }
      if (!currentVideoProject) {
        pendingCharacterAudioReferenceUploadRef.current = null;
        setAwaitingCharacterAudioReferenceUpload(false);
        setPopoverOverride(null);
        setInterruptedChoiceQuestion(null);
        interruptRestoreQuestionRef.current = null;
        push("assistant", "当前没有可绑定的角色项目，请先回到视频项目后再上传音频参考。");
        return true;
      }

      const targetCharacter = currentVideoProject.characters.find(
        (character) => character.id === pendingRequest.characterId,
      );
      if (!targetCharacter) {
        pendingCharacterAudioReferenceUploadRef.current = null;
        setAwaitingCharacterAudioReferenceUpload(false);
        setPopoverOverride(null);
        setInterruptedChoiceQuestion(null);
        interruptRestoreQuestionRef.current = null;
        push("assistant", "没有找到要绑定音频参考的角色，请重新选择该角色后再上传。");
        return true;
      }

      try {
        const restoreContextOnSuccess = pendingRequest.restoreContext ?? null;
        const preparedAttachments = await prepareChatAttachments(audioFiles);
        const contextualizedAttachments = preparedAttachments.map((attachment, index) =>
          index === 0
            ? {
                ...attachment,
                label: targetCharacter.name?.trim()
                  ? `角色《${targetCharacter.name.trim()}》音频参考`
                  : attachment.label,
              }
            : attachment,
        );
        const audioAttachment = contextualizedAttachments[0];
        const audioUrl = resolveCharacterAudioReferenceUrl(audioAttachment);
        if (!audioUrl) {
          throw new Error("当前音频文件缺少可用的本地路径或内联数据，暂时无法绑定到角色。");
        }
        const hadExistingAudioReference = Boolean(
          targetCharacter.audioUrl?.trim() || targetCharacter.audioFileName?.trim(),
        );

        pendingCharacterAudioReferenceUploadRef.current = null;
        setAwaitingCharacterAudioReferenceUpload(false);
        setAttachedFiles([]);
        setPopoverOverride(null);
        setInterruptedChoiceQuestion(null);
        interruptRestoreQuestionRef.current = null;
        appendAttachmentOnlyUserMessage(contextualizedAttachments);

        const nextCharacters = currentVideoProject.characters.map((character) =>
          character.id === targetCharacter.id
            ? {
                ...character,
                audioUrl,
                audioFileName: audioAttachment.fileName || character.audioFileName,
              }
            : character,
        );
        const nextProject = await upsertStoredVideoProject(
          synchronizeVideoProductionState({
            ...currentVideoProject,
            characters: nextCharacters,
          }),
        );

        startTransition(() => {
          setRuntime((previous) => ({
            ...previous,
            currentVideoProject:
              previous.currentVideoProject?.id === nextProject.id ||
              previous.currentProjectSnapshot?.projectId === nextProject.id
                ? nextProject
                : previous.currentVideoProject,
          }));
        });

        push(
          "assistant",
          hadExistingAudioReference
            ? `已把角色《${targetCharacter.name}》的音频参考更新为《${audioAttachment.fileName}》。每个角色当前只保留 1 个音色，后续出片会使用最新这条参考。`
            : `已把音频参考《${audioAttachment.fileName}》绑定到角色《${targetCharacter.name}》。后续出片会把它作为角色声音参考传给视频模型。`,
        );
        queuePendingCharacterAudioRestoreAfterAssistantReply(
          restoreContextOnSuccess ?? {
            question: pendingRequest.restoreQuestion ?? null,
            qState: null,
            selectedValues: [],
            draft: "",
          },
        );
      } catch (error) {
        push(
          "assistant",
          error instanceof Error ? error.message : "角色音频参考绑定失败，请稍后重试。",
        );
      }

      return true;
    },
    [
      appendAttachmentOnlyUserMessage,
      flashMaintenanceHint,
      push,
      queuePendingCharacterAudioRestoreAfterAssistantReply,
      resolvePendingCharacterAudioUploadRequest,
      runtimeRef,
      setRuntime,
    ],
  );

  const cancelPendingCharacterAudioReferenceUpload = useCallback(
    (options?: { restoreMenu?: boolean }) => {
      const pendingRequest = resolvePendingCharacterAudioUploadRequest(
        question,
        options?.restoreMenu
          ? {
              preferredRestoreQuestion:
                interruptedChoiceQuestion?.answerKey ===
                PENDING_CHARACTER_AUDIO_QUESTION_KEY
                  ? null
                  : interruptedChoiceQuestion,
            }
          : undefined,
      );
      if (!pendingRequest) return false;

      pendingCharacterAudioReferenceUploadRef.current = null;
      setAwaitingCharacterAudioReferenceUpload(false);
      setAttachedFiles([]);
      setPopoverOverride(null);
      setInterruptedChoiceQuestion(null);
      interruptRestoreQuestionRef.current = null;

      const restoreQuestion = options?.restoreMenu
        ? pendingRequest.restoreQuestion ?? null
        : null;
      const restored = options?.restoreMenu
        ? restorePendingCharacterAudioUploadContext(
            pendingRequest.restoreContext ?? {
              question: restoreQuestion,
              qState: null,
              selectedValues: [],
              draft: "",
            },
          )
        : false;
      const resolvedCharacterName = pendingRequest.characterName?.trim();

      if (restored && options?.restoreMenu) {
        return true;
      }

      push(
        "assistant",
        restored
          ? resolvedCharacterName
            ? `已取消角色《${resolvedCharacterName}》的音频上传，已返回刚才的菜单。`
            : "已取消当前角色音频上传，已返回刚才的菜单。"
          : resolvedCharacterName
            ? `已取消角色《${resolvedCharacterName}》的音频上传。`
            : "已取消当前角色音频上传。",
      );

      return true;
    },
    [
      interruptedChoiceQuestion,
      push,
      question,
      resolvePendingCharacterAudioUploadRequest,
      restorePendingCharacterAudioUploadContext,
    ],
  );

  const openCharacterAudioReferencePresetPicker = useCallback(
    async (
      _label: string,
      characterId: string,
      characterName?: string,
      restoreQuestion?: ComposerQuestion | null,
    ) => {
      const snapshot = runtimeRef.current.currentProjectSnapshot;
      if (!snapshot || snapshot.projectKind !== "video") {
        push("assistant", "当前没有可用的视频项目，请先进入角色与场景资产面板后再选择预设参考音频。");
        return;
      }

      let presetLibrary;
      try {
        presetLibrary = await loadCharacterAudioPresetLibrary();
      } catch (error) {
        push(
          "assistant",
          error instanceof Error
            ? error.message
            : "读取预设参考音频库失败，请稍后再试。",
        );
        return;
      }

      if (!presetLibrary.groups.length) {
        push(
          "assistant",
          "当前预设参考音频库还是空的，暂时没有可直接绑定的音色样本。",
        );
        return;
      }

      const exactRestoreQuestion = (() => {
        const currentVideoProject = runtimeRef.current.currentVideoProject;
        const canonicalWorkflowQuestion = buildVideoBridgeQuestion(
          snapshot,
          currentVideoProject,
        );
        return markQuestionForExactRestore(
          canonicalWorkflowQuestion ?? restoreQuestion ?? question ?? null,
        );
      })();
      characterAudioPresetPickerRef.current = {
        characterId,
        characterName,
        restoreQuestion: exactRestoreQuestion,
      };

      openWorkflowPopoverQuestion(
        buildCharacterAudioPresetPickerQuestion({
          characterId,
          characterName,
          library: presetLibrary,
          projectId: snapshot.projectId,
          stepIndex: exactRestoreQuestion?.stepIndex ?? 0,
          totalSteps: exactRestoreQuestion?.totalSteps ?? 1,
        }),
      );
    },
    [openWorkflowPopoverQuestion, push, question, runtimeRef],
  );

  const exitCharacterAudioReferencePresetPicker = useCallback(() => {
    const snapshot = runtimeRef.current.currentProjectSnapshot;
    const restoreQuestion = markQuestionForExactRestore(
      snapshot?.projectKind === "video"
        ? buildVideoBridgeQuestion(snapshot, runtimeRef.current.currentVideoProject) ??
            characterAudioPresetPickerRef.current?.restoreQuestion ??
            null
        : characterAudioPresetPickerRef.current?.restoreQuestion ?? null,
    );
    characterAudioPresetPickerRef.current = null;

    if (restoreQuestion) {
      flushSync(() => {
        openWorkflowPopoverQuestion(restoreQuestion);
      });
      return true;
    }

    setMode("active");
    setSelectedValues([]);
    resetComposerDraft("");
    setSuggested(null);
    setPopoverOverride(null);
    return true;
  }, [
    openWorkflowPopoverQuestion,
    resetComposerDraft,
    setMode,
    setPopoverOverride,
    setSelectedValues,
    setSuggested,
  ]);

  const bindCharacterAudioReferencePreset = useCallback(
    async (
      selection: CharacterAudioPresetBindSelection & {
        label: string;
        characterName?: string;
        restoreQuestion?: ComposerQuestion | null;
      },
    ) => {
      let currentVideoProject = runtimeRef.current.currentVideoProject;
      if (!currentVideoProject) {
        const fallbackProjectId = runtimeRef.current.currentProjectSnapshot?.projectId;
        if (fallbackProjectId) {
          currentVideoProject =
            (await loadStoredVideoProjectById(fallbackProjectId, { fast: true })) ??
            (await loadStoredVideoProjectById(fallbackProjectId));
        }
      }

      if (!currentVideoProject) {
        push("assistant", "当前没有可用的视频项目，请先进入角色与场景资产面板后再绑定预设参考音频。");
        return;
      }

      const targetCharacter = currentVideoProject.characters.find(
        (character) => character.id === selection.characterId,
      );
      if (!targetCharacter) {
        push("assistant", "没有找到要绑定预设参考音频的角色，请重新打开角色菜单后再试一次。");
        return;
      }

      const resolvedCharacterName =
        targetCharacter.name?.trim() || selection.characterName?.trim() || "当前角色";
      const resolvedFileName =
        selection.fileName?.trim() ||
        selection.audioPath.split(/[\\/]/u).pop()?.trim() ||
        targetCharacter.audioFileName?.trim() ||
        "预设参考音频.wav";
      const hadExistingAudioReference = Boolean(
        targetCharacter.audioUrl?.trim() || targetCharacter.audioFileName?.trim(),
      );

      const nextCharacters = currentVideoProject.characters.map((character) =>
        character.id === targetCharacter.id
          ? {
              ...character,
              audioUrl: selection.audioPath,
              audioFileName: resolvedFileName,
            }
          : character,
      );
      const nextProject = await upsertStoredVideoProject(
        synchronizeVideoProductionState({
          ...currentVideoProject,
          characters: nextCharacters,
        }),
      );

      startTransition(() => {
        setRuntime((previous) => ({
          ...previous,
          currentVideoProject:
            previous.currentVideoProject?.id === nextProject.id ||
            previous.currentProjectSnapshot?.projectId === nextProject.id
              ? nextProject
              : previous.currentVideoProject,
        }));
      });

      push("user", selection.label);
      push(
        "assistant",
        hadExistingAudioReference
          ? `已把角色《${resolvedCharacterName}》的音频参考切换为预设《${resolvedFileName}》。后续出片会优先使用这条最新参考。`
          : `已把预设参考音频《${resolvedFileName}》绑定到角色《${resolvedCharacterName}》。后续出片会把它作为角色声音参考传给视频模型。`,
      );

      const snapshot = runtimeRef.current.currentProjectSnapshot;
      const restoreQuestion = markQuestionForExactRestore(
        snapshot?.projectKind === "video"
          ? buildVideoBridgeQuestion(snapshot, nextProject) ??
              selection.restoreQuestion ??
              characterAudioPresetPickerRef.current?.restoreQuestion ??
              null
          : selection.restoreQuestion ??
              characterAudioPresetPickerRef.current?.restoreQuestion ??
              null,
      );
      characterAudioPresetPickerRef.current = null;
      if (restoreQuestion) {
        flushSync(() => {
          openWorkflowPopoverQuestion(restoreQuestion);
        });
      } else {
        setPopoverOverride(null);
      }
    },
    [
      openWorkflowPopoverQuestion,
      push,
      runtimeRef,
      setPopoverOverride,
      setRuntime,
    ],
  );

  useEffect(() => {
    const handleWorkflowRuntimeDelta = (event: Event) => {
      const detail = (event as CustomEvent<HomeAgentWorkflowRuntimeDeltaDetail>).detail;
      const delta = detail?.data;
      const nextSnapshot = delta?.projectSnapshot;
      const currentProjectId =
        runtimeRef.current.currentProjectSnapshot?.projectId ?? activeProjectId;

      if (!delta || !nextSnapshot) return;
      // 鎷︽埅宸茶鐢ㄦ埛涓诲姩鏀惧純鐨勬棫椤圭洰 delta
      if (staleProjectIdsRef.current.has(nextSnapshot.projectId)) return;
      if (currentProjectId && nextSnapshot.projectId !== currentProjectId) return;
      const nextSessionProjectId = resolveSessionProjectIdForSnapshot({
        currentSessionProjectId: activeProjectId,
        snapshot: nextSnapshot,
        fallbackProjectId: nextSnapshot.projectId,
      });

      startTransition(() => {
        setRuntime((previous) =>
          mergeRuntimeWithWorkflowDelta(previous, delta, { deferRecentProjectUpsert: streaming }),
        );
        if (nextSessionProjectId) {
          setActiveProjectId(nextSessionProjectId);
        }
      });
    };

    window.addEventListener(
      HOME_AGENT_WORKFLOW_RUNTIME_DELTA_EVENT,
      handleWorkflowRuntimeDelta as EventListener,
    );
    return () =>
      window.removeEventListener(
        HOME_AGENT_WORKFLOW_RUNTIME_DELTA_EVENT,
        handleWorkflowRuntimeDelta as EventListener,
      );
  }, [activeProjectId, setActiveProjectId, setRuntime, streaming]);

  // 鐩戝惉鍥剧墖鐢熸垚寮€濮嬩簨浠讹紝娉ㄥ叆甯﹀崰浣嶇鐨?pending 娑堟伅
  useEffect(() => {
    const handleImageGeneratingStart = (event: Event) => {
      const detail = ((event as CustomEvent<{
        count: number;
        action: string;
        mediaEventId?: string;
        modelFamily?: string;
        resolution?: string;
        aspectRatio?: string;
        contentSummary?: string;
        targetLabels?: string[];
      }>).detail ?? {}) as Partial<{
        count: number;
        action: string;
        mediaEventId?: string;
        modelFamily?: string;
        resolution?: string;
        aspectRatio?: string;
        contentSummary?: string;
        targetLabels?: string[];
      }>;
      const { count = 1, action = "", mediaEventId } = detail;
      const targetLabels = detail.targetLabels?.slice(0, count);
      const placeholderAttachments: ChatAttachment[] = Array.from({ length: count }, (_, index) => {
        const targetLabel = targetLabels?.[index]?.trim();
        return {
          id: crypto.randomUUID(),
          fileName: buildPendingMediaAttachmentName("image", targetLabel ? 1 : count, targetLabel ? 0 : index, targetLabel || detail.contentSummary),
          label: targetLabel || undefined,
          mimeType: "image/jpeg",
          size: 0,
          kind: "image" as const,
          pending: true,
          aspectRatio: detail.aspectRatio || "1:1",
        };
      });
      const mediaCopy = buildImageMediaMessageV2({
        count,
        action,
        modelFamily: detail.modelFamily,
        resolution: detail.resolution,
        aspectRatio: detail.aspectRatio,
        contentSummary: detail.contentSummary,
        imageLabels: targetLabels,
      });
      setMessages((prev) => [
        ...prev,
        {
          ...mk("assistant", mediaCopy.start, undefined, placeholderAttachments),
          status: "pending" as const,
          ...(mediaEventId ? { mediaEventId } : {}),
          streamLabel: buildPendingMediaStreamLabelV2({
            fallbackLabel:
              action === "generate_storyboard_frames"
                ? "\u5206\u955c\u56fe"
                : action === "generate_video_reference_assets"
                  ? "\u89c6\u9891\u53c2\u8003\u7d20\u6750"
                  : "\u56fe\u7247",
            contentSummary: detail.contentSummary,
          }),
        },
      ]);
    };
    window.addEventListener("agent:image-generating-start", handleImageGeneratingStart);
    return () => window.removeEventListener("agent:image-generating-start", handleImageGeneratingStart);
  }, []);

  // 鐩戝惉鍥剧墖鐢熸垚瀹屾垚浜嬩欢锛屾妸鍥剧墖浣滀负 assistant 娑堟伅闄勪欢娉ㄥ叆鑱婂ぉ妗?
  useEffect(() => {
    const handleImageGenerated = async (event: Event) => {
      const detail = ((event as CustomEvent<{
        imageUrls: string[];
        imageLabels?: string[];
        mediaEventId?: string;
        actionLabel?: string;
        action?: string;
        count?: number;
        modelFamily?: string;
        resolution?: string;
        aspectRatio?: string;
        contentSummary?: string;
      }>).detail ?? {}) as Partial<{
        imageUrls: string[];
        imageLabels?: string[];
        mediaEventId?: string;
        actionLabel?: string;
        action?: string;
        count?: number;
        modelFamily?: string;
        resolution?: string;
        aspectRatio?: string;
        contentSummary?: string;
      }>;
      const { imageUrls, imageLabels, mediaEventId, actionLabel } = detail;
      const successUrls = imageUrls ?? [];

      const attachments: ChatAttachment[] = await Promise.all(
        successUrls.map(async (url, index) => {
          let previewUrl: string | undefined;
          if (url.startsWith("data:")) {
            previewUrl = url;
          } else if (url.startsWith("http://") || url.startsWith("https://")) {
            previewUrl = url;
          } else if (isLocalSidebarAssetUrl(url)) {
            previewUrl = (await resolveLocalMediaPreviewDataUrl(url)) || undefined;
          }
          const perImageLabel = imageLabels?.[index];
          const baseName = perImageLabel
            ? perImageLabel
            : actionLabel
              ? successUrls.length > 1
                ? `${actionLabel}_${index + 1}`
                : actionLabel
              : (url.split(/[/]/).pop()?.replace(/\.[^.]+$/, "") ??
                buildGeneratedMediaFallbackName("image", successUrls.length, index).replace(/\.jpg$/, ""));
          const fileName = `${baseName}.jpg`;
          return {
            id: crypto.randomUUID(),
            fileName,
            label: perImageLabel || detail.contentSummary || actionLabel || undefined,
            mimeType: "image/jpeg",
            size: 0,
            kind: "image" as const,
            localPath: url,
            previewUrl,
          };
        }),
      );

      setMessages((prev) => {
        // 找到最后一条 pending 图片消息（允许占位符已被逐张替换完毕）
        const idx = findPendingMediaMessageIndex(prev, "image", mediaEventId);

        if (idx !== -1) {
          const target = prev[idx];
          const rawAttachments = mergeCompletedImageAttachments(target?.attachments, attachments);
          // 去掉版本后缀
          const finalAttachments = rawAttachments.map((a) => ({
            ...a,
            label: a.label ? a.label.replace(/\s*·\s*版本\d+$/, "") : a.label,
          }));

          const failedCount = finalAttachments.filter((a) => a.failed).length;
          const successCount = finalAttachments.filter((a) => !a.failed).length;
          // 用实际 attachment 的 label 构建第二行标签（失败的标注失败）
          const finalLabels = finalAttachments.map((a) =>
            a.failed ? `${a.label || a.fileName.replace(/\.[^.]+$/, "")} ❌` : (a.label || a.fileName.replace(/\.[^.]+$/, "")),
          );
          const mediaCopyFinal = buildImageMediaMessageV2({
            count: (detail.count ?? (successCount + failedCount)) || successUrls.length,
            action: detail.action,
            modelFamily: detail.modelFamily,
            resolution: detail.resolution,
            aspectRatio: detail.aspectRatio,
            contentSummary: detail.contentSummary,
            imageLabels: finalLabels.length ? finalLabels : detail.imageLabels,
            failedCount,
          });
          const realMsg = mk(
            "assistant",
            preserveExistingMediaDetailLines({
              existingContent: target?.content,
              nextContent: mediaCopyFinal.done,
              preserveExistingDetails: !detail.contentSummary,
            }),
            undefined,
            finalAttachments,
          );
          const next = [...prev];
          next[idx] = realMsg;
          return next;
        }

        // 没有 pending 消息时，只在有成功结果时追加
        if (!successUrls.length) return prev;
        const mediaCopy = buildImageMediaMessageV2({
          count: detail.count ?? successUrls.length,
          action: detail.action,
          modelFamily: detail.modelFamily,
          resolution: detail.resolution,
          aspectRatio: detail.aspectRatio,
          contentSummary: detail.contentSummary,
          imageLabels: detail.imageLabels,
        });
        const realMsg = {
          ...mk("assistant", mediaCopy.done, undefined, attachments),
          ...(mediaEventId ? { mediaEventId } : {}),
        };
        if (hasMatchingCompletedMediaMessage(prev, attachments)) {
          return prev;
        }
        return [...prev, realMsg];
      });

      reopenWorkflowPopupAfterMediaCompletion();
    };
    window.addEventListener("agent:image-generated", handleImageGenerated as EventListener);
    return () => window.removeEventListener("agent:image-generated", handleImageGenerated as EventListener);
  }, [reopenWorkflowPopupAfterMediaCompletion]);

  // 监听单张图片生成完成事件，逐张替换占位符
  useEffect(() => {
    const handleImageGeneratedOne = async (event: Event) => {
      const detail = ((event as CustomEvent<{
        url: string;
        label?: string;
        index: number;
        mediaEventId?: string;
        action?: AssetLibraryTarget["action"];
        projectId?: string;
        targetId?: string;
        regenerateMode?: AssetLibraryTarget["regenerateMode"];
      }>).detail ?? {}) as Partial<{
        url: string;
        label?: string;
        index: number;
        mediaEventId?: string;
        action?: AssetLibraryTarget["action"];
        projectId?: string;
        targetId?: string;
        regenerateMode?: AssetLibraryTarget["regenerateMode"];
      }>;
      const { url, label, index, mediaEventId } = detail;
      if (!url) return;

      let previewUrl: string | undefined;
      if (url.startsWith("data:")) {
        previewUrl = url;
      } else if (url.startsWith("http://") || url.startsWith("https://")) {
        previewUrl = url;
      } else if (isLocalSidebarAssetUrl(url)) {
        previewUrl = (await resolveLocalMediaPreviewDataUrl(url)) || undefined;
      }

      const cleanLabel = label ? label.replace(/\s*·\s*版本\d+$/, "") : undefined;
      const attachment: ChatAttachment = {
        id: crypto.randomUUID(),
        fileName: cleanLabel ? `${cleanLabel}.jpg` : buildGeneratedMediaFallbackName("image", 1, 0),
        label: cleanLabel,
        mimeType: "image/jpeg",
        size: 0,
        kind: "image" as const,
        localPath: url,
        previewUrl,
        ...(detail.action && detail.projectId && detail.targetId
          ? {
              generationContext: {
                action: detail.action,
                projectId: detail.projectId,
                targetId: detail.targetId,
                regenerateMode: detail.regenerateMode ?? "generate",
              },
            }
          : {}),
      };

      setMessages((prev) => {
        const msgIdx = findPendingMediaMessageIndex(prev, "image", mediaEventId);
        if (msgIdx === -1) return prev;
        const target = prev[msgIdx];
        if (!target?.attachments) return prev;

        const imageAttachments = target.attachments.filter((a) => a.kind === "image");
        const targetPlaceholder = imageAttachments[index];

        const next = [...prev];
        if (targetPlaceholder) {
          next[msgIdx] = {
            ...target,
            attachments: target.attachments.map((a) =>
              a.id === targetPlaceholder.id ? attachment : a,
            ),
          };
        } else {
          next[msgIdx] = {
            ...target,
            attachments: [...target.attachments, attachment],
          };
        }
        return next;
      });
    };
    window.addEventListener("agent:image-generated-one", handleImageGeneratedOne as EventListener);
    return () => window.removeEventListener("agent:image-generated-one", handleImageGeneratedOne as EventListener);
  }, []);

  // 监听单张图片生成失败事件，保留占位符并标记失败原因
  useEffect(() => {
    const handleImageGeneratedOneFailed = (event: Event) => {
      const detail = ((event as CustomEvent<{ index: number; label?: string; reason?: string; mediaEventId?: string }>).detail ?? {}) as Partial<{ index: number; label?: string; reason?: string; mediaEventId?: string }>;
      const { index, label, reason, mediaEventId } = detail;
      const failureReason = resolveImageFailureReason(reason);

      setMessages((prev) => {
        const msgIdx = findPendingMediaMessageIndex(prev, "image", mediaEventId);
        if (msgIdx === -1) return prev;
        const target = prev[msgIdx];
        if (!target?.attachments) return prev;
        const next = [...prev];
        next[msgIdx] = markFailedMediaAttachmentsInMessage(target, {
          kind: "image",
          index,
          label,
          failureReason,
          completionContent: buildMediaFailureCompletionContent({
            kind: "image",
            label,
            failureReason,
          }),
        });
        return next;
      });
    };
    window.addEventListener("agent:image-generated-one-failed", handleImageGeneratedOneFailed as EventListener);
    return () => window.removeEventListener("agent:image-generated-one-failed", handleImageGeneratedOneFailed as EventListener);
  }, []);

  useEffect(() => {
    const handleImageGeneratingFailed = (event: Event) => {
      const detail = ((event as CustomEvent<{ reason?: string; mediaEventId?: string }>).detail ?? {}) as Partial<{
        reason?: string;
        mediaEventId?: string;
      }>;
      const failureReason = resolveImageFailureReason(detail.reason);

      setMessages((prev) => {
        const msgIdx = findPendingMediaMessageIndex(prev, "image", detail.mediaEventId);
        if (msgIdx === -1) return prev;
        const target = prev[msgIdx];
        if (!target?.attachments?.length) return prev;

        const next = [...prev];
        next[msgIdx] = markFailedMediaAttachmentsInMessage(target, {
          kind: "image",
          settleAll: true,
          failureReason,
          completionContent: buildMediaFailureCompletionContent({
            kind: "image",
            failureReason,
          }),
        });
        return next;
      });
    };
    window.addEventListener("agent:image-generating-failed", handleImageGeneratingFailed as EventListener);
    return () => window.removeEventListener("agent:image-generating-failed", handleImageGeneratingFailed as EventListener);
  }, []);

  useEffect(() => {
    const handleImageGeneratingCancelled = (event: Event) => {
      const detail = ((event as CustomEvent<{ mediaEventId?: string }>).detail ?? {}) as Partial<{
        mediaEventId?: string;
      }>;
      setMessages((prev) => {
        const idx = findPendingMediaMessageIndex(prev, "image", detail.mediaEventId);
        if (idx === -1) return prev;
        const target = prev[idx];
        if (!target?.attachments?.length) return prev;

        const next = [...prev];
        next[idx] = {
          ...target,
          content: "媒体生成已取消，可继续选择下一步。",
          status: "complete",
          streamLabel: undefined,
          attachments: target.attachments.map((attachment) =>
            attachment.kind === "image" && attachment.pending
              ? {
                  ...attachment,
                  pending: false,
                  cancelled: true,
                }
              : attachment,
          ),
        };
        return next;
      });
    };
    window.addEventListener("agent:image-generating-cancelled", handleImageGeneratingCancelled);
    return () => window.removeEventListener("agent:image-generating-cancelled", handleImageGeneratingCancelled);
  }, []);

  useEffect(() => {
    const handleVideoGeneratingStart = (event: Event) => {
      const detail =
        ((event as CustomEvent<{
          count?: number;
          sceneCount?: number;
          action?: string;
          mediaEventId?: string;
          model?: string;
          resolution?: string;
          provider?: string;
          mode?: string;
          aspectRatio?: string;
          contentSummary?: string;
          targetLabels?: string[];
          routeHint?: string;
        }>).detail ?? {}) as Partial<{
          count?: number;
          sceneCount?: number;
          action?: string;
          mediaEventId?: string;
          model?: string;
          resolution?: string;
          provider?: string;
          mode?: string;
          aspectRatio?: string;
          contentSummary?: string;
          targetLabels?: string[];
          routeHint?: string;
        }>;
      const count = Math.max(1, detail.sceneCount ?? detail.count ?? 1);
      const mediaEventId =
        typeof detail.mediaEventId === "string" && detail.mediaEventId.trim()
          ? detail.mediaEventId.trim()
          : undefined;
      const targetLabels = detail.targetLabels?.slice(0, count);
      const placeholderAttachments: ChatAttachment[] = Array.from({ length: count }, (_, index) => {
        const targetLabel = targetLabels?.[index]?.trim();
        return {
          id: crypto.randomUUID(),
          fileName: buildPendingMediaAttachmentName("video", targetLabel ? 1 : count, targetLabel ? 0 : index, targetLabel || detail.contentSummary),
          label: targetLabel || undefined,
          mimeType: "video/mp4",
          size: 0,
          kind: "video" as const,
          pending: true,
          aspectRatio: detail.aspectRatio || "16:9",
        };
      });
      const mediaCopy = buildVideoMediaMessageV2({
        count,
        model: detail.model,
        resolution: detail.resolution,
        aspectRatio: detail.aspectRatio,
        provider: detail.provider,
        mode: detail.mode,
        contentSummary: detail.contentSummary,
        videoLabels: targetLabels,
        routeHint: detail.routeHint,
      });
      setMessages((prev) => [
        ...prev,
        {
          ...mk("assistant", mediaCopy.start, undefined, placeholderAttachments),
          status: "pending" as const,
          ...(mediaEventId ? { mediaEventId } : {}),
          streamLabel: buildPendingMediaStreamLabelV2({
            fallbackLabel: "\u89c6\u9891",
            contentSummary: detail.contentSummary,
          }),
        },
      ]);
    };
    window.addEventListener("agent:video-generating-start", handleVideoGeneratingStart);
    return () => window.removeEventListener("agent:video-generating-start", handleVideoGeneratingStart);
  }, []);

  useEffect(() => {
    const handleVideoGenerated = async (event: Event) => {
      const detail =
        ((event as CustomEvent<{
          videoUrls: string[];
          mediaEventId?: string;
          count?: number;
          model?: string;
          resolution?: string;
          aspectRatio?: string;
          provider?: string;
          mode?: string;
          contentSummary?: string;
        }>).detail ?? {}) as Partial<{
          videoUrls: string[];
          mediaEventId?: string;
          count?: number;
          model?: string;
          resolution?: string;
          aspectRatio?: string;
          provider?: string;
          mode?: string;
          contentSummary?: string;
        }>;
      const { videoUrls: rawVideoUrls, mediaEventId } = detail;
      if (!rawVideoUrls?.length) return;

      const hasPendingBatch =
        findPendingMediaMessageIndex(messagesRef.current, "video", mediaEventId) !== -1;
      const videoUrls = rawVideoUrls.filter(
        (url) => !wasVideoRecentlyProcessed(recentlyProcessedVideoUrlsRef.current, url, mediaEventId),
      );

      // 若最终汇总里所有 URL 都是近期已处理结果，只需将 pending 消息标记为完成
      if (!videoUrls.length) {
        setMessages((prev) => {
          const idx = findPendingMediaMessageIndex(prev, "video", mediaEventId);
          if (idx === -1) return prev;
          const next = [...prev];
          next[idx] = {
            ...next[idx],
            status: "complete",
            streamLabel: undefined,
            ...(
              mediaEventId || next[idx]?.mediaEventId
                ? { mediaEventId: mediaEventId ?? next[idx]?.mediaEventId }
                : {}
            ),
          };
          return next;
        });
        reopenWorkflowPopupAfterMediaCompletion();
        return;
      }
      videoUrls.forEach((url) => markVideoAsRecentlyProcessed(recentlyProcessedVideoUrlsRef.current, url, mediaEventId));

      const currentProjectId =
        runtimeRef.current.currentProjectSnapshot?.projectId ?? activeProjectId;

      const attachments: ChatAttachment[] = await Promise.all(videoUrls.map(async (url, index) => {
        const rawFileName =
          url.split(/[\\/]/).pop()?.split("?")[0] ||
          buildGeneratedMediaFallbackName("video", videoUrls.length, index);
        let urlFileName = rawFileName;
        try {
          urlFileName = decodeURIComponent(rawFileName);
        } catch {
          urlFileName = rawFileName;
        }
        const contentStem = detail.contentSummary
          ? videoUrls.length > 1
            ? `${detail.contentSummary}-${index + 1}`
            : detail.contentSummary
          : null;
        const fileName = contentStem
          ? `${contentStem}.mp4`
          : urlFileName;
        const cachedVideo = await cacheProjectVideoSource(url, fileName, currentProjectId);
        const fallbackVideo = resolveVideoAttachmentSource(url);
        return {
          id: crypto.randomUUID(),
          fileName,
          label: contentStem || undefined,
          mimeType: cachedVideo?.mimeType ?? "video/mp4",
          size: cachedVideo?.size ?? 0,
          kind: "video" as const,
          localPath: cachedVideo?.localPath ?? fallbackVideo.localPath,
          previewUrl: cachedVideo?.previewUrl ?? fallbackVideo.previewUrl,
        };
      }));

      setMessages((prev) => {
        const idx = findPendingMediaMessageIndex(prev, "video", mediaEventId);
        const mediaCopy = buildVideoMediaMessageV2({
          count: detail.count ?? rawVideoUrls.length,
          model: detail.model,
          resolution: detail.resolution,
          aspectRatio: detail.aspectRatio,
          provider: detail.provider,
          mode: detail.mode,
          contentSummary: detail.contentSummary,
        });
        if (idx !== -1) {
          const target = prev[idx];
          const finalAttachments = mergeCompletedVideoAttachments(target?.attachments, attachments);
          const realMsg = mk(
            "assistant",
            preserveExistingMediaDetailLines({
              existingContent: target?.content,
              nextContent: mediaCopy.done,
              preserveExistingDetails: !detail.contentSummary,
            }),
            undefined,
            finalAttachments,
          );
          const next = [...prev];
          next[idx] = {
            ...realMsg,
            ...(
              mediaEventId || target?.mediaEventId
                ? { mediaEventId: mediaEventId ?? target?.mediaEventId }
                : {}
            ),
          };
          return next;
        }
        const realMsg = mk("assistant", mediaCopy.done, undefined, attachments);
        if (hasMatchingCompletedMediaMessage(prev, attachments)) {
          return prev;
        }
        return [...prev, realMsg];
      });

      reopenWorkflowPopupAfterMediaCompletion();
    };
    window.addEventListener("agent:video-generated", handleVideoGenerated as EventListener);
    return () => window.removeEventListener("agent:video-generated", handleVideoGenerated as EventListener);
  }, [activeProjectId, reopenWorkflowPopupAfterMediaCompletion]);

  // 监听单条视频生成完成事件，逐条替换占位符（不等全部完成）
  useEffect(() => {
    const handleVideoGeneratedOne = async (event: Event) => {
      const detail = ((event as CustomEvent<{ url: string; label?: string; index: number; mediaEventId?: string; sceneId?: string; projectId?: string; segmentLabel?: string }>).detail ?? {}) as Partial<{ url: string; label?: string; index: number; mediaEventId?: string; sceneId?: string; projectId?: string; segmentLabel?: string }>;
      const { url, label, index, mediaEventId, sceneId, projectId: eventProjectId, segmentLabel } = detail;
      if (!url) return;

      // 标记为已处理，防止 agent:video-generated 最终事件重复创建消息
      markVideoAsRecentlyProcessed(recentlyProcessedVideoUrlsRef.current, url, mediaEventId);
      const attachment = await buildGeneratedVideoAttachmentFromEvent({
        url,
        label,
        sceneId,
        projectId: eventProjectId,
        segmentLabel,
        fallbackProjectId: runtimeRef.current.currentProjectSnapshot?.projectId ?? activeProjectId,
      });

      setMessages((prev) => {
        const msgIdx = findPendingMediaMessageIndex(prev, "video", mediaEventId);
        if (msgIdx === -1) return prev;
        const target = prev[msgIdx];
        if (!target?.attachments) return prev;

        const videoAttachments = target.attachments.filter((a) => a.kind === "video");
        const targetPlaceholder = videoAttachments[index];
        const next = [...prev];
        if (targetPlaceholder) {
          next[msgIdx] = {
            ...target,
            attachments: target.attachments.map((a) => a.id === targetPlaceholder.id ? attachment : a),
          };
        } else {
          next[msgIdx] = { ...target, attachments: [...target.attachments, attachment] };
        }
        return next;
      });
    };
    window.addEventListener("agent:video-generated-one", handleVideoGeneratedOne as EventListener);
    return () => window.removeEventListener("agent:video-generated-one", handleVideoGeneratedOne as EventListener);
  }, [activeProjectId]);

  useEffect(() => {
    const handleVideoGeneratingCancelled = (event: Event) => {
      const detail =
        ((event as CustomEvent<{ mediaEventId?: string }>).detail ?? {}) as Partial<{
          mediaEventId?: string;
        }>;
      const { mediaEventId } = detail;
      setMessages((prev) => {
        const idx = findPendingMediaMessageIndex(prev, "video", mediaEventId);
        if (idx === -1) return prev;
        const target = prev[idx];
        if (!target?.attachments?.length) return prev;

        const next = [...prev];
        next[idx] = {
          ...target,
          content: "媒体生成已取消，可继续选择下一步。",
          status: "complete",
          streamLabel: undefined,
          attachments: target.attachments.map((attachment) =>
            attachment.kind === "video" && attachment.pending
              ? {
                  ...attachment,
                  pending: false,
                  cancelled: true,
                }
              : attachment,
          ),
        };
        return next;
      });
    };

    window.addEventListener("agent:video-generating-cancelled", handleVideoGeneratingCancelled);
    return () => window.removeEventListener("agent:video-generating-cancelled", handleVideoGeneratingCancelled);
  }, []);

  useEffect(() => {
    const handleVideoGeneratedOneFailed = async (event: Event) => {
      const detail = ((event as CustomEvent<{
        index: number;
        label?: string;
        reason?: string;
        url?: string;
        projectId?: string;
        sceneId?: string;
        segmentLabel?: string;
        mediaEventId?: string;
      }>).detail ?? {}) as Partial<{
        index: number;
        label?: string;
        reason?: string;
        url?: string;
        projectId?: string;
        sceneId?: string;
        segmentLabel?: string;
        mediaEventId?: string;
      }>;
      const failureReason = resolveVideoFailureReason(detail.reason);
      const attachmentOverrides =
        detail.url
          ? await buildGeneratedVideoAttachmentFromEvent({
              url: detail.url,
              label: detail.label,
              sceneId: detail.sceneId,
              projectId: detail.projectId,
              segmentLabel: detail.segmentLabel,
              fallbackProjectId: runtimeRef.current.currentProjectSnapshot?.projectId ?? activeProjectId,
            })
          : undefined;

      setMessages((prev) => {
        const msgIdx = findPendingMediaMessageIndex(prev, "video", detail.mediaEventId);
        if (msgIdx === -1) return prev;
        const target = prev[msgIdx];
        if (!target?.attachments?.length) return prev;

        const next = [...prev];
        next[msgIdx] = markFailedMediaAttachmentsInMessage(target, {
          kind: "video",
          index: detail.index,
          label: detail.label,
          failureReason,
          attachmentOverrides,
          completionContent: buildMediaFailureCompletionContent({
            kind: "video",
            label: detail.label,
            failureReason,
          }),
        });
        return next;
      });
    };
    window.addEventListener("agent:video-generated-one-failed", handleVideoGeneratedOneFailed as EventListener);
    return () => window.removeEventListener("agent:video-generated-one-failed", handleVideoGeneratedOneFailed as EventListener);
  }, [activeProjectId]);

  useEffect(() => {
    const handleVideoGeneratingFailed = (event: Event) => {
      const detail = ((event as CustomEvent<{ reason?: string; mediaEventId?: string }>).detail ?? {}) as Partial<{
        reason?: string;
        mediaEventId?: string;
      }>;
      const failureReason = resolveVideoFailureReason(detail.reason);

      setMessages((prev) => {
        const msgIdx = findPendingMediaMessageIndex(prev, "video", detail.mediaEventId);
        if (msgIdx === -1) return prev;
        const target = prev[msgIdx];
        if (!target?.attachments?.length) return prev;

        const next = [...prev];
        next[msgIdx] = markFailedMediaAttachmentsInMessage(target, {
          kind: "video",
          settleAll: true,
          failureReason,
          completionContent: buildMediaFailureCompletionContent({
            kind: "video",
            failureReason,
          }),
        });
        return next;
      });
    };
    window.addEventListener("agent:video-generating-failed", handleVideoGeneratingFailed as EventListener);
    return () => window.removeEventListener("agent:video-generating-failed", handleVideoGeneratingFailed as EventListener);
  }, []);

  const resolveAssetTargetFromLookup = useCallback((lookup: Set<string>) => {
    const snapshotProjectId = runtimeRef.current.currentProjectSnapshot?.projectId;
    const project = runtimeRef.current.currentVideoProject;
    if (!project || !snapshotProjectId || snapshotProjectId !== project.id) return null;

    for (const character of project.characters ?? []) {
      if (matchesMediaUrl(lookup, character.imageUrl, ...(character.imageHistory ?? []).map((entry) => entry.imageUrl))) {
        return {
          action: "generate_video_reference_assets" as const,
          projectId: project.id,
          targetId: `reference-character:${character.id}`,
          regenerateMode: "generate" as const,
        };
      }
      for (const costume of character.costumes ?? []) {
        if (matchesMediaUrl(lookup, costume.imageUrl, ...(costume.imageHistory ?? []).map((entry) => entry.imageUrl))) {
          return {
            action: "generate_video_reference_assets" as const,
            projectId: project.id,
            targetId: `reference-character-variant:${character.id}:${costume.id}`,
            regenerateMode: "generate" as const,
          };
        }
      }
    }

    for (const sceneSetting of project.sceneSettings ?? []) {
      if (
        matchesMediaUrl(
          lookup,
          sceneSetting.imageUrl,
          ...(sceneSetting.imageHistory ?? []).map((entry) => entry.imageUrl),
        )
      ) {
        return {
          action: "generate_video_reference_assets" as const,
          projectId: project.id,
          targetId: `reference-scene:${sceneSetting.id}`,
          regenerateMode: "generate" as const,
        };
      }
      for (const variant of sceneSetting.timeVariants ?? []) {
        if (matchesMediaUrl(lookup, variant.imageUrl, ...(variant.imageHistory ?? []).map((entry) => entry.imageUrl))) {
          return {
            action: "generate_video_reference_assets" as const,
            projectId: project.id,
            targetId: `reference-scene-variant:${sceneSetting.id}:${variant.id}`,
            regenerateMode: "generate" as const,
          };
        }
      }
    }

    for (const scene of project.scenes ?? []) {
      if (matchesMediaUrl(lookup, scene.storyboardUrl, ...(scene.storyboardHistory ?? []))) {
        return {
          action: "generate_storyboard_frames" as const,
          projectId: project.id,
          targetId: scene.id,
          regenerateMode: "generate" as const,
        };
      }
      if (
        matchesMediaUrl(
          lookup,
          scene.videoUrl,
          ...(scene.videoHistory ?? []).map((entry) => entry.videoUrl),
        )
      ) {
        return {
          action: "generate_video_assets" as const,
          projectId: project.id,
          targetId: scene.id,
          regenerateMode: "redo-and-generate" as const,
        };
      }
    }

    for (const [segmentLabel, url] of Object.entries(project.segmentVideos ?? {})) {
      if (matchesMediaUrl(lookup, url)) {
        return {
          action: "generate_segment_video" as const,
          projectId: project.id,
          targetId: segmentLabel,
          regenerateMode: "redo-and-generate" as const,
        };
      }
    }

    return null;
  }, []);

  // 鐩戝惉"浼犲叆绱犳潗搴?浜嬩欢锛屽皢鍥剧墖/瑙嗛娣诲姞鍒板綋鍓嶉」鐩殑绱犳潗娓呭崟
  useEffect(() => {
    const handleAddToAssets = async (event: Event) => {
      const detail = ((event as CustomEvent<AssetLibraryEventDetail>).detail ?? {}) as Partial<AssetLibraryEventDetail>;
      const directAssets: IncomingAssetItem[] = detail.url
        ? [{
            url: detail.localPath || detail.url,
            fileName: normalizeAssetLibraryFileName(detail.fileName, detail.localPath || detail.url),
            kind: detail.kind ?? (isVideoAssetFile(detail.localPath || detail.url, detail.fileName) ? "video" : "image"),
            target: detail.target,
            preferredTab: detail.preferredTab,
            preferredImageSubTab: detail.preferredImageSubTab,
            isHistoricalVersion: detail.isHistoricalVersion,
            historyEntryId: detail.historyEntryId,
          }]
        : [];
      const droppedFiles = Array.isArray(detail.files) ? detail.files : [];
      const preparedFileAssets =
        droppedFiles.length > 0
          ? (await prepareChatAttachments(droppedFiles))
              .map((attachment): IncomingAssetItem => ({
                url: attachment.localPath || attachment.previewUrl || "",
                fileName: normalizeAssetLibraryFileName(
                  attachment.fileName,
                  attachment.localPath || attachment.previewUrl || "",
                ),
                kind: attachment.kind === "video" ? "video" : "image",
                ...(attachment.generationContext ? { target: attachment.generationContext } : {}),
              }))
              .filter((asset) => Boolean(asset.url))
          : [];
      const incomingAssets = [...directAssets, ...preparedFileAssets].filter(
        (asset) =>
          asset.url &&
          !asset.url.startsWith("blob:") &&
          !isExpiredRemoteSignedMediaUrl(asset.url) &&
          !isKnownPlaceholderMediaUrl(asset.url),
      );
      if (!incomingAssets.length) return;

      const currentRuntime = runtimeRef.current;
      const snapshot = currentRuntime.currentProjectSnapshot;
      const currentVideoProject = currentRuntime.currentVideoProject;
      if (!snapshot || !currentVideoProject || snapshot.projectId !== currentVideoProject.id) {
        flashMaintenanceHint("当前只有视频项目支持把媒体同步进素材库。", 2400);
        return;
      }

      let workingProject: ActiveVideoProject = currentVideoProject;
      let focusAssetId: string | null = null;
      let focusMessage = "";
      const existingUrls = new Set((workingProject.assetManifest?.items ?? []).map((item) => item.url));
      const replacedSegmentVideoLabels = new Set<string>();

      for (const incoming of incomingAssets) {
        if (
          incoming.kind === "video" &&
          incoming.isHistoricalVersion &&
          isExpiredRemoteSignedMediaUrl(incoming.url)
        ) {
          flashMaintenanceHint("该历史视频已过期失效，无法加入素材库。", 2400);
          continue;
        }
        const lookup = collectMediaMatchKeys(incoming.fileName, incoming.url);
        const resolvedTarget = (
          incoming.target?.targetId &&
          (!incoming.target.projectId || incoming.target.projectId === workingProject.id)
            ? {
                ...incoming.target,
                projectId: workingProject.id,
              }
            : null
        ) ?? resolveAssetTargetFromLookup(lookup);

        if (resolvedTarget?.targetId) {
          const isSegmentVideoReplacement =
            incoming.kind === "video" &&
            (resolvedTarget.action === "generate_segment_video" || resolvedTarget.action === "replace_segment_video");
          if (isSegmentVideoReplacement && incoming.historyEntryId) {
            const { promoteArchivedSegmentVideoCandidateToOfficialAsset } = await loadVideoWorkflowService();
            workingProject = await promoteArchivedSegmentVideoCandidateToOfficialAsset({
              project: workingProject,
              segmentLabel: resolvedTarget.targetId,
              historyEntryId: incoming.historyEntryId,
            });
          } else {
            workingProject = applyAssetReplacement(workingProject, resolvedTarget, incoming);
          }
          if (isSegmentVideoReplacement && !incoming.historyEntryId) {
            replacedSegmentVideoLabels.add(resolvedTarget.targetId);
          }
          focusAssetId = deriveAssetIdFromTarget(resolvedTarget);
          focusMessage =
            isSegmentVideoReplacement && incoming.historyEntryId
              ? "已传递到正式视频栏，并开始同步六宫格抽帧"
              : incoming.kind === "video"
                ? "已替换当前视频素材"
                : "已替换当前图片素材";
          continue;
        }

        if (existingUrls.has(incoming.url)) {
          continue;
        }
        existingUrls.add(incoming.url);

        const createdAt = new Date().toISOString();
        const manualItem: ProductionAssetRecord = {
          id: `manual:${crypto.randomUUID()}`,
          kind: incoming.kind === "video" ? "video-segment" : "character-reference",
          label: incoming.kind === "video" ? `视频 · ${incoming.fileName}` : `其他 · ${incoming.fileName}`,
          url: incoming.url,
          meta: incoming.kind === "video" ? "手动加入" : "手动加入 / 其他图片",
          reusable: true,
          status: "ready",
          origin: "manual",
          version: 1,
          createdAt,
        };

        workingProject = {
          ...workingProject,
          assetManifest: {
            version: workingProject.assetManifest?.version ?? "1",
            summary: workingProject.assetManifest?.summary ?? "",
            items: [...(workingProject.assetManifest?.items ?? []), manualItem],
          },
        };
        focusAssetId = manualItem.id;
        focusMessage = incoming.kind === "video" ? "已加入视频素材库" : "已归档到“其他”图片栏";
      }

      if (replacedSegmentVideoLabels.size) {
        workingProject = synchronizeVideoProductionState(workingProject);
        for (const segmentLabel of replacedSegmentVideoLabels) {
          workingProject = await refreshSegmentContinuityArtifactsInProject({
            project: workingProject,
            segmentLabel,
            videoUrl: workingProject.segmentVideos?.[segmentLabel],
          });
        }
      }

      const saved = await upsertStoredVideoProject(synchronizeVideoProductionState(workingProject));
      const savedManifest = saved.assetManifest ?? workingProject.assetManifest ?? null;
      const nextFocusId =
        focusAssetId?.startsWith("segment:")
          ? `video-segment-${focusAssetId.slice("segment:".length)}`
          : focusAssetId && savedManifest?.items.some((item) => item.id === focusAssetId)
            ? focusAssetId
            : focusMessage && savedManifest?.items.length
              ? savedManifest.items[savedManifest.items.length - 1]?.id ?? null
              : null;

      startTransition(() => {
        setRuntime((prev) => ({
          ...prev,
          currentVideoProject:
            prev.currentVideoProject?.id === saved.id ? saved : prev.currentVideoProject,
          currentProjectSnapshot:
            prev.currentProjectSnapshot?.projectId === saved.id
              ? {
                  ...prev.currentProjectSnapshot,
                  memory: {
                    ...prev.currentProjectSnapshot.memory,
                    assetManifest: saved.assetManifest,
                    automationState: saved.automationState ?? null,
                    videoAuditPackets: saved.videoAuditPackets ?? [],
                    videoRepairTasks: saved.videoRepairTasks ?? [],
                    reviewQueue: saved.reviewQueue ?? [],
                  },
                }
              : prev.currentProjectSnapshot,
        }));
      });

      if (nextFocusId && focusMessage) {
        setSidebarAssetFocus({ assetId: nextFocusId, message: focusMessage });
        flashMaintenanceHint(focusMessage, 2200);
      }
    };
    window.addEventListener("agent:add-to-assets", handleAddToAssets);
    return () => window.removeEventListener("agent:add-to-assets", handleAddToAssets);
  }, [flashMaintenanceHint, refreshSegmentContinuityArtifactsInProject, resolveAssetTargetFromLookup, setRuntime]);

  // 浠庣礌鏉愬簱鍒犻櫎绱犳潗
  const handleDeleteAsset = useCallback((asset: import("@/components/home-agent/home-agent-sidebar-utils").SidebarAssetItem) => {
    // 仅从素材清单中移除，不删除磁盘文件（文件可能仍被对话附件引用）
    startTransition(() => {
      setRuntime((prev) => {
        const snapshot = prev.currentProjectSnapshot;
        if (!snapshot || !prev.currentVideoProject) return prev;
        const newVideoProject = clearAssetFromVideoProject(prev.currentVideoProject, asset.id);
        void upsertStoredVideoProject(synchronizeVideoProductionState(newVideoProject));

        return {
          ...prev,
          currentVideoProject: newVideoProject,
          currentProjectSnapshot: {
            ...snapshot,
            memory: {
              ...snapshot.memory,
              assetManifest: synchronizeVideoProductionState(newVideoProject).assetManifest,
            },
          },
        };
      });
    });
  }, [setRuntime]);

  useEffect(() => {
    const snapshot = runtime.currentProjectSnapshot;
    const project = runtime.currentVideoProject;
    const manifest = snapshot?.memory?.assetManifest;
    if (!snapshot || !project || snapshot.projectId !== project.id || !manifest?.items.length) {
      return;
    }

    let cancelled = false;
    void (async () => {
      const invalidIds: string[] = [];
      for (const item of manifest.items) {
        if (!shouldAutoCleanupInvalidAsset(item)) {
          continue;
        }
        const url = item.url?.trim();
        if (!url || isExpiredRemoteSignedMediaUrl(url) || isKnownPlaceholderMediaUrl(url)) {
          invalidIds.push(item.id);
          continue;
        }
        if (isLocalSidebarAssetUrl(url)) {
          const missing = await isMediaAssetDefinitelyMissing(url);
          if (missing) invalidIds.push(item.id);
        }
        if (
          item.kind === "video-segment" &&
          item.origin === "manual" &&
          isHistoricalProjectVideo(project, url) &&
          isExpiredRemoteSignedMediaUrl(url)
        ) {
          invalidIds.push(item.id);
        }
      }

      if (!invalidIds.length || cancelled) return;

      const cleanedProject = invalidIds.reduce(
        (current, assetId) => clearAssetFromVideoProject(current, assetId),
        project,
      );
      const saved = await upsertStoredVideoProject(synchronizeVideoProductionState(cleanedProject));
      if (cancelled) return;

      startTransition(() => {
        setRuntime((prev) => ({
          ...prev,
          currentVideoProject:
            prev.currentVideoProject?.id === saved.id ? saved : prev.currentVideoProject,
          currentProjectSnapshot:
            prev.currentProjectSnapshot?.projectId === saved.id
              ? {
                  ...prev.currentProjectSnapshot,
                  memory: {
                    ...prev.currentProjectSnapshot.memory,
                    assetManifest: saved.assetManifest,
                  },
                }
              : prev.currentProjectSnapshot,
        }));
      });
      flashMaintenanceHint(`素材库已自动清理 ${invalidIds.length} 个失效或历史媒体。`, 2400);
    })();

    return () => {
      cancelled = true;
    };
  }, [flashMaintenanceHint, runtime.currentProjectSnapshot, runtime.currentVideoProject, setRuntime]);

  const {
    send,
    reset: runtimeReset,
    answer,
    handleTemplateLaunch,
    autoResearchChoiceHandler,
    handleFullAutoChoiceSelect,
    handleFullAutoQuestionBack,
    handleFullAutoQuestionReset,
    stopFullAutoExecution,
    isAwaitingWorkflowDocumentUpload,
    stopActiveExecution,
  } = useHomeAgentRuntimeActions({
    runtime,
    systemPrompt:
      creationMode === "creative"
        ? `${PROMPT}\n\n${ASSET_CREATION_PROMPT_OVERRIDE}\n\n${LLM_CONTROL_MODE_APPENDIX}`
        : `${PROMPT}\n\n${ASSET_CREATION_PROMPT_OVERRIDE}`,
    creationMode,
    automationMode,
    qState,
    deferredQuestionState,
    engineRef,
    runtimeRef,
    messagesRef,
    compactedMessageCountRef,
    surfacedTaskIdsRef,
    surfacedTaskFollowupIdsRef,
    loadEngineDeps,
    loadApiConfigModule,
    loadStructuredQuestionParser,
    loadConversationMemoryModule,
    loadProjectStore,
    loadAskUserQuestionModule,
    loadWorkflowActionsModule,
    flashMaintenanceHint,
    resetComposerDraft,
    buildResearchPromptOverlay,
    createQuestionState,
    toQuery,
    textOf,
    qStepKey,
    push,
    selectedTextModelKey,
    setPopoverOverride,
    setSuggested,
    setMode,
    setQState,
    setDeferredQuestionState,
    setSelectedValues,
    setDeferredSelectedValues,
    setStreaming,
    setRuntime,
    setCompactedMessageCount,
    setMessages,
    setMetaReady,
    setActiveProjectId,
    setActiveWorkflowAction,
    setFullAutoChecklistCollapsed,
    activeProjectId,
    pendingWorkflowUploadKind,
    setPendingWorkflowUploadKind,
    setDeferredDraft,
    lastSuggestedRef,
    backgroundResearchGroupsRef,
    selectedImageModelFamily,
    imageGenerationPrefs,
    selectedVideoModelKey,
    videoGenerationPrefs,
    restoreInterruptedChoiceQuestion,
    setInterruptedChoiceQuestion,
    requestScrollToBottom: requestScrollToBottomAfterQuickLaunch,
    preferredVideoWorkflowSourceSnapshotRef,
  });

  const handleEditUserMessage = useCallback(
    async (messageId: string, newContent: string) => {
      const trimmed = newContent.trim();
      if (!trimmed) return;

      engineRef.current?.interrupt();
      engineRef.current = null;

      const pendingRequestId = qState?.request.id;
      if (pendingRequestId) {
        try {
          const mod = await loadAskUserQuestionModule();
          mod.rejectAskUserQuestion(pendingRequestId, "User edited conversation history");
        } catch {
          /* ignore */
        }
      }

      flushSync(() => {
        setStreaming(false);
        setMessages((prev) => {
          const i = prev.findIndex((m) => m.id === messageId);
          if (i === -1 || prev[i].role !== "user") return prev;
          const next = prev.slice(0, i);
          messagesRef.current = next;
          return next;
        });
        compactedMessageCountRef.current = 0;
        setCompactedMessageCount(0);
        setQState(null);
        setPopoverOverride(null);
        setSuggested(null);
        setSelectedValues([]);
      });

      await send(trimmed);
    },
    [
      loadAskUserQuestionModule,
      qState?.request.id,
      send,
      setCompactedMessageCount,
      setMessages,
      setPopoverOverride,
      setQState,
      setSelectedValues,
      setStreaming,
      setSuggested,
    ],
  );

  const handleSaveArtifactText = useCallback(
    async (
      field: "creativePlan" | "structureTransform" | "characters" | "characterTransform" | "directoryRaw" | "outlines",
      label: string,
      text: string,
    ) => {
      try {
        const workflowActions = await loadWorkflowActionsModule();
        const runtime = runtimeRef.current;
        const result = await workflowActions.runWorkflowAction(
          "update_drama_artifact_text",
          {
            projectId: runtime.currentProjectSnapshot?.projectId,
            field,
            text,
          },
          runtime,
        );

        const nextRuntime = result.data
          ? mergeRuntimeWithWorkflowDelta(runtime, result.data)
          : runtime;
        const nextSnapshot =
          result.projectSnapshot ?? result.data?.projectSnapshot ?? nextRuntime.currentProjectSnapshot;

        if (result.data) {
          setRuntime(nextRuntime);
        }
        if (nextSnapshot?.projectId) {
          const nextSessionProjectId = resolveSessionProjectIdForSnapshot({
            currentSessionProjectId: activeProjectId,
            snapshot: nextSnapshot,
            fallbackProjectId: nextSnapshot.projectId,
          });
          if (nextSessionProjectId) {
            setActiveProjectId(nextSessionProjectId);
          }
          const nextArtifactIdsForField = new Set(
            nextSnapshot.artifacts
              .filter((artifact) => artifact.editor?.field === field)
              .map((artifact) => artifact.id),
          );
          const fallbackArtifactForField = nextSnapshot.artifacts.find((artifact) => artifact.editor?.field === field);

          if (nextArtifactIdsForField.size > 0) {
            setMessages((previousMessages) =>
              previousMessages.map((message) => {
                if (!message.artifactSnapshots?.length) return message;

                let changed = false;
                const artifactSnapshots = message.artifactSnapshots.map((artifact) => {
                  if (!nextArtifactIdsForField.has(artifact.id) && artifact.editor?.field !== field) {
                    return artifact;
                  }
                  const refreshed =
                    resolveArtifactSnapshots(nextSnapshot, [artifact.id])[0] ??
                    (artifact.editor?.field === field && fallbackArtifactForField
                      ? resolveArtifactSnapshots(nextSnapshot, [fallbackArtifactForField.id])[0]
                      : undefined);
                  if (!refreshed) return artifact;
                  changed = true;
                  return refreshed;
                });

                return changed ? { ...message, artifactSnapshots } : message;
              }),
            );
          }
        }

        flashMaintenanceHint(`已保存${label}`, 1800);
      } catch (error) {
        flashMaintenanceHint(
          error instanceof Error ? error.message : "保存文本失败，请稍后重试。",
          3200,
        );
        throw error;
      }
    },
    [activeProjectId, flashMaintenanceHint, loadWorkflowActionsModule, setActiveProjectId, setRuntime],
  );

  const handleRelationshipDiagramCollapsedChange = useCallback(
    async (collapsed: boolean) => {
      const projectId = runtimeRef.current.currentProjectSnapshot?.projectId;
      if (!projectId) return;

      try {
        const store = await loadProjectStore();
        const updated = store.updateStoredDramaProjectArtifactPreferences(projectId, {
          relationshipDiagramCollapsed: collapsed,
        });
        if (!updated) return;

        startTransition(() => {
          setRuntime((prev) => {
            const nextSnapshot = updated.projectSnapshot;
            const nextRecentProjects = mergeRecentProjects(prev.recentProjects, nextSnapshot);

            return {
              ...prev,
              currentDramaProject:
                prev.currentProjectSnapshot?.projectId === nextSnapshot.projectId
                  ? updated.dramaProject
                  : prev.currentDramaProject,
              currentProjectSnapshot:
                prev.currentProjectSnapshot?.projectId === nextSnapshot.projectId
                  ? nextSnapshot
                  : prev.currentProjectSnapshot,
              recentProjects: nextRecentProjects,
            };
          });
        });
      } catch (error) {
        flashMaintenanceHint(
          error instanceof Error ? error.message : "保存关系图折叠状态失败，请稍后重试。",
          3200,
        );
        throw error;
      }
    },
    [flashMaintenanceHint, loadProjectStore, setRuntime],
  );

  const setInlineAttachmentPending = useCallback(
    (messageId: string, attachmentId: string, pending: boolean) => {
      setMessages((prev) =>
        prev.map((message) => {
          if (message.id !== messageId || !message.attachments?.length) return message;
          return {
            ...message,
            attachments: message.attachments.map((attachment) =>
              attachment.id === attachmentId
                ? {
                    ...attachment,
                    pending,
                    cancelled: false,
                  }
                : attachment,
            ),
          };
        }),
      );
    },
    [setMessages],
  );

  const resolveInlineAttachmentTarget = useCallback((attachment: ChatAttachment) => {
    const lookup = collectMediaMatchKeys(
      attachment.fileName,
      attachment.localPath,
      attachment.previewUrl,
      ...(attachment.history ?? []).flatMap((entry) => [entry.fileName, entry.localPath, entry.previewUrl]),
    );

    return resolveAssetTargetFromLookup(lookup) ??
      (attachment.generationContext?.projectId && attachment.generationContext?.targetId
        ? {
            action: attachment.generationContext.action,
            projectId: attachment.generationContext.projectId,
            targetId: attachment.generationContext.targetId,
            regenerateMode: attachment.generationContext.regenerateMode ?? "generate",
          }
        : null);
  }, [resolveAssetTargetFromLookup]);

  const commitInlineAttachmentResult = useCallback(
    async (params: {
      messageId: string;
      attachmentId: string;
      attachment: ChatAttachment;
      url: string;
      target: AssetLibraryTarget & {
        projectId: string;
        targetId: string;
      };
      kind: "image" | "video";
    }) => {
      const { messageId, attachmentId, attachment, url, target, kind } = params;
      let previewUrl: string | undefined;
      let localPath = url;
      let fileName = attachment.fileName;
      let mimeType = attachment.mimeType;
      let size = attachment.size;

      if (kind === "image") {
        if (url.startsWith("data:") || url.startsWith("http://") || url.startsWith("https://")) {
          previewUrl = url;
        } else if (isLocalSidebarAssetUrl(url)) {
          previewUrl = (await resolveLocalMediaPreviewDataUrl(url)) || undefined;
          if (previewUrl?.startsWith("data:")) {
            const match = previewUrl.match(/^data:([^;]+);base64,/);
            if (match?.[1]) mimeType = match[1];
          }
        }
        const derivedName = decodeMediaFileName(url.split(/[\\/]/).pop()?.replace(/\?.*$/, "") || "");
        fileName = derivedName || fileName;
      } else {
        const derivedName =
          decodeMediaFileName(url.split(/[\\/]/).pop()?.split("?")[0] || "") || attachment.fileName;
        fileName = derivedName;
        const cachedVideo = await cacheProjectVideoSource(url, fileName, target.projectId);
        const fallbackVideo = resolveVideoAttachmentSource(url);
        localPath = cachedVideo?.localPath ?? fallbackVideo.localPath;
        previewUrl = cachedVideo?.previewUrl ?? fallbackVideo.previewUrl;
        mimeType = cachedVideo?.mimeType ?? mimeType;
        size = cachedVideo?.size ?? size;
      }

      const nextVersion = {
        id: crypto.randomUUID(),
        fileName,
        label: attachment.label,
        localPath,
        previewUrl,
        createdAt: new Date().toISOString(),
      };

      setMessages((prev) =>
        prev.map((message) => {
          if (message.id !== messageId || !message.attachments?.length) return message;
          return {
            ...message,
            attachments: message.attachments.map((item) => {
              if (item.id !== attachmentId) return item;
              const versions = [...(item.history ?? [])];
              if (item.previewUrl || item.localPath) {
                const currentKey = JSON.stringify([item.fileName, item.localPath, item.previewUrl]);
                const hasCurrent = versions.some(
                  (entry) => JSON.stringify([entry.fileName, entry.localPath, entry.previewUrl]) === currentKey,
                );
                if (!hasCurrent) {
                  versions.push({
                    id: crypto.randomUUID(),
                    fileName: item.fileName,
                    label: item.label,
                    localPath: item.localPath,
                    previewUrl: item.previewUrl,
                    createdAt: new Date().toISOString(),
                  });
                }
              }
              const nextKey = JSON.stringify([nextVersion.fileName, nextVersion.localPath, nextVersion.previewUrl]);
              if (!versions.some((entry) => JSON.stringify([entry.fileName, entry.localPath, entry.previewUrl]) === nextKey)) {
                versions.push(nextVersion);
              }
              return {
                ...item,
                fileName,
                mimeType,
                size,
                localPath,
                previewUrl,
                pending: false,
                cancelled: false,
                history: versions,
                generationContext: {
                  action: target.action,
                  projectId: target.projectId,
                  targetId: target.targetId,
                  regenerateMode: target.regenerateMode,
                },
              };
            }),
          };
        }),
      );
    },
    [setMessages],
  );

  const handleAssistantFeedback = useCallback((messageId: string, vote: "up" | "down" | null) => {
    const prev = messagesRef.current.find((m) => m.id === messageId);
    const preview = (prev?.content ?? "").slice(0, 240);
    recordAssistantFeedbackLog({
      messageId,
      action: vote === null ? "clear" : vote,
      contentPreview: preview,
    });
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId && m.role === "assistant"
          ? { ...m, ...(vote ? { feedback: vote } : { feedback: undefined }) }
          : m,
      ),
    );
  }, [setMessages]);

  const handleRegenerateAssistant = useCallback(
    async (assistantMessageId: string, attachmentId?: string) => {
      const list = messagesRef.current;
      const idx = list.findIndex((m) => m.id === assistantMessageId);
      if (idx === -1 || list[idx]?.role !== "assistant") return;
      const workflowRefresh = list[idx]?.workflowRefresh;

      if (attachmentId) {
        const message = list[idx];
        const attachment = message.attachments?.find((item) => item.id === attachmentId);
        if (!attachment) return;
        const guardKey = `${assistantMessageId}:${attachmentId}`;
        const existingGuardController = inlineAttachmentGuardAbortControllersRef.current.get(guardKey);
        if (existingGuardController) {
          existingGuardController.abort();
          inlineAttachmentGuardAbortControllersRef.current.delete(guardKey);
          flashMaintenanceHint("已撤回这次重生成。", 2200);
          return;
        }

        const target = resolveInlineAttachmentTarget(attachment);
        if (!target) {
          flashMaintenanceHint("这条素材暂时还无法精确映射到项目资产，请先从弹窗面板里重新生成一次。", 2600);
          return;
        }
        if (!target.projectId || !target.targetId) {
          flashMaintenanceHint("这条素材缺少项目定位信息，请先从弹窗面板里重新生成一次。", 2600);
          return;
        }

        const normalizedImagePrefs = normalizeVideoImageGenerationPrefs({
          ...imageGenerationPrefs,
          familyKey: selectedImageModelFamily,
        });
        const normalizedVideoPrefs = normalizeVideoGenerationPrefs({
          ...videoGenerationPrefs,
          modelKey: normalizeHomeAgentVideoModelKey(selectedVideoModelKey),
        });
        const applyWorkflowResult = (
          currentRuntime: StudioRuntimeState,
          result: Awaited<
            ReturnType<(Awaited<ReturnType<typeof loadWorkflowActionsModule>>)["runWorkflowAction"]>
          >,
        ) => {
          if (!result.data) return currentRuntime;
          const nextRuntime = mergeRuntimeWithWorkflowDelta(currentRuntime, result.data);
          startTransition(() => {
            setRuntime(nextRuntime);
            const nextSessionProjectId = resolveSessionProjectIdForSnapshot({
              currentSessionProjectId: activeProjectId,
              snapshot: nextRuntime.currentProjectSnapshot,
              fallbackProjectId: nextRuntime.currentProjectSnapshot?.projectId,
            });
            if (nextSessionProjectId) {
              setActiveProjectId(nextSessionProjectId);
            }
          });
          return nextRuntime;
        };
        const resolveLatestTargetUrl = (currentRuntime: StudioRuntimeState) => {
          const project = currentRuntime.currentVideoProject;
          if (!project) return "";
          if (target.action === "generate_storyboard_frames") {
            return project.scenes.find((scene) => scene.id === target.targetId)?.storyboardUrl?.trim() || "";
          }
          if (target.action === "generate_video_assets") {
            return project.scenes.find((scene) => scene.id === target.targetId)?.videoUrl?.trim() || "";
          }
          if (target.action === "generate_segment_video" || target.action === "replace_segment_video") {
            return project.segmentVideos?.[target.targetId]?.trim() || "";
          }
          if (target.targetId.startsWith("reference-character-variant:")) {
            const [, characterId = "", variantId = ""] = target.targetId.split(":").slice(1);
            return (
              project.characters
                .find((character) => character.id === characterId)
                ?.costumes?.find((variant) => variant.id === variantId)
                ?.imageUrl?.trim() || ""
            );
          }
          if (target.targetId.startsWith("reference-character:")) {
            const characterId = target.targetId.replace("reference-character:", "");
            return project.characters.find((character) => character.id === characterId)?.imageUrl?.trim() || "";
          }
          if (target.targetId.startsWith("reference-scene-variant:")) {
            const [, sceneSettingId = "", variantId = ""] = target.targetId.split(":").slice(1);
            return (
              project.sceneSettings
                .find((sceneSetting) => sceneSetting.id === sceneSettingId)
                ?.timeVariants?.find((variant) => variant.id === variantId)
                ?.imageUrl?.trim() || ""
            );
          }
          if (target.targetId.startsWith("reference-scene:")) {
            const sceneSettingId = target.targetId.replace("reference-scene:", "");
            return project.sceneSettings.find((sceneSetting) => sceneSetting.id === sceneSettingId)?.imageUrl?.trim() || "";
          }
          return "";
        };
        const guardController = new AbortController();
        inlineAttachmentGuardAbortControllersRef.current.set(guardKey, guardController);
        if (INLINE_MEDIA_REGENERATE_GUARD_DELAY_MS > 0) {
          const guardSeconds = Math.max(1, Math.ceil(INLINE_MEDIA_REGENERATE_GUARD_DELAY_MS / 1000));
          flashMaintenanceHint(
            `已进入 ${guardSeconds} 秒防误触保护，再点一次同一张素材可撤回。`,
            INLINE_MEDIA_REGENERATE_GUARD_DELAY_MS + 200,
          );
        }

        try {
          await waitForAbortableDelay(INLINE_MEDIA_REGENERATE_GUARD_DELAY_MS, guardController.signal);
          inlineAttachmentGuardAbortControllersRef.current.delete(guardKey);
          const workflow = await loadWorkflowActionsModule();
          setInlineAttachmentPending(assistantMessageId, attachmentId, true);
          let nextRuntime = runtimeRef.current;
          if (target.action === "generate_video_assets") {
            nextRuntime = applyWorkflowResult(
              nextRuntime,
              await workflow.runWorkflowAction(
                "generate_video_assets",
                {
                  projectId: target.projectId,
                  targetIds: [target.targetId],
                  forceRegenerate: true,
                  selectedVideoModelKey: normalizedVideoPrefs.modelKey,
                  videoModelKey: normalizedVideoPrefs.modelKey,
                  videoGenerationPrefs: normalizedVideoPrefs,
                  abortSignal: guardController.signal,
                },
                nextRuntime,
              ),
            );

            const latestUrl = resolveLatestTargetUrl(nextRuntime);

            if (!latestUrl) {
              throw new Error("视频仍在后台处理中，请稍后再试。");
            }

            await commitInlineAttachmentResult({
              messageId: assistantMessageId,
              attachmentId,
              attachment,
              url: latestUrl,
              target,
              kind: "video",
            });
          } else if (target.action === "generate_segment_video" || target.action === "replace_segment_video") {
            nextRuntime = applyWorkflowResult(
              nextRuntime,
              await workflow.runWorkflowAction(
                "generate_segment_video",
                {
                  projectId: target.projectId,
                  segmentLabel: target.targetId,
                  selectedVideoModelKey: normalizedVideoPrefs.modelKey,
                  videoModelKey: normalizedVideoPrefs.modelKey,
                  videoGenerationPrefs: normalizedVideoPrefs,
                  abortSignal: guardController.signal,
                },
                nextRuntime,
              ),
            );

            const latestUrl = resolveLatestTargetUrl(nextRuntime);

            if (!latestUrl) {
              throw new Error("片段视频仍在后台处理中，请稍后再试。");
            }

            await commitInlineAttachmentResult({
              messageId: assistantMessageId,
              attachmentId,
              attachment,
              url: latestUrl,
              target: {
                ...target,
                action: "generate_segment_video",
                regenerateMode: "redo-and-generate",
              },
              kind: "video",
            });
          } else {
            const result = await workflow.runWorkflowAction(
              target.action,
              {
                projectId: target.projectId,
                targetIds: [target.targetId],
                forceRegenerate: true,
                selectedImageModelFamily: normalizedImagePrefs.familyKey,
                modelFamily: normalizedImagePrefs.familyKey,
                imageGenerationPrefs: normalizedImagePrefs,
                aspectRatio: normalizedImagePrefs.aspectRatio,
                resolution: normalizedImagePrefs.resolution,
                abortSignal: guardController.signal,
              },
              nextRuntime,
            );
            nextRuntime = applyWorkflowResult(nextRuntime, result);
            const latestUrl = resolveLatestTargetUrl(nextRuntime) || result.imageUrls?.[0] || "";
            if (!latestUrl) {
              throw new Error("没有拿到新的图片结果。");
            }
            await commitInlineAttachmentResult({
              messageId: assistantMessageId,
              attachmentId,
              attachment,
              url: latestUrl,
              target,
              kind: "image",
            });
          }

          const nextSuggestion = nextRuntime.currentProjectSnapshot
            ? recQuestion(nextRuntime.currentProjectSnapshot, nextRuntime.currentVideoProject)
            : null;
          if (nextSuggestion && !hasRunningVideoGenerationTasks(nextRuntime.currentVideoProject)) {
            startTransition(() => {
              setSuggested(null);
              setPopoverOverride(nextSuggestion);
            });
          }
        } catch (error) {
          setInlineAttachmentPending(assistantMessageId, attachmentId, false);
          if (error instanceof Error && error.name === "AbortError") {
            return;
          }
          flashMaintenanceHint(error instanceof Error ? error.message : "鍘熷湴閲嶆柊鐢熸垚澶辫触", 2800);
        } finally {
          inlineAttachmentGuardAbortControllersRef.current.delete(guardKey);
        }
        return;
      }

      if (workflowRefresh && idx === list.length - 1) {
        const pendingRequestId = qState?.request.id;
        if (pendingRequestId) {
          try {
            const mod = await loadAskUserQuestionModule();
            mod.rejectAskUserQuestion(pendingRequestId, "User regenerated workflow response");
          } catch {
            /* ignore */
          }
        }

        const restoreQuestion = runtimeRef.current.currentProjectSnapshot
          ? recQuestion(runtimeRef.current.currentProjectSnapshot, runtimeRef.current.currentVideoProject)
          : null;

        flushSync(() => {
          setStreaming(false);
          setMessages((prev) => {
            const i = prev.findIndex((m) => m.id === assistantMessageId);
            if (i === -1 || prev[i].role !== "assistant") return prev;
            const next = prev.slice(0, i);
            messagesRef.current = next;
            return next;
          });
          compactedMessageCountRef.current = 0;
          setCompactedMessageCount(0);
          setQState(null);
          setPopoverOverride(null);
          setSuggested(null);
          setSelectedValues([]);
        });

        if (workflowRefresh.mode === "shortcut") {
          workflowRefreshShortcutRunnerRef.current?.(
            workflowRefresh.action,
            workflowRefresh.input,
            workflowRefresh.userBubble,
            {
              restoreQuestionOnInterrupt: restoreQuestion,
              restoreQuestionOnCancel: restoreQuestion,
              restoreQuestionOnError: restoreQuestion,
              restoreQuestionAfterRun: restoreQuestion,
              skipUserBubble: true,
            },
          );
          return;
        }

        workflowRefreshShortcutChainRunnerRef.current?.(workflowRefresh.steps, workflowRefresh.userBubble, {
          restoreQuestionOnInterrupt: restoreQuestion,
          restoreQuestionOnError: restoreQuestion,
          restoreQuestionAfterRun: restoreQuestion,
          skipUserBubble: true,
        });
        return;
      }

      let u = idx - 1;
      while (u >= 0 && list[u].role !== "user") u -= 1;
      if (u < 0) return;
      const userContent = list[u].content.trim();
      if (!userContent) return;

      engineRef.current?.interrupt();
      engineRef.current = null;

      const pendingRequestId = qState?.request.id;
      if (pendingRequestId) {
        try {
          const mod = await loadAskUserQuestionModule();
          mod.rejectAskUserQuestion(pendingRequestId, "User regenerated assistant response");
        } catch {
          /* ignore */
        }
      }

      flushSync(() => {
        setStreaming(false);
        setMessages((prev) => {
          const i = prev.findIndex((m) => m.id === assistantMessageId);
          if (i === -1 || prev[i].role !== "assistant") return prev;
          const next = prev.slice(0, i);
          messagesRef.current = next;
          return next;
        });
        compactedMessageCountRef.current = 0;
        setCompactedMessageCount(0);
        setQState(null);
        setPopoverOverride(null);
        setSuggested(null);
        setSelectedValues([]);
      });

      await send(userContent, userContent, { skipUserBubble: true });
    },
    [
      activeProjectId,
      loadAskUserQuestionModule,
      loadWorkflowActionsModule,
      imageGenerationPrefs,
      selectedImageModelFamily,
      selectedVideoModelKey,
      videoGenerationPrefs,
      flashMaintenanceHint,
      commitInlineAttachmentResult,
      resolveInlineAttachmentTarget,
      qState?.request.id,
      send,
      setActiveProjectId,
      setCompactedMessageCount,
      setInlineAttachmentPending,
      setMessages,
      setPopoverOverride,
      setQState,
      setSelectedValues,
      setStreaming,
      setSuggested,
    ],
  );

  const handleCreationGuidePick = useCallback(
    (dimension: CreationGuideDimensionId, value: string, label: string) => {
      const tag =
        dimension === "theme"
          ? "【创作起点·题材】"
          : dimension === "medium"
            ? "【创作起点·媒介】"
            : "【创作起点·核心冲突】";
      const body = `${tag}我选了「${label}」（${value}）。请基于这一选择继续下一步追问（例如作品形态、受众或叙事结构），不要跳过关键决策。`;
      void send(body, label);
    },
    [send],
  );

  const launchNoticeKey = useMemo(() => {
    const notice = launchReadiness?.notice;
    if (!notice) return null;
    return `${notice.level}:${notice.title}:${launchReadiness?.video.mode}:${launchReadiness?.video.detail}:${launchReadiness?.image.ready}:${launchReadiness?.image.detail}:${launchReadiness?.textReady}`;
  }, [launchReadiness]);

  const launchNotice = useMemo(() => {
    const notice = launchReadiness?.notice;
    if (!notice || !launchNoticeKey) return null;
    if (suppressedLaunchNoticeKey === launchNoticeKey) return null;
    if (!idle && notice.level !== "critical" && currentProject?.projectKind !== "video") {
      return null;
    }
    return notice;
  }, [currentProject?.projectKind, idle, launchNoticeKey, launchReadiness?.notice, suppressedLaunchNoticeKey]);

  const videoTransportHint = useMemo(() => {
    const snapshot = deferredProjectSnapshot ?? currentProject;
    if (snapshot?.projectKind !== "video") return null;

    if (launchReadiness?.video) {
      return launchReadiness.video;
    }

    return {
      label: "褰撳墠瀹為檯璧?API",
      detail: "Seedance API",
      tone: "neutral" as const,
    };
  }, [currentProject, deferredProjectSnapshot, launchReadiness?.video]);

  useHomeAgentBootstrapEffects({
    runtime,
    mode,
    metaReady,
    messages,
    compactedMessageCount,
    desktopSidebarCollapsed,
    maintenanceHintTimerRef,
    draftPersistTimerRef,
    messagesRef,
    compactedMessageCountRef,
    surfacedTaskIdsRef,
    surfacedTaskFollowupIdsRef,
    setRuntime,
    setRecentProjectsReady,
    setMetaReady,
    setActiveProjectId,
    activeProjectId,
    setTasks,
    loadProjectStore,
    flashMaintenanceHint,
    scheduleBackgroundTask,
    areProjectSnapshotsEquivalent,
    areRecentSessionsEquivalent,
    areTaskListsEquivalent,
    writeDesktopSidebarCollapsed,
    surfacedProjectSuggestionKeysRef,
    restoredProjectSuggestionKeysRef,
  });

  useHomeAgentConversationEffects({
    idle,
    streaming,
    messages,
    runtime,
    compactedMessageCount,
    activeProjectId,
    creationMode,
    automationMode,
    devMode,
    mode,
    setMode,
    qState,
    deferredQuestionState,
    pendingWorkflowUploadKind,
    question,
    popoverOverride,
    interruptedChoiceQuestion,
    suggested,
    suppressVideoWorkflowSuggestions:
      awaitingVideoKickoffStyleReferenceUpload || awaitingCharacterAudioReferenceUpload,
    draftPresence,
    persistedDraft,
    deferredDraft,
    recentSessionSummary,
    fullAutoChecklistCollapsed,
    selectedValues,
    deferredSelectedValues,
    selectedTextModelKey,
    selectedImageModelFamily,
    imageGenerationPrefs,
    selectedVideoModelKey,
    videoGenerationPrefs,
    deferredMessages,
    deferredProjectSnapshot,
    visibleTasks,
    engineRef,
    runtimeRef,
    projectHydrationInFlightRef,
    draftRef,
    previousQuestionStepRef,
    surfacedTaskIdsRef,
    surfacedTaskFollowupIdsRef,
    restoredTaskFollowupSuppressionRef,
    backgroundResearchGroupsRef,
    surfacedProjectSuggestionKeysRef,
    restoredProjectSuggestionKeysRef,
    dismissedProjectSuggestionKeysRef,
    compactionJobVersionRef,
    setRuntime,
    setActiveProjectId,
    setCompactedMessageCount,
    setStreaming,
    setSuggested,
    setPopoverOverride,
    setSelectedValues,
    resetComposerDraft,
    send,
    push,
    flashMaintenanceHint,
    loadApiConfigModule,
    loadSemanticSummaryModule,
    loadProjectStore,
    loadWorkflowActionsModule,
    scheduleBackgroundTask,
    mergeRecentProjects,
    buildTaskResultMessage,
    buildProjectSuggestionKey,
    parseTaskHeading,
  });

  useEffect(() => {
    const deferredQuestionStepKey = deferredQuestionState
      ? `${deferredQuestionState.request.id}:${deferredQuestionState.currentIndex}`
      : null;
    if (
      streaming ||
      qState ||
      pendingWorkflowUploadKind ||
      popoverOverride ||
      !deferredQuestionState ||
      dismissedDeferredQuestionStepRef.current === deferredQuestionStepKey
    ) {
      return;
    }

    setQState({
      ...deferredQuestionState,
      source: "deferred",
    });
    setSelectedValues(deferredSelectedValues);
    resetComposerDraft(deferredDraft);
    setDeferredQuestionState(null);
    setDeferredSelectedValues([]);
    setDeferredDraft("");
    setPendingDeferredQuestionRestoreAfterAssistantReply(null);
  }, [
    deferredDraft,
    deferredQuestionState,
    deferredSelectedValues,
    pendingWorkflowUploadKind,
    popoverOverride,
    qState,
    resetComposerDraft,
    setQState,
    setSelectedValues,
    streaming,
  ]);

  // 娴佸紡鍝嶅簲缁撴潫鍚庤嚜鍔ㄤ繚瀛樹細璇濓紝纭繚鍙傝€冩敼缂?瑙嗛宸ヤ綔娴佺瓑 LLM 椹卞姩鍏ュ彛鐨勫璇濊褰曚笉涓㈠け
  const prevStreamingRef = useRef(streaming);
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = streaming;
    const deferredQuestionStepKey = deferredQuestionState
      ? `${deferredQuestionState.request.id}:${deferredQuestionState.currentIndex}`
      : null;
    if (
      wasStreaming &&
      !streaming &&
      !qState &&
      !pendingWorkflowUploadKind &&
      !popoverOverride &&
      deferredQuestionState &&
      dismissedDeferredQuestionStepRef.current === deferredQuestionStepKey
    ) {
      // A deferred structured question was intentionally hidden while the freeform
      // detour streamed. Once streaming settles, bring that same question back.
      dismissedDeferredQuestionStepRef.current = null;
      setQState({
        ...deferredQuestionState,
        source: "deferred",
      });
      setSelectedValues(deferredSelectedValues);
      resetComposerDraft(deferredDraft);
      setDeferredQuestionState(null);
      setDeferredSelectedValues([]);
      setDeferredDraft("");
      setPendingDeferredQuestionRestoreAfterAssistantReply(null);
    }
    const currentProjectId = runtime.currentProjectSnapshot?.projectId ?? activeProjectId;
    if (wasStreaming && !streaming && (currentProjectId || messagesRef.current.length > 0)) {
      flushSessionRef.current();
    }
  }, [
    activeProjectId,
    deferredDraft,
    deferredQuestionState,
    deferredSelectedValues,
    pendingWorkflowUploadKind,
    popoverOverride,
    qState,
    resetComposerDraft,
    runtime.currentProjectSnapshot?.projectId,
    setQState,
    setSelectedValues,
    streaming,
  ]);

  useEffect(() => {
    if (streaming) return;
    const currentSnapshot = runtime.currentProjectSnapshot;
    if (!currentSnapshot?.projectId) return;
    if (staleProjectIdsRef.current.has(currentSnapshot.projectId)) return;
    if (hasSessionResetMarkerForProject(currentSnapshot.projectId)) return;

    startTransition(() => {
      setRuntime((prev) => {
        const nextSnapshot = prev.currentProjectSnapshot;
        if (!nextSnapshot?.projectId) return prev;
        if (staleProjectIdsRef.current.has(nextSnapshot.projectId)) return prev;
        if (hasSessionResetMarkerForProject(nextSnapshot.projectId)) return prev;
        const nextRecentProjects = replacePlaceholderRecentProject({
          recentProjects: prev.recentProjects,
          previousSnapshot: null,
          nextSnapshot,
          pruneStaleFullAutoPlaceholders: false,
        });
        if (nextRecentProjects === prev.recentProjects) return prev;
        return {
          ...prev,
          recentProjects: nextRecentProjects,
        };
      });
    });
  }, [runtime.currentProjectSnapshot, runtime.recentProjects, setRuntime, streaming]);

  useEffect(() => {
    if (idle) return;
    const currentSnapshot = runtime.currentProjectSnapshot;
    // 当视频项目接管剧本项目时，使用剧本项目 ID 作为会话 projectId，保持单一会话壳
    const isVideoTakingOverScript =
      currentSnapshot?.projectKind === "video" &&
      currentSnapshot.sourceProjectId?.trim() &&
      currentSnapshot.sourceProjectId.trim() === activeProjectId;
    const projectId = isVideoTakingOverScript
      ? activeProjectId
      : (activeProjectId ?? currentSnapshot?.projectId);
    if (!projectId || !currentSnapshot) return;
    if (!isVideoTakingOverScript && currentSnapshot.projectId !== projectId) return;
    if (staleProjectIdsRef.current.has(projectId)) return;

    const sessionPreview: StudioSessionState = {
      sessionId: runtime.sessionId,
      mode,
      creationMode,
      automationMode: normalizeAutomationMode(currentSnapshot.automationMode ?? automationMode),
      devMode,
      messages: [],
      currentProjectSnapshot: {
        ...currentSnapshot,
        automationMode: normalizeAutomationMode(currentSnapshot.automationMode ?? automationMode),
      },
      recentMessageSummary: runtime.recentMessageSummary,
      projectId,
      compactedMessageCount,
      fullAutoRun: runtime.fullAutoRun ?? null,
      fullAutoChecklistCollapsed,
    };

    startTransition(() => {
      setRuntime((prev) => {
        const nextSessions = upsertRecentProjectSession(prev.recentProjectSessions, sessionPreview);
        return areRecentSessionsEquivalent(nextSessions, prev.recentProjectSessions)
          ? prev
          : {
              ...prev,
              recentProjectSessions: nextSessions,
            };
      });
    });
  }, [
    activeProjectId,
    automationMode,
    compactedMessageCount,
    creationMode,
    devMode,
    idle,
    mode,
    runtime.currentProjectSnapshot,
    runtime.fullAutoRun,
    fullAutoChecklistCollapsed,
    runtime.recentMessageSummary,
    runtime.sessionId,
    setRuntime,
  ]);

  useEffect(() => {
    if (
      streaming ||
      qState ||
      deferredQuestionState ||
      pendingWorkflowUploadKind ||
      popoverOverride ||
      !pendingWorkflowPopoverAfterAssistantReply
    ) {
      return;
    }

    const currentProjectId = runtime.currentProjectSnapshot?.projectId ?? activeProjectId ?? null;
    if (
      pendingWorkflowPopoverAfterAssistantReply.projectId &&
      currentProjectId &&
      pendingWorkflowPopoverAfterAssistantReply.projectId !== currentProjectId
    ) {
      setPendingWorkflowPopoverAfterAssistantReply(null);
      return;
    }

    const latestCompletedAssistantMessage =
      [...messages]
        .reverse()
        .find((message) => message.role === "assistant" && message.status === "complete") ?? null;
    if (
      !latestCompletedAssistantMessage ||
      latestCompletedAssistantMessage.id ===
        pendingWorkflowPopoverAfterAssistantReply.lastAssistantMessageId
    ) {
      return;
    }

    if (openWorkflowPopoverQuestion(pendingWorkflowPopoverAfterAssistantReply.question)) {
      setPendingWorkflowPopoverAfterAssistantReply(null);
    }
  }, [
    activeProjectId,
    deferredQuestionState,
    messages,
    openWorkflowPopoverQuestion,
    pendingWorkflowUploadKind,
    pendingWorkflowPopoverAfterAssistantReply,
    popoverOverride,
    qState,
    runtime.currentProjectSnapshot?.projectId,
    streaming,
  ]);

  useEffect(() => {
    if (
      streaming ||
      qState ||
      pendingWorkflowUploadKind ||
      popoverOverride ||
      !deferredQuestionState ||
      !pendingDeferredQuestionRestoreAfterAssistantReply
    ) {
      return;
    }

    const currentProjectId = runtime.currentProjectSnapshot?.projectId ?? activeProjectId ?? null;
    if (
      pendingDeferredQuestionRestoreAfterAssistantReply.projectId &&
      currentProjectId &&
      pendingDeferredQuestionRestoreAfterAssistantReply.projectId !== currentProjectId
    ) {
      setPendingDeferredQuestionRestoreAfterAssistantReply(null);
      return;
    }

    const deferredQuestionStepKey = `${deferredQuestionState.request.id}:${deferredQuestionState.currentIndex}`;
    if (
      pendingDeferredQuestionRestoreAfterAssistantReply.stepKey !==
      deferredQuestionStepKey
    ) {
      setPendingDeferredQuestionRestoreAfterAssistantReply(null);
      return;
    }

    const latestCompletedAssistantMessage =
      [...messages]
        .reverse()
        .find((message) => message.role === "assistant" && message.status === "complete") ?? null;
    if (
      !latestCompletedAssistantMessage ||
      latestCompletedAssistantMessage.id ===
        pendingDeferredQuestionRestoreAfterAssistantReply.lastAssistantMessageId
    ) {
      return;
    }

    dismissedDeferredQuestionStepRef.current = null;
    setQState({
      ...deferredQuestionState,
      source: "deferred",
    });
    setSelectedValues(deferredSelectedValues);
    resetComposerDraft(deferredDraft);
    setDeferredQuestionState(null);
    setDeferredSelectedValues([]);
    setDeferredDraft("");
    setPendingDeferredQuestionRestoreAfterAssistantReply(null);
  }, [
    activeProjectId,
    deferredDraft,
    deferredQuestionState,
    deferredSelectedValues,
    messages,
    pendingDeferredQuestionRestoreAfterAssistantReply,
    pendingWorkflowUploadKind,
    popoverOverride,
    qState,
    resetComposerDraft,
    runtime.currentProjectSnapshot?.projectId,
    setQState,
    setSelectedValues,
    streaming,
  ]);

  // 姣忔娓叉煋鏃舵洿鏂?flush 鍑芥暟锛岀‘淇濆垏鎹㈤」鐩墠鑳戒繚瀛樻渶鏂扮姸鎬?
  flushSessionRef.current = () => {
    const snapshot = runtimeRef.current.currentProjectSnapshot;
    // 当视频项目接管剧本项目时（sourceProjectId === activeProjectId），
    // 保持使用剧本项目 ID 作为保存键，确保消息历史不会分裂到两个会话
    const isVideoTakingOverScript =
      snapshot?.projectKind === "video" &&
      snapshot.sourceProjectId?.trim() &&
      snapshot.sourceProjectId.trim() === activeProjectId;
    const currentProjectId =
      (isVideoTakingOverScript ? activeProjectId : snapshot?.projectId) ??
      activeProjectId ??
      // 无项目的自由对话：用 sessionId 作为临时 projectId，确保切换时不丢失历史
      (messagesRef.current.length > 0 ? runtimeRef.current.sessionId : undefined);
    if (!currentProjectId) return;
    writeStudioSession({
      sessionId: runtimeRef.current.sessionId,
      mode,
      creationMode,
      automationMode: normalizeAutomationMode(runtime.currentProjectSnapshot?.automationMode ?? automationMode),
      devMode,
      messages: messagesRef.current,
      currentProjectSnapshot: runtime.currentProjectSnapshot
        ? {
            ...runtime.currentProjectSnapshot,
            automationMode: normalizeAutomationMode(runtime.currentProjectSnapshot.automationMode ?? automationMode),
          }
        : null,
      recentMessageSummary: runtime.recentMessageSummary,
      projectId: currentProjectId,
      selectedTextModelKey,
      selectedImageModelFamily,
      imageGenerationPrefs,
      selectedVideoModelKey,
      videoGenerationPrefs,
      compactedMessageCount,
      draft: resolveComposerDraftSnapshot(draftRef.current, persistedDraft),
      qState,
      deferredQuestionState,
      pendingWorkflowUploadKind,
      pendingChoiceQuestion: persistedVisibleChoiceQuestion,
      interruptedChoiceQuestion: pendingWorkflowUploadKind ? null : interruptedChoiceQuestion,
      selectedValues,
      deferredSelectedValues,
      deferredDraft,
      surfacedTaskIds: [...surfacedTaskIdsRef.current],
      surfacedTaskFollowupKeys: [...surfacedTaskFollowupIdsRef.current],
      surfacedProjectSuggestionKeys: [...surfacedProjectSuggestionKeysRef.current],
      fullAutoRun: runtime.fullAutoRun ?? null,
      fullAutoChecklistCollapsed,
    }, { persistFullBackup: false });
    // 鍚屾椂鎸佷箙鍖栧綋鍓嶅墽鏈」鐩紝闃叉鍒囨崲/鏂板缓鏃堕」鐩涪澶?
    const dramaProject = runtimeRef.current.currentDramaProject;
    if (dramaProject) {
      void import("@/lib/home-agent/project-store").then(({ upsertStoredDramaProject }) => {
        upsertStoredDramaProject(dramaProject);
      });
    }
  };

  const stopRunningTasks = useCallback(() => {
    const runningTasks = getAllTasks().filter((task) => task.status === "running");
    for (const task of runningTasks) {
      stopTask(task.id);
    }
    if (runningTasks.length) {
      const nextTasks = getAllTasks();
      setTasks((prev) => (areTaskListsEquivalent(nextTasks, prev) ? prev : nextTasks));
    }
    return runningTasks.length;
  }, [areTaskListsEquivalent, setTasks]);

  const interruptWorkflowShortcutRef = useRef<() => void>(() => {});

  const interruptCurrentSurfaceForIsolation = useCallback(
    (options?: {
      nextProjectId?: string | null;
      persistRetryQuestion?: boolean;
    }) => {
      const nextProjectId = options?.nextProjectId?.trim() || null;
      const activeSnapshot = runtimeRef.current.currentProjectSnapshot;
      const retryQuestion =
        activeWorkflowAction
          ? resolveInterruptedWorkflowQuestion({
              explicitRestoreQuestion: interruptRestoreQuestionRef.current,
              activeWorkflowAction,
              snapshot: activeSnapshot,
              videoProject: runtimeRef.current.currentVideoProject,
            })
          : null;

      interruptRestoreQuestionRef.current = null;
      setInterruptedChoiceQuestion(null);
      stopActiveExecution();
      interruptWorkflowShortcutRef.current();
      stopRunningTasks();

      if (!options?.persistRetryQuestion || !retryQuestion) return;

      const currentSurfaceProjectId =
        activeProjectId ??
        (messagesRef.current.length > 0 ? runtimeRef.current.sessionId : null);
      if (!currentSurfaceProjectId) return;
      if (nextProjectId && activeProjectId && activeProjectId === nextProjectId) return;

      void writeProjectStudioSession({
        sessionId: runtimeRef.current.sessionId,
        mode,
        creationMode,
        automationMode: normalizeAutomationMode(activeSnapshot?.automationMode ?? automationMode),
        devMode,
        messages: messagesRef.current,
        currentProjectSnapshot: activeSnapshot
          ? {
              ...activeSnapshot,
              automationMode: normalizeAutomationMode(activeSnapshot.automationMode ?? automationMode),
            }
          : null,
        recentMessageSummary: runtimeRef.current.recentMessageSummary,
        projectId: currentSurfaceProjectId,
        selectedTextModelKey,
        selectedImageModelFamily,
        imageGenerationPrefs,
        selectedVideoModelKey,
        videoGenerationPrefs,
        compactedMessageCount: compactedMessageCountRef.current,
        draft: resolveComposerDraftSnapshot(draftRef.current, persistedDraft),
        qState: null,
        deferredQuestionState: null,
        pendingChoiceQuestion: retryQuestion,
        interruptedChoiceQuestion: null,
        selectedValues: [],
        deferredSelectedValues: [],
        deferredDraft: "",
        surfacedTaskIds: [...surfacedTaskIdsRef.current],
        surfacedTaskFollowupKeys: [...surfacedTaskFollowupIdsRef.current],
        surfacedProjectSuggestionKeys: [],
        fullAutoRun: runtimeRef.current.fullAutoRun ?? null,
        fullAutoChecklistCollapsed,
      });
    },
    [
      activeProjectId,
      activeWorkflowAction,
      automationMode,
      creationMode,
      devMode,
      fullAutoChecklistCollapsed,
      imageGenerationPrefs,
      mode,
      persistedDraft,
      qState,
      selectedImageModelFamily,
      selectedTextModelKey,
      selectedVideoModelKey,
      stopActiveExecution,
      stopRunningTasks,
      videoGenerationPrefs,
    ],
  );

  const handleProjectSwitchInterrupt = useCallback(
    (nextProjectId: string) => {
      interruptCurrentSurfaceForIsolation({
        nextProjectId,
        persistRetryQuestion: true,
      });
    },
    [interruptCurrentSurfaceForIsolation],
  );

  const handleBeforeProjectOpen = useCallback(
    (projectId: string) => {
      // "New project" temporarily marks the previously active project as stale so its
      // background deltas cannot bleed into the idle home surface. Once the user
      // intentionally re-opens that history item, it is no longer stale.
      staleProjectIdsRef.current.delete(projectId);
      handleProjectSwitchInterrupt(projectId);
    },
    [handleProjectSwitchInterrupt],
  );

  const { openProject, cancelPendingProjectOpen } = useHomeAgentRecoveryFlow({
    handoffRef,
    engineRef,
    runtimeRef,
    projectHydrationInFlightRef,
    loadProjectStore,
    flushSessionRef,
    beforeProjectOpen: handleBeforeProjectOpen,
    setCreationMode,
    setAutomationMode,
    setDevMode,
    setActiveProjectId,
    setSelectedTextModelKey,
    setSelectedImageModelFamily,
    setImageGenerationPrefs,
    setSelectedVideoModelKey,
    setVideoGenerationPrefs,
    setQState,
    setDeferredQuestionState,
    setPendingWorkflowUploadKind,
    setPopoverOverride,
    setInterruptedChoiceQuestion,
    setSuggested,
    setSelectedValues,
    setDeferredSelectedValues,
    setFullAutoChecklistCollapsed,
    setStreaming,
    setMode,
    setMessages,
    setCompactedMessageCount,
    setRuntime,
    setMetaReady,
    resetComposerDraft,
    getComposerDraftSnapshot: () => resolveComposerDraftSnapshot(draftRef.current, persistedDraft),
    setDeferredDraft,
    previousQuestionStepRef,
    clearSurfacedTasks: () => {
      surfacedTaskIdsRef.current.clear();
      surfacedTaskFollowupIdsRef.current.clear();
      surfacedProjectSuggestionKeysRef.current.clear();
      restoredProjectSuggestionKeysRef.current.clear();
    },
    surfacedTaskIdsRef,
    surfacedTaskFollowupIdsRef,
    restoredTaskFollowupSuppressionRef,
    surfacedProjectSuggestionKeysRef,
    restoredProjectSuggestionKeysRef,
    send,
    createQuestionState,
    mk,
    mergeRecentProjects,
  });

  const strongReset = useCallback(
    (nextMode?: AutomationMode) => {
      cancelPendingProjectOpen();
      flushSessionRef.current();
      interruptCurrentSurfaceForIsolation({ persistRetryQuestion: true });
      runtimeReset();
      if (nextMode) {
        setAutomationMode(nextMode);
      }
    },
    [
      cancelPendingProjectOpen,
      interruptCurrentSurfaceForIsolation,
      runtimeReset,
      setAutomationMode,
    ],
  );

  const {
    handleOpenProject,
    handleReset,
    handleOpenSettings,
    handleToggleSettings,
    handleOpenMobileNavigation,
    handleStopTask,
    handleToggleDesktopSidebar,
    handleSettingsOpenChange,
    handleCloseSettings,
  } = useHomeAgentShellHandlers({
    openProject,
    reset: strongReset,
    utilityPanel,
    setMobileNavOpen,
    setTasks,
    setDesktopSidebarCollapsed,
    onUtilityChange,
    areTaskListsEquivalent,
  });

  const { suppressAutoRestore } = useHomeAgentLastSessionRecovery({
    hasSeedSession: Boolean(seedRef.current?.session),
    openProject,
  });

  const handleRefreshProjects = useCallback(async () => {
    setIsRefreshingProjects(true);
    try {
      const store = await loadProjectStore();
      const { pruneHistoryIfNeeded } = await import("@/lib/home-agent/project-store");
      await pruneHistoryIfNeeded();
      const items = filterRecentlyDeletedProjectSnapshots(
        await store.listRecentConversationSnapshots(HOME_RECENT_PROJECTS_LIMIT, { fast: true }),
      );
      const projectIdSet = new Set(items.map((snapshot) => snapshot.projectId));
      const storedProjectSessions = listStudioProjectSessions().filter((session) => {
        const sessionProjectId = resolveSessionProjectIdForSnapshot({
          currentSessionProjectId: session.projectId,
          snapshot: session.currentProjectSnapshot,
          fallbackProjectId: session.projectId,
        });
        return Boolean(
          (sessionProjectId && projectIdSet.has(sessionProjectId)) ||
            (session.currentProjectSnapshot?.projectId &&
              projectIdSet.has(session.currentProjectSnapshot.projectId)),
        );
      });
      React.startTransition(() => {
        setRuntime((prev) => ({
          ...prev,
          recentProjects: reconcileRecentProjectsWithStableOrder(prev.recentProjects, items),
          recentProjectSessions: storedProjectSessions.length
            ? storedProjectSessions
            : (prev.recentProjectSessions ?? []).filter(
                (session) => session.projectId && projectIdSet.has(session.projectId),
              ),
        }));
        setRecentProjectsReady(true);
      });
    } catch {
      // 闈欓粯澶辫触
    } finally {
      setIsRefreshingProjects(false);
    }
  }, [filterRecentlyDeletedProjectSnapshots, loadProjectStore, setRuntime]);

  useEffect(() => {
    const targetMode = pendingHomepageIsolationModeRef.current;
    if (!targetMode || !recentProjectsReady) return;

    const currentSnapshot = runtimeRef.current.currentProjectSnapshot;
    const nextProject = selectRecentProjectForAutomationMode({
      recentProjects: runtimeRef.current.recentProjects,
      recentProjectSessions: runtimeRef.current.recentProjectSessions,
      currentProjectSnapshot: runtimeRef.current.currentProjectSnapshot,
      currentSessionProjectId: activeProjectId,
      mode: targetMode,
      preferredProjectId: rememberedProjectIdsByModeRef.current[targetMode],
    });
    pendingHomepageIsolationModeRef.current = null;

    if (nextProject?.projectId) {
      rememberedProjectIdsByModeRef.current = rememberProjectForAutomationMode(
        rememberedProjectIdsByModeRef.current,
        nextProject,
      );
    }
    const isolationAction = resolveModeIsolationAction({
      currentSnapshot,
      targetMode,
      nextProjectId: nextProject?.projectId,
      activeProjectId,
      hasMessages: messagesRef.current.length > 0,
      hasDraft: Boolean(draftRef.current.trim()),
      mode,
    });

    if (isolationAction.type === "open-project" && isolationAction.projectId) {
      void openProject(isolationAction.projectId);
      return;
    }
    if (isolationAction.type === "reset-home") {
      strongReset(targetMode);
      return;
    }
    setAutomationMode(targetMode);
  }, [
    activeProjectId,
    homepageIsolationRequestEpoch,
    mode,
    openProject,
    recentProjectsReady,
    runtime.recentProjects,
    setAutomationMode,
    strongReset,
  ]);

  useEffect(() => {
    const currentSnapshot = runtime.currentProjectSnapshot;
    if (!currentSnapshot?.projectId) return;
    if (!projectMatchesAutomationMode(currentSnapshot, historyAutomationMode)) return;

    const refreshKey = `${historyAutomationMode}:${currentSnapshot.projectId}`;
    if (lastIsolationHistoryRefreshKeyRef.current === refreshKey) return;
    lastIsolationHistoryRefreshKeyRef.current = refreshKey;

    let cancelled = false;
    void loadProjectStore()
      .then((store) => store.listRecentConversationSnapshots(HOME_RECENT_PROJECTS_LIMIT, { fast: true }))
      .then((items) => {
        if (cancelled) return;
        const filteredItems = filterRecentlyDeletedProjectSnapshots(items);
        React.startTransition(() => {
          setRuntime((prev) => {
            const shouldPreserveRicherList =
              filteredItems.length > 0 &&
              prev.recentProjects.length > filteredItems.length &&
              filteredItems.every((item) => prev.recentProjects.some((project) => project.projectId === item.projectId));
            const nextRecentProjects = reconcileRecentProjectsWithStableOrder(
              prev.recentProjects,
              filteredItems,
            );
            if (shouldPreserveRicherList || areProjectSnapshotsEquivalent(nextRecentProjects, prev.recentProjects)) {
              return prev;
            }
            return { ...prev, recentProjects: nextRecentProjects };
          });
        });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [filterRecentlyDeletedProjectSnapshots, historyAutomationMode, loadProjectStore, runtime.currentProjectSnapshot, setRuntime]);

  const buildCurrentProjectSessionForExport = useCallback(
    (snapshot: ConversationProjectSnapshot): StudioSessionState | null => {
      if (activeProjectId !== snapshot.projectId) return null;
      if (!messages.length) return null;
      return {
        sessionId: runtimeRef.current.sessionId,
        mode,
        creationMode,
        devMode,
        messages,
        currentProjectSnapshot: runtime.currentProjectSnapshot ?? snapshot,
        recentMessageSummary: runtime.recentMessageSummary,
        projectId: activeProjectId,
        selectedTextModelKey,
        selectedImageModelFamily,
        imageGenerationPrefs,
        selectedVideoModelKey,
        videoGenerationPrefs,
        compactedMessageCount,
        draft: resolveComposerDraftSnapshot(draftRef.current, persistedDraft),
        qState,
        deferredQuestionState,
        pendingWorkflowUploadKind,
        pendingChoiceQuestion: persistedVisibleChoiceQuestion,
        interruptedChoiceQuestion: pendingWorkflowUploadKind ? null : interruptedChoiceQuestion,
        selectedValues,
        deferredSelectedValues,
      deferredDraft,
      surfacedTaskIds: [...surfacedTaskIdsRef.current],
      surfacedTaskFollowupKeys: [...surfacedTaskFollowupIdsRef.current],
      surfacedProjectSuggestionKeys: [...surfacedProjectSuggestionKeysRef.current],
      fullAutoChecklistCollapsed,
    };
  },
    [
      activeProjectId,
      creationMode,
      devMode,
      compactedMessageCount,
      deferredDraft,
      deferredQuestionState,
      deferredSelectedValues,
      imageGenerationPrefs,
      interruptedChoiceQuestion,
      pendingWorkflowUploadKind,
      messages,
      mode,
      persistedDraft,
      persistedVisibleChoiceQuestion,
      qState,
      runtime,
      selectedImageModelFamily,
      selectedTextModelKey,
      selectedValues,
      selectedVideoModelKey,
      videoGenerationPrefs,
      fullAutoChecklistCollapsed,
    ],
  );

  const handleExportChatHistory = useCallback(
    async (snapshot: ConversationProjectSnapshot) => {
      if (activeProjectId === snapshot.projectId) {
        flushSessionRef.current();
      }
      const sessionForExport =
        buildCurrentProjectSessionForExport(snapshot) ??
        (await readProjectSessionFromFile(snapshot.projectId)) ??
        readStudioProjectSession(snapshot.projectId);
      if (!sessionForExport?.messages?.length) {
        flashMaintenanceHint("没有可导出的聊天记录。", 2200);
        return;
      }

      flashMaintenanceHint("正在导出聊天记录...", 60000);
      const dramaProject = activeProjectId === snapshot.projectId
        ? (runtimeRef.current.currentDramaProject ?? undefined)
        : (await import("@/lib/home-agent/project-store")).loadStoredDramaProjectById(snapshot.projectId) ?? undefined;
      const result = await exportChatHistory(sessionForExport, snapshot.title, { exportVersion: 2, isFullVersion: true, dramaProject });
      if (!result.ok) {
        if (result.reason !== "cancelled") {
          flashMaintenanceHint(result.message, 3200);
        } else {
          flashMaintenanceHint("", 0);
        }
        return;
      }

      recordLastExportedChatHistory(snapshot.projectId, {
        destDir: result.destDir,
        chatHistoryFilePath: result.chatHistoryFilePath,
      });
      flashMaintenanceHint(`宸插鍑鸿亰澶╄褰曪細${result.destDir}`, 3200);
    },
    [activeProjectId, buildCurrentProjectSessionForExport, flashMaintenanceHint],
  );

  const handleImportChatHistory = useCallback(
    async (snapshot: ConversationProjectSnapshot) => {
      const storage = window.electronAPI?.storage;
      if (!storage) {
        flashMaintenanceHint("当前环境不支持导入聊天记录。", 3200);
        return;
      }
      const filePath = await storage.selectFile({ filters: [{ name: "聊天记录", extensions: ["json"] }] });
      if (!filePath) return;

      const preview = await parseChatHistoryPreview(filePath);
      if (!preview) {
        flashMaintenanceHint("文件格式无效，无法预览。", 3200);
        return;
      }
      setImportPreviewState({ filePath, preview, snapshot });
    },
    [flashMaintenanceHint],
  );

  const handleImportPreviewConfirm = useCallback(
    async (mode: "overwrite" | "new-project") => {
      if (!importPreviewState) return;
      const { filePath, snapshot } = importPreviewState;
      setImportPreviewState(null);

      if (mode === "new-project") {
        const imported = await importChatHistoryAsNewProject(filePath);
        if (!imported.ok) {
          if (imported.reason !== "cancelled") flashMaintenanceHint(imported.message, 3200);
          return;
        }
        const { newProjectId, session } = imported;
        const title = session.currentProjectSnapshot?.title || "导入的对话记录";
        const { upsertStoredDramaProject } = await import("@/lib/home-agent/project-store");
        if (imported.dramaProject) {
          upsertStoredDramaProject({ ...imported.dramaProject, id: newProjectId, dramaTitle: title });
        } else {
          const { createEmptyDramaProject } = await import("@/types/drama");
          const placeholder = createEmptyDramaProject("traditional");
          upsertStoredDramaProject({ ...placeholder, id: newProjectId, dramaTitle: title });
        }
        const { writeStudioSession: writeSession } = await import("@/lib/home-agent/session-store");
        writeSession({
          ...session,
          automationMode: normalizeAutomationMode(session.automationMode ?? session.currentProjectSnapshot?.automationMode),
          projectId: newProjectId,
          currentProjectSnapshot: session.currentProjectSnapshot
            ? {
                ...session.currentProjectSnapshot,
                projectId: newProjectId,
                automationMode: normalizeAutomationMode(
                  session.currentProjectSnapshot.automationMode ?? session.automationMode,
                ),
              }
            : session.currentProjectSnapshot,
        });
        await handleRefreshProjects();
        void openProject(newProjectId);
        const mediaHint = imported.importedMediaDir ? "，媒体文件已导入素材库" : "";
        flashMaintenanceHint(`已导入对话记录《${title}》${mediaHint}。`, 3200);
        return;
      }

      // overwrite mode
      const imported = await importChatHistory(snapshot.projectId, filePath);
      if (!imported.ok) {
        if (imported.reason !== "cancelled") flashMaintenanceHint(imported.message, 3200);
        return;
      }

      if (activeProjectId === snapshot.projectId) {
        // 鍏堟竻鎺?runtimeRef 閲岀殑鏃?DramaProject锛岄槻姝?flush 鎶婃棫鏁版嵁鍐欏洖 localStorage
        if (imported.dramaProject) {
          runtimeRef.current = { ...runtimeRef.current, currentDramaProject: null };
        }
        flushSessionRef.current();
      }

      const importedSnapshot = imported.session.currentProjectSnapshot;
      const updatedSnapshot: ConversationProjectSnapshot = importedSnapshot
        ? {
            ...importedSnapshot,
            projectId: snapshot.projectId,
            automationMode: normalizeAutomationMode(importedSnapshot.automationMode ?? imported.session.automationMode),
          }
        : snapshot;

      const replacedSession: StudioSessionState = {
        ...imported.session,
        automationMode: normalizeAutomationMode(imported.session.automationMode ?? updatedSnapshot.automationMode),
        projectId: snapshot.projectId,
        currentProjectSnapshot: updatedSnapshot,
      };

      if (activeProjectId === snapshot.projectId) {
        writeStudioSession(replacedSession);
      } else {
        await writeProjectStudioSession(replacedSession);
      }

      if (imported.dramaProject) {
        const { upsertStoredDramaProject } = await import("@/lib/home-agent/project-store");
        const restoredDramaProject = { ...imported.dramaProject, id: snapshot.projectId };
        upsertStoredDramaProject(restoredDramaProject);
        // 鍚屾鏇存柊 runtimeRef锛岄槻姝㈠悗缁?flush 鎶婃棫鏁版嵁鍐欏洖 localStorage
        if (activeProjectId === snapshot.projectId) {
          runtimeRef.current = { ...runtimeRef.current, currentDramaProject: restoredDramaProject };
        }
      }

      const importedTitle = importedSnapshot?.title;
      if (importedTitle && importedTitle !== snapshot.title) {
        const store = await loadProjectStore();
        await store.renameConversationProject(snapshot.projectId, importedTitle);
      }

      if (activeProjectId === snapshot.projectId) {
        messagesRef.current = replacedSession.messages;
        compactedMessageCountRef.current = replacedSession.compactedMessageCount ?? 0;
        runtimeRef.current = {
          ...runtimeRef.current,
          currentProjectSnapshot: updatedSnapshot,
          ...(imported.dramaProject ? { currentDramaProject: { ...imported.dramaProject, id: snapshot.projectId } } : {}),
          recentProjectSessions: upsertRecentProjectSession(
            runtimeRef.current.recentProjectSessions,
            replacedSession,
          ),
        };
        startTransition(() => {
          const replacedPendingWorkflowUploadKind = resolvePendingWorkflowUploadKind(replacedSession);
          setFullAutoChecklistCollapsed(replacedSession.fullAutoChecklistCollapsed ?? true);
          setMessages(replacedSession.messages);
          setMode(replacedSession.mode === "recovering" || replacedSession.mode === "maintenance-review" ? replacedSession.mode : "active");
          setQState(replacedSession.qState ?? null);
          setDeferredQuestionState(replacedSession.deferredQuestionState ?? null);
          setPendingWorkflowUploadKind(replacedPendingWorkflowUploadKind);
          setInterruptedChoiceQuestion(
            replacedPendingWorkflowUploadKind
              ? null
              : (replacedSession.interruptedChoiceQuestion ?? null),
          );
          setSelectedValues(replacedSession.selectedValues ?? []);
          setDeferredSelectedValues(replacedSession.deferredSelectedValues ?? []);
          setCompactedMessageCount(replacedSession.compactedMessageCount ?? 0);
          setRuntime((prev) => ({
            ...prev,
            currentProjectSnapshot: updatedSnapshot,
            ...(imported.dramaProject ? { currentDramaProject: { ...imported.dramaProject, id: snapshot.projectId } } : {}),
            recentProjects: prev.recentProjects.map((item) =>
              item.projectId === snapshot.projectId ? updatedSnapshot : item,
            ),
            recentProjectSessions: upsertRecentProjectSession(prev.recentProjectSessions, replacedSession),
          }));
        });
        setDeferredDraft(replacedSession.deferredDraft ?? "");
        resetComposerDraft(replacedSession.draft ?? "");
      } else {
        startTransition(() => {
          setRuntime((prev) => ({
            ...prev,
            recentProjects: prev.recentProjects.map((item) =>
              item.projectId === snapshot.projectId ? updatedSnapshot : item,
            ),
            recentProjectSessions: upsertRecentProjectSession(prev.recentProjectSessions, replacedSession),
          }));
        });
      }

      const mediaHint = imported.importedMediaDir ? "，媒体文件已回填" : "";
      flashMaintenanceHint(`已导入 ${replacedSession.messages.length} 条消息${mediaHint}，对话记录已完整替换。`, 3200);
    },
    [
      activeProjectId,
      flashMaintenanceHint,
      handleRefreshProjects,
      importPreviewState,
      loadProjectStore,
      openProject,
      resetComposerDraft,
      setDeferredDraft,
      setDeferredQuestionState,
      setDeferredSelectedValues,
      setMessages,
      setMode,
      setQState,
      setRuntime,
      setSelectedValues,
    ],
  );

  const handleOpenProjectFolder = useCallback(async (snapshot: ConversationProjectSnapshot) => {
    const result = await revealExportedChatHistoryFile(snapshot.projectId);
    if (!result.ok) {
      flashMaintenanceHint(result.message, 3200);
    }
  }, [flashMaintenanceHint]);

  const handleGlobalImportChatHistory = useCallback(async () => {
    const storage = window.electronAPI?.storage;
    if (!storage) {
      flashMaintenanceHint("当前环境不支持导入聊天记录。", 3200);
      return;
    }
    const filePath = await storage.selectFile({ filters: [{ name: "聊天记录", extensions: ["json"] }] });
    if (!filePath) return;

    const preview = await parseChatHistoryPreview(filePath);
    if (!preview) {
      flashMaintenanceHint("文件格式无效，无法预览。", 3200);
      return;
    }
    // 鍏ㄥ眬瀵煎叆娌℃湁鐩爣 snapshot锛岀敤绌哄崰浣?
    setImportPreviewState({ filePath, preview, snapshot: { projectId: "", title: preview.title } as ConversationProjectSnapshot });
  }, [flashMaintenanceHint]);

  const handleToggleProjectPin = useCallback(
    async (snapshot: ConversationProjectSnapshot) => {
      const nextPinned = !snapshot.pinned;
      try {
        const store = await loadProjectStore();
        await store.setConversationProjectPinned(snapshot.projectId, nextPinned);
      } catch (error) {
        flashMaintenanceHint(
          error instanceof Error ? error.message : "更新置顶状态失败，请稍后重试。",
          3200,
        );
        return;
      }

      startTransition(() => {
        setRuntime((prev) => {
          const nextProjects = sortConversationSnapshots(
            prev.recentProjects.map((item) =>
              item.projectId === snapshot.projectId ? { ...item, pinned: nextPinned } : item,
            ),
          );
          const nextCurrent =
            prev.currentProjectSnapshot?.projectId === snapshot.projectId
              ? { ...prev.currentProjectSnapshot, pinned: nextPinned }
              : prev.currentProjectSnapshot;
          return {
            ...prev,
            recentProjects: nextProjects,
            currentProjectSnapshot: nextCurrent,
          };
        });
      });
      flashMaintenanceHint(nextPinned ? "已置顶该会话。" : "已取消置顶。", 2000);
    },
    [flashMaintenanceHint, loadProjectStore],
  );

  const handleRenameProject = useCallback(
    (snapshot: ConversationProjectSnapshot) => {
      setRenameTarget({ projectId: snapshot.projectId, title: snapshot.title });
      setRenameDraft(snapshot.title);
    },
    [],
  );

  const handleRenameConfirm = useCallback(async () => {
    if (!renameTarget) return;
    const next = renameDraft.trim();
    if (!next || next === renameTarget.title) {
      setRenameTarget(null);
      return;
    }
    try {
      const store = await loadProjectStore();
      await store.renameConversationProject(renameTarget.projectId, next);
    } catch (error) {
      flashMaintenanceHint(
        error instanceof Error ? error.message : "重命名失败，请稍后重试。",
        3200,
      );
    } finally {
      setRenameTarget(null);
    }
  }, [renameTarget, renameDraft, loadProjectStore, flashMaintenanceHint]);

  const performDeleteProject = useCallback(
    async (snapshot: ConversationProjectSnapshot) => {
      const wasActive = activeProjectId === snapshot.projectId;
      let remainingProjectsFromStore: ConversationProjectSnapshot[] = [];

      if (wasActive) {
        cancelPendingProjectOpen();
        const requestId = qState?.request.id;
        if (requestId) {
          void loadAskUserQuestionModule().then((mod) => {
            mod.rejectAskUserQuestion(requestId, "User deleted conversation");
          });
        }
        engineRef.current?.interrupt?.();
        engineRef.current = null;
        surfacedTaskIdsRef.current.clear();
        surfacedTaskFollowupIdsRef.current.clear();
        surfacedProjectSuggestionKeysRef.current.clear();
        restoredProjectSuggestionKeysRef.current.clear();
        startTransition(() => {
          setActiveProjectId(undefined);
          setStreaming(false);
          setQState(null);
          setPopoverOverride(null);
          setSuggested(null);
          setSelectedValues([]);
        });
      }

      let deletedProjectIds = new Set<string>();
      try {
        const store = await loadProjectStore();
        const deleteResult = await store.deleteConversationProject(snapshot);
        deletedProjectIds = new Set(deleteResult.deletedProjectIds);
        remainingProjectsFromStore = filterRecentlyDeletedProjectSnapshots(
          await store.listRecentConversationSnapshots(HOME_RECENT_PROJECTS_LIMIT, { fast: true }),
        ).filter((project) => !deletedProjectIds.has(project.projectId));
      } catch (error) {
        flashMaintenanceHint(
          error instanceof Error ? error.message : "删除会话失败，请稍后重试。",
          3200,
        );
        return;
      }

      const remainingProjects = reconcileRecentProjectsWithStableOrder(
        runtimeRef.current.recentProjects,
        remainingProjectsFromStore,
      );
      const remainingProjectIds = new Set(remainingProjects.map((project) => project.projectId));

      setRuntime((prev) => {
        const nextRecentProjects = reconcileRecentProjectsWithStableOrder(
          prev.recentProjects,
          remainingProjectsFromStore,
        );
        const nextRemainingProjectIds = new Set(nextRecentProjects.map((project) => project.projectId));
        return {
          ...prev,
          recentProjects: nextRecentProjects,
          recentProjectSessions: (prev.recentProjectSessions ?? []).filter(
            (s) => Boolean(s.projectId && nextRemainingProjectIds.has(s.projectId)),
          ),
          ...(prev.currentProjectSnapshot?.projectId &&
          deletedProjectIds.has(prev.currentProjectSnapshot.projectId)
            ? {
                currentProjectSnapshot: null,
                currentDramaProject: null,
                currentVideoProject: null,
              }
            : {}),
        };
      });

      deletedProjectIds.forEach((projectId) => {
        staleProjectIdsRef.current.add(projectId);
      });

      runtimeRef.current = {
        ...runtimeRef.current,
        recentProjects: remainingProjects,
        recentProjectSessions: (runtimeRef.current.recentProjectSessions ?? []).filter(
          (session) => Boolean(session.projectId && remainingProjectIds.has(session.projectId)),
        ),
      };

      if (wasActive) {
        // 鍦ㄨ皟鐢?openProject 鍓嶆竻闄?runtimeRef 涓殑褰撳墠椤圭洰寮曠敤锛?
        // 闃叉 flushSessionRef 鍦ㄥ垏鎹㈡椂鎶婂凡鍒犻櫎鐨勯」鐩噸鏂板啓鍥?localStorage
        runtimeRef.current = {
          ...runtimeRef.current,
          currentDramaProject: null,
          currentVideoProject: null,
          currentProjectSnapshot: null,
        };
        // 缃┖ flushSessionRef锛岄槻姝?openProject 鍐呴儴鐨?flush 鎶婂凡鍒犻櫎鐨勪細璇濆啓鍥?localStorage
        flushSessionRef.current = () => {};
        const blockedAutoOpenProjectId =
          snapshot.projectKind === "video" && typeof snapshot.sourceProjectId === "string"
            ? snapshot.sourceProjectId.trim()
            : "";
        const next =
          selectRecentProjectForAutomationMode({
            recentProjects: remainingProjects.filter(
              (project) => project.projectId !== blockedAutoOpenProjectId,
            ),
            recentProjectSessions: (runtimeRef.current.recentProjectSessions ?? []).filter(
              (session) =>
                Boolean(session.projectId && remainingProjectIds.has(session.projectId)) &&
                session.projectId !== blockedAutoOpenProjectId,
            ),
            currentSessionProjectId: activeProjectId,
            mode: historyAutomationMode,
          }) ??
          remainingProjects.find((project) => project.projectId !== blockedAutoOpenProjectId) ??
          remainingProjects[0];
        if (next) {
          void openProject(next.projectId);
        } else {
          runtimeReset();
          setRuntime((prev) => ({
            ...prev,
            recentProjects: remainingProjects,
            recentProjectSessions: (prev.recentProjectSessions ?? []).filter(
              (session) => Boolean(session.projectId && remainingProjectIds.has(session.projectId)),
            ),
          }));
        }
      } else {
        flashMaintenanceHint("已删除该会话。", 2200);
      }
    },
    [
      activeProjectId,
      cancelPendingProjectOpen,
      filterRecentlyDeletedProjectSnapshots,
      flashMaintenanceHint,
      historyAutomationMode,
      loadAskUserQuestionModule,
      loadProjectStore,
      openProject,
      qState?.request.id,
      runtimeReset,
      restoredProjectSuggestionKeysRef,
      runtimeRef,
      setPopoverOverride,
      setQState,
      setActiveProjectId,
      setRuntime,
      setSelectedValues,
      setStreaming,
      setSuggested,
      surfacedProjectSuggestionKeysRef,
      surfacedTaskFollowupIdsRef,
      surfacedTaskIdsRef,
    ],
  );

  const handleDeleteProject = useCallback((snapshot: ConversationProjectSnapshot) => {
    setPendingDeleteSnapshot(snapshot);
  }, []);

  const handleDuplicateProject = useCallback(
    async (snapshot: ConversationProjectSnapshot) => {
      try {
        const store = await loadProjectStore();
        const newSnapshot = await store.duplicateConversationProject(snapshot);
        if (!newSnapshot) {
          flashMaintenanceHint("复制失败，未找到原始项目数据。", 3200);
          return;
        }
        startTransition(() => {
          setRuntime((prev) => ({
            ...prev,
            recentProjects: sortConversationSnapshots([newSnapshot, ...prev.recentProjects]),
          }));
        });
        flashMaintenanceHint(`已复制为《${newSnapshot.title}》。`, 2400);
      } catch (error) {
        flashMaintenanceHint(
          error instanceof Error ? error.message : "复制对话失败，请稍后重试。",
          3200,
        );
      }
    },
    [flashMaintenanceHint, loadProjectStore],
  );

  const handleCleanExpiredVideos = useCallback(
    async (snapshot: ConversationProjectSnapshot) => {
      if (snapshot.projectKind !== "video") {
        flashMaintenanceHint("当前只有视频项目支持清理过期视频。", 2400);
        return;
      }

      try {
        const store = await loadProjectStore();
        const result = await store.cleanupConversationProjectExpiredVideoMedia(snapshot.projectId);
        const removedTotal = result.removedProjectVideoRefs + result.removedSessionMediaRefs;
        if (removedTotal === 0) {
          flashMaintenanceHint("未发现需要清理的过期视频记录。", 2200);
          return;
        }

        const nextSession =
          result.session && result.snapshot
            ? {
                ...result.session,
                currentProjectSnapshot: result.snapshot,
              }
            : result.session;

        if (activeProjectId === snapshot.projectId && nextSession) {
          writeStudioSession(nextSession);
          messagesRef.current = nextSession.messages;
          compactedMessageCountRef.current = nextSession.compactedMessageCount ?? 0;
        }

        startTransition(() => {
          if (activeProjectId === snapshot.projectId && nextSession) {
            setFullAutoChecklistCollapsed(nextSession.fullAutoChecklistCollapsed ?? true);
            setMessages(nextSession.messages);
            setCompactedMessageCount(nextSession.compactedMessageCount ?? 0);
          }

          setRuntime((prev) => ({
            ...prev,
            recentProjects: result.snapshot
              ? mergeRecentProjects(prev.recentProjects, result.snapshot)
              : prev.recentProjects,
            recentProjectSessions: nextSession
              ? upsertRecentProjectSession(prev.recentProjectSessions, nextSession)
              : prev.recentProjectSessions,
            ...(prev.currentProjectSnapshot?.projectId === snapshot.projectId && result.snapshot
              ? { currentProjectSnapshot: result.snapshot }
              : {}),
            ...(prev.currentVideoProject?.id === snapshot.projectId && result.videoProject
              ? { currentVideoProject: result.videoProject }
              : {}),
          }));
        });

        flashMaintenanceHint(
          `已清理 ${result.removedProjectVideoRefs} 条项目视频引用，${result.removedSessionMediaRefs} 条媒体记录。`,
          3200,
        );
      } catch (error) {
        flashMaintenanceHint(
          error instanceof Error ? error.message : "清理过期视频失败，请稍后重试。",
          3200,
        );
      }
    },
    [activeProjectId, flashMaintenanceHint, loadProjectStore, setCompactedMessageCount, setMessages, setRuntime],
  );

  const handleDeleteProjectConfirm = useCallback(async () => {
    if (!pendingDeleteSnapshot || deletingProjectId) return;
    const snapshot = pendingDeleteSnapshot;
    setDeletingProjectId(snapshot.projectId);
    try {
      await performDeleteProject(snapshot);
      setPendingDeleteSnapshot((current) =>
        current?.projectId === snapshot.projectId ? null : current,
      );
    } finally {
      setDeletingProjectId((current) =>
        current === snapshot.projectId ? null : current,
      );
    }
  }, [deletingProjectId, pendingDeleteSnapshot, performDeleteProject]);

  const handleBulkDeleteProjects = useCallback(
    async (snapshots: ConversationProjectSnapshot[]) => {
      for (const snapshot of snapshots) {
        await performDeleteProject(snapshot);
      }
    },
    [performDeleteProject],
  );

  const handleLaunchNoticeAction = useCallback(
    (actionId: string) => {
      if (actionId === "open_settings") {
        handleOpenSettings();
        return;
      }

      if (actionId === "continue_script_only" && launchNoticeKey) {
        setSuppressedLaunchNoticeKey(launchNoticeKey);
        flashMaintenanceHint("已按仅剧本 / 改编模式继续，视频配置提醒本轮先收起。", 2400);
      }
    },
    [flashMaintenanceHint, handleOpenSettings, launchNoticeKey],
  );

  const {
    runBackgroundVideoBridgeResearch,
    runWorkflowActionShortcut,
    runWorkflowActionShortcutChain,
    interruptWorkflowShortcut,
    switchVideoStep,
  } = useHomeAgentWorkflowShortcuts({
    runtimeRef,
    backgroundResearchGroupsRef,
    surfacedProjectSuggestionKeysRef,
    dismissedProjectSuggestionKeysRef,
    loadApiConfigModule,
    loadWorkflowActionsModule,
    push,
    resetComposerDraft,
    setStreaming,
    setSuggested,
    setPopoverOverride,
    setMode,
    setRuntime,
    setActiveProjectId,
    activeProjectId,
    setActiveWorkflowAction,
    send,
    creationMode,
    selectedTextModelKey,
    selectedImageModelFamily,
    imageGenerationPrefs,
    selectedVideoModelKey,
    videoGenerationPrefs,
    restoreInterruptedChoiceQuestion,
  });
  interruptWorkflowShortcutRef.current = interruptWorkflowShortcut;

  // 包装 runWorkflowActionShortcut：媒体生成 action 统一走快捷工作流守卫，
  // 这样单目标与批量目标都能先展示日志并进入 3 秒可撤回窗口。
  const runWorkflowActionShortcutWithInlineCheck = useCallback(
    (
      action: string,
      input: Record<string, unknown>,
      label: string,
      options?: Parameters<typeof runWorkflowActionShortcut>[3],
    ) => {
      if (action === "update_compliance_workspace" && typeof input.strictness === "string") {
        void (async () => {
          try {
            const workflow = await loadWorkflowActionsModule();
            const result = await workflow.runWorkflowAction(action, input, runtimeRef.current);
            if (!result.data) return;
            const nextRuntime = mergeRuntimeWithWorkflowDelta(runtimeRef.current, result.data);
            setRuntime(nextRuntime);
            const nextSessionProjectId = resolveSessionProjectIdForSnapshot({
              currentSessionProjectId: activeProjectId,
              snapshot: result.data.projectSnapshot ?? nextRuntime.currentProjectSnapshot,
              fallbackProjectId:
                result.data.projectSnapshot?.projectId ??
                nextRuntime.currentProjectSnapshot?.projectId,
            });
            if (nextSessionProjectId) {
              setActiveProjectId(nextSessionProjectId);
            }
            const nextQuestion = result.data.projectSnapshot
              ? recQuestion(result.data.projectSnapshot, nextRuntime.currentVideoProject)
              : null;
            setPopoverOverride(nextQuestion);
            setSuggested(null);
          } catch (error) {
            flashMaintenanceHint(
              error instanceof Error ? error.message : "严格度切换失败，请稍后重试。",
              2400,
            );
          }
        })();
        return;
      }

      runWorkflowActionShortcut(action, input, label, options);
    },
    [
      activeProjectId,
      flashMaintenanceHint,
      loadWorkflowActionsModule,
      runWorkflowActionShortcut,
      runtimeRef,
      setActiveProjectId,
      setPopoverOverride,
      setRuntime,
      setSuggested,
    ],
  );
  workflowRefreshShortcutRunnerRef.current = runWorkflowActionShortcutWithInlineCheck;
  workflowRefreshShortcutChainRunnerRef.current = runWorkflowActionShortcutChain;

  const handlePendingVideoKickoffStyleReferenceUpload = useCallback(
    async (
      currentFiles: File[],
      rawText: string,
    ) => {
      const pendingRequest = pendingVideoKickoffStyleReferenceUploadRef.current;
      if (!pendingRequest) return false;
      if (!currentFiles.some(isSupportedImageFile)) {
        push("assistant", "我正在等你上传参考图。请至少上传一张图片，发送后我会继续识别并自动进入下一步。");
        return true;
      }

      try {
        await runVideoKickoffStyleReferenceRecognition(currentFiles, rawText);
        return true;
      } catch {
        return true;
      }
    },
    [
      runVideoKickoffStyleReferenceRecognition,
    ],
  );

  const handlePendingCharacterAudioReferenceUpload = useCallback(
    async (currentFiles: File[]) => bindPendingCharacterAudioReferenceUpload(currentFiles),
    [bindPendingCharacterAudioReferenceUpload],
  );

  const handleAttachedFilesChange = useCallback(
    (nextFiles: File[]) => {
      const pendingRequest = resolvePendingCharacterAudioUploadRequest();
      if (!pendingRequest) {
        setAttachedFiles(nextFiles);
        return;
      }

      const audioFiles = collectSupportedCharacterAudioFiles(nextFiles);
      if (audioFiles.length > 1) {
        flashMaintenanceHint(
          pendingRequest.characterName
            ? `角色《${pendingRequest.characterName}》一次只能绑定 1 个音色，请只保留 1 个音频文件后再发送。`
            : "当前角色一次只能绑定 1 个音色，请只保留 1 个音频文件后再发送。",
          3200,
        );
        return;
      }

      setAttachedFiles(nextFiles);
    },
    [flashMaintenanceHint, resolvePendingCharacterAudioUploadRequest, setAttachedFiles],
  );

  const handleExportLocalAction = useCallback(
    (action: ExportLocalAction) => {
      const project = runtimeRef.current.currentDramaProject;
      if (!project) return;
      const quickMd = buildQuickExportMarkdown(
        project.setup,
        project.dramaTitle,
        project.creativePlan || project.structureTransform || "",
        project.characters,
        project.episodes,
      );
      const questionToRestore = popoverOverride ?? suggested ?? null;
      if (action === "copy") {
        void navigator.clipboard.writeText(quickMd);
      } else if (action === "download-md") {
        void exportMarkdownFileLocally(
          sanitizeExportFileName(`${project.dramaTitle || "script"}.md`, "script.md"),
          quickMd,
        )
          .then((result) => {
            if (result.status === "cancelled") {
              restoreInterruptedChoiceQuestion(questionToRestore);
            }
          })
          .catch((error) => {
            flashMaintenanceHint(
              error instanceof Error ? error.message : "导出 Markdown 失败，请稍后重试。",
              3200,
            );
          });
      } else if (action === "word") {
        if (project.setup) {
          void import("@/lib/export-docx")
            .then(({ exportToDocx }) =>
              exportToDocx(
                project.setup,
                project.dramaTitle,
                project.creativePlan || project.structureTransform || "",
                project.characters,
                project.episodes,
              ),
            )
            .then((result) => {
              if (result.status === "cancelled") {
                restoreInterruptedChoiceQuestion(questionToRestore);
              }
            })
            .catch((error) => {
              flashMaintenanceHint(
                error instanceof Error ? error.message : "导出 Word 失败，请稍后重试。",
                3200,
              );
            });
        }
      } else if (action === "episodes-download") {
        void exportEpisodeMarkdownFilesLocally(project.episodes)
          .then((result) => {
            if (result.status === "cancelled") {
              restoreInterruptedChoiceQuestion(questionToRestore);
            }
          })
          .catch((error) => {
            flashMaintenanceHint(
              error instanceof Error ? error.message : "导出分集 Markdown 失败，请稍后重试。",
              3200,
            );
          });
      }
    },
    [flashMaintenanceHint, popoverOverride, restoreInterruptedChoiceQuestion, runtimeRef, suggested],
  );

  const handleVideoKickoff = useCallback(() => {
    const hasDramaProject = Boolean(
      runtimeRef.current.currentDramaProject?.id ||
      isBridgeableVideoWorkflowSourceSnapshot(runtimeRef.current.currentProjectSnapshot) ||
      (automationMode === "full-auto" &&
        isBridgeableVideoWorkflowSourceSnapshot(preferredVideoWorkflowSourceSnapshotRef.current)),
    );
    push("user", "接入视频工作流");
    push("assistant", buildVideoWorkflowKickoffIntro());
    setPopoverOverride(null);
    setSuggested(null);
    setSelectedValues([]);
    setMode("active");
    resetComposerDraft("");
    setQState(createQuestionState(buildVideoWorkflowKickoffRequest(hasDramaProject), "restored"));
  }, [automationMode, createQuestionState, push, resetComposerDraft, runtimeRef, setMode, setPopoverOverride, setQState, setSelectedValues, setSuggested]);

  const {
    videoProjectChoiceHandler,
    videoAssetChoiceHandler,
    scriptProjectChoiceHandler,
  } = useHomeAgentChoiceHandlers({
    runtimeRef,
    getCurrentQuestion: () => question,
    rememberInterruptRestoreQuestion: (nextQuestion) => {
      interruptRestoreQuestionRef.current = nextQuestion;
      setInterruptedChoiceQuestion(nextQuestion);
    },
    push,
    setPopoverOverride,
    openPopoverQuestion: openWorkflowPopoverQuestion,
    setSuggested,
    setMode,
    resetComposerDraft,
    runWorkflowActionShortcut: runWorkflowActionShortcutWithInlineCheck,
    runWorkflowActionShortcutChain,
    runBackgroundVideoBridgeResearch,
    commitVideoProjectPatch: commitCurrentVideoProjectPatch,
    commitImageGenerationPrefs: commitEffectiveImagePrefs,
    commitVideoGenerationPrefs: commitEffectiveVideoPrefs,
    getImageGenerationPrefs: () => imageGenerationPrefs,
    getVideoGenerationPrefs: () => videoGenerationPrefs,
    getAttachedImageCount: () => attachedFiles.filter(isSupportedImageFile).length,
    clearAttachedFiles: () => setAttachedFiles([]),
    recognizeImageStyle: handleRecognizeImageStyle,
    submitAttachedStyleReference: handleSubmitAttachedStyleReference,
    onAwaitVideoKickoffStyleReferenceUpload: (label) => {
      pendingVideoKickoffStyleReferenceUploadRef.current = { label };
      setAwaitingVideoKickoffStyleReferenceUpload(true);
    },
    onAwaitCharacterAudioReferenceUpload: (label, characterId, characterName, restoreQuestion) => {
      const exactRestoreQuestion = markQuestionForExactRestore(restoreQuestion ?? null);
      pendingCharacterAudioReferenceUploadRef.current = {
        label,
        characterId,
        characterName,
        restoreQuestion: exactRestoreQuestion,
        restoreContext: {
          question: exactRestoreQuestion,
          qState,
          selectedValues: [...selectedValues],
          draft: resolveComposerDraftSnapshot(draftRef.current, persistedDraft) || "",
        },
      };
      setAwaitingCharacterAudioReferenceUpload(true);
      setAttachedFiles([]);
      openWorkflowPopoverQuestion(
        buildPendingCharacterAudioUploadQuestion({
          projectId: runtimeRef.current.currentProjectSnapshot?.projectId ?? null,
          characterId,
          characterName,
          canReturnToMenu: Boolean(exactRestoreQuestion),
        }),
      );
    },
    onOpenCharacterAudioReferencePresetPicker: (
      label,
      characterId,
      characterName,
      restoreQuestion,
    ) =>
      openCharacterAudioReferencePresetPicker(
        label,
        characterId,
        characterName,
        restoreQuestion,
      ),
    onBindCharacterAudioReferencePreset: (selection) =>
      bindCharacterAudioReferencePreset(selection),
    onClearVideoKickoffStyleReferenceUploadWait: () => {
      pendingVideoKickoffStyleReferenceUploadRef.current = null;
      setAwaitingVideoKickoffStyleReferenceUpload(false);
    },
    interruptWorkflowShortcut,
    switchVideoStep,
    send,
    buildVideoGenerationQuestion,
    listGeneratableVideoScenes,
    listRunningVideoScenes,
    buildVideoGenerationSceneListQuestion,
    listFailedVideoScenes,
    listUnlockedCharacterCards,
    buildCharacterCardListQuestion,
    findCharacterCard,
    buildCharacterCardDecisionQuestion,
    listPendingCompliancePackets,
    buildComplianceListQuestion,
    findCompliancePacket,
    buildComplianceDecisionQuestion,
    listUnlockedBeatPackets,
    buildBeatPacketListQuestion,
    findBeatPacket,
    buildBeatPacketDecisionQuestion,
    buildOutlinesWorkflowQuestion,
    buildEpisodeDurationGateQuestion,
    buildEpisodeWorkflowQuestion,
    onExportLocalAction: handleExportLocalAction,
    onVideoKickoff: handleVideoKickoff,
  });

  const handleUploadCharacterAudioReferenceFromSidebar = useCallback(
    (characterId: string, characterName?: string) => {
      const snapshot = runtimeRef.current.currentProjectSnapshot;
      if (!snapshot || snapshot.projectKind !== "video") {
        push("assistant", "当前没有可用的视频项目，请先进入角色与场景资产面板后再上传音频参考。");
        return;
      }

      const matchedCharacter = runtimeRef.current.currentVideoProject?.characters.find(
        (character) => character.id === characterId,
      );
      const resolvedCharacterName =
        matchedCharacter?.name?.trim() || characterName?.trim() || undefined;
      const hasAudioReference = Boolean(
        matchedCharacter?.audioUrl?.trim() || matchedCharacter?.audioFileName?.trim(),
      );
      const label = `${hasAudioReference ? "更新" : "上传"}${
        resolvedCharacterName ?? "角色"
      }音频参考`;

      videoProjectChoiceHandler(
        snapshot,
        `video:bridge:reference-audio:character:${characterId}`,
        label,
      );
    },
    [push, videoProjectChoiceHandler],
  );

  const handleRemoveCharacterAudioReferenceFromSidebar = useCallback(
    async (characterId: string, characterName?: string) => {
      let currentVideoProject = runtimeRef.current.currentVideoProject;
      if (!currentVideoProject) {
        const fallbackProjectId = runtimeRef.current.currentProjectSnapshot?.projectId;
        if (fallbackProjectId) {
          currentVideoProject =
            (await loadStoredVideoProjectById(fallbackProjectId, { fast: true })) ??
            (await loadStoredVideoProjectById(fallbackProjectId));
        }
      }

      if (!currentVideoProject) {
        push("assistant", "当前没有可用的视频项目，请先进入角色与场景资产面板后再管理音频参考。");
        return;
      }

      const targetCharacter = currentVideoProject.characters.find(
        (character) => character.id === characterId,
      );
      if (!targetCharacter) {
        push("assistant", "没有找到要移除音频参考的角色，请重新打开素材菜单后再试一次。");
        return;
      }

      const resolvedCharacterName =
        targetCharacter.name?.trim() || characterName?.trim() || "当前角色";
      const hasAudioReference = Boolean(
        targetCharacter.audioUrl?.trim() || targetCharacter.audioFileName?.trim(),
      );
      if (!hasAudioReference) {
        push("assistant", `角色《${resolvedCharacterName}》当前还没有已绑定的音频参考。`);
        return;
      }

      const nextCharacters = currentVideoProject.characters.map((character) =>
        character.id === targetCharacter.id
          ? {
              ...character,
              audioUrl: undefined,
              audioFileName: undefined,
            }
          : character,
      );
      const nextProject = await upsertStoredVideoProject(
        synchronizeVideoProductionState({
          ...currentVideoProject,
          characters: nextCharacters,
        }),
      );

      startTransition(() => {
        setRuntime((previous) => ({
          ...previous,
          currentVideoProject:
            previous.currentVideoProject?.id === nextProject.id ||
            previous.currentProjectSnapshot?.projectId === nextProject.id
              ? nextProject
              : previous.currentVideoProject,
        }));
      });

      push("assistant", `已删除角色《${resolvedCharacterName}》的音频参考。`);
    },
    [push, runtimeRef, setRuntime],
  );

  const handlePendingCharacterAudioUploadChoice = useCallback(
    (
      value: string,
      label?: string,
      currentQuestion?: ComposerQuestion | null,
    ) => {
      const isPendingAudioQuestion =
        currentQuestion?.answerKey === PENDING_CHARACTER_AUDIO_QUESTION_KEY ||
        question?.answerKey === PENDING_CHARACTER_AUDIO_QUESTION_KEY;
      if (
        value === PENDING_CHARACTER_AUDIO_RETURN_MENU_VALUE ||
        (isPendingAudioQuestion &&
          (value.trim() === "返回菜单" || label?.trim() === "返回菜单"))
      ) {
        return cancelPendingCharacterAudioReferenceUpload({ restoreMenu: true });
      }
      if (
        value === PENDING_CHARACTER_AUDIO_CANCEL_VALUE ||
        (isPendingAudioQuestion &&
          (value.trim() === "取消上传" || label?.trim() === "取消上传"))
      ) {
        return cancelPendingCharacterAudioReferenceUpload();
      }
      return false;
    },
    [cancelPendingCharacterAudioReferenceUpload, question],
  );

  const handleGlobalInterrupt = useCallback(() => {
    const explicitRestoreQuestion = interruptRestoreQuestionRef.current;
    interruptRestoreQuestionRef.current = null;
    const activeSnapshot = runtimeRef.current.currentProjectSnapshot;
    const restoreQuestion = resolveInterruptedWorkflowQuestion({
      explicitRestoreQuestion,
      activeWorkflowAction,
      snapshot: activeSnapshot,
      videoProject: runtimeRef.current.currentVideoProject,
    });

    const stopResult = stopActiveExecution();
    interruptWorkflowShortcut();
    const stoppedTaskCount = stopRunningTasks();

    setStreaming(false);
    if (restoreQuestion) {
      restoreInterruptedChoiceQuestion(restoreQuestion);
      const restoreInterruptMessage =
        stopResult.cancelledRemoteVideoTaskCount > 0
          ? `已停止当前执行，并已向视频生成服务发起 ${stopResult.cancelledRemoteVideoTaskCount} 条撤销请求。刚才的弹窗已恢复，你可以重新选择。`
          : "已停止当前执行，刚才的弹窗已恢复，你可以重新选择。";
      push("assistant", restoreInterruptMessage);
      return;
    }

    if (
      shouldRestoreLastSuggestedAfterInterrupt(activeWorkflowAction) &&
      lastSuggestedRef.current
    ) {
      setSuggested(lastSuggestedRef.current);
    }

    setInterruptedChoiceQuestion(null);

    if (stopResult.hadActiveExecution || stoppedTaskCount > 0) {
      push("assistant", "已停止当前执行。你可以调整后继续。");
    }
  }, [
    activeWorkflowAction,
    interruptWorkflowShortcut,
    lastSuggestedRef,
    push,
    runtimeRef,
    setInterruptedChoiceQuestion,
    setStreaming,
    setSuggested,
    stopRunningTasks,
    stopActiveExecution,
    restoreInterruptedChoiceQuestion,
  ]);

  const handleStopFullAuto = useCallback(() => {
    const run = runtimeRef.current.fullAutoRun;
    if (
      run?.status === "collecting" ||
      run?.status === "running" ||
      run?.status === "retrying" ||
      run?.status === "paused" ||
      run?.status === "failed"
    ) {
      stopFullAutoExecution();
      return;
    }
    handleGlobalInterrupt();
  }, [handleGlobalInterrupt, runtimeRef, stopFullAutoExecution]);

  const dismissDeferredQuestion = useCallback(
    (questionState: QState, nextSelectedValues: string[], nextDraft: string) => {
      const nextDeferredQuestionState = {
        ...questionState,
        source: "deferred" as const,
      };
      const currentProjectId = resolveSessionProjectIdForSnapshot({
        currentSessionProjectId: activeProjectId,
        snapshot: runtimeRef.current.currentProjectSnapshot,
        fallbackProjectId: runtimeRef.current.currentProjectSnapshot?.projectId ?? activeProjectId,
      });
      const stepKey = `${questionState.request.id}:${questionState.currentIndex}`;
      const lastAssistantMessage =
        [...messages].reverse().find((message) => message.role === "assistant") ?? null;
      dismissedDeferredQuestionStepRef.current = stepKey;
      setDeferredQuestionState(nextDeferredQuestionState);
      setDeferredSelectedValues(nextSelectedValues);
      setDeferredDraft(nextDraft);
      setPendingDeferredQuestionRestoreAfterAssistantReply({
        stepKey,
        lastAssistantMessageId: lastAssistantMessage?.id ?? null,
        projectId: currentProjectId ?? null,
      });
      if (currentProjectId) {
        queueStudioSessionWrite({
          sessionId: runtimeRef.current.sessionId,
          mode,
          creationMode,
          automationMode: normalizeAutomationMode(
            runtimeRef.current.currentProjectSnapshot?.automationMode ?? automationMode,
          ),
          devMode,
          messages,
          currentProjectSnapshot: runtimeRef.current.currentProjectSnapshot
            ? {
                ...runtimeRef.current.currentProjectSnapshot,
                automationMode: normalizeAutomationMode(
                  runtimeRef.current.currentProjectSnapshot.automationMode ?? automationMode,
                ),
              }
            : null,
          recentMessageSummary: runtime.recentMessageSummary,
          projectId: currentProjectId,
          selectedTextModelKey,
          selectedImageModelFamily,
          imageGenerationPrefs,
          selectedVideoModelKey,
          videoGenerationPrefs,
          compactedMessageCount,
          draft: "",
          qState: null,
          deferredQuestionState: nextDeferredQuestionState,
          pendingWorkflowUploadKind,
          pendingChoiceQuestion: null,
          interruptedChoiceQuestion: pendingWorkflowUploadKind ? null : interruptedChoiceQuestion,
          selectedValues: [],
          deferredSelectedValues: nextSelectedValues,
          deferredDraft: nextDraft,
          surfacedTaskIds: [...surfacedTaskIdsRef.current],
          surfacedTaskFollowupKeys: [...surfacedTaskFollowupIdsRef.current],
          surfacedProjectSuggestionKeys: [...surfacedProjectSuggestionKeysRef.current],
          fullAutoRun: runtimeRef.current.fullAutoRun ?? null,
          fullAutoChecklistCollapsed,
        }, 120, { persistFullBackup: false });
      }
    },
    [
      activeProjectId,
      automationMode,
      compactedMessageCount,
      creationMode,
      devMode,
      fullAutoChecklistCollapsed,
      imageGenerationPrefs,
      interruptedChoiceQuestion,
      messages,
      mode,
      runtime,
      runtimeRef,
      selectedImageModelFamily,
      selectedTextModelKey,
      selectedVideoModelKey,
      setDeferredDraft,
      setDeferredQuestionState,
      setDeferredSelectedValues,
      surfacedProjectSuggestionKeysRef,
      surfacedTaskFollowupIdsRef,
      surfacedTaskIdsRef,
      videoGenerationPrefs,
    ],
  );

  const dismissCurrentChoiceQuestion = useCallback(
    (questionToDismiss: ComposerQuestion | null) => {
      const snapshot = runtimeRef.current.currentProjectSnapshot;
      const suggestionKey = buildProjectSuggestionKey(snapshot, questionToDismiss);
      if (suggestionKey) {
        dismissedProjectSuggestionKeysRef.current.add(suggestionKey);
        surfacedProjectSuggestionKeysRef.current.delete(suggestionKey);
        restoredProjectSuggestionKeysRef.current.delete(suggestionKey);
      }
      const currentProjectId = resolveSessionProjectIdForSnapshot({
        currentSessionProjectId: activeProjectId,
        snapshot: runtimeRef.current.currentProjectSnapshot,
        fallbackProjectId: runtimeRef.current.currentProjectSnapshot?.projectId ?? activeProjectId,
      });
      if (currentProjectId) {
        queueStudioSessionWrite({
          sessionId: runtimeRef.current.sessionId,
          mode,
          creationMode,
          automationMode: normalizeAutomationMode(
            runtimeRef.current.currentProjectSnapshot?.automationMode ?? automationMode,
          ),
          devMode,
          messages,
          currentProjectSnapshot: runtimeRef.current.currentProjectSnapshot
            ? {
                ...runtimeRef.current.currentProjectSnapshot,
                automationMode: normalizeAutomationMode(
                  runtimeRef.current.currentProjectSnapshot.automationMode ?? automationMode,
                ),
              }
            : null,
          recentMessageSummary: runtime.recentMessageSummary,
          projectId: currentProjectId,
          selectedTextModelKey,
          selectedImageModelFamily,
          imageGenerationPrefs,
          selectedVideoModelKey,
          videoGenerationPrefs,
          compactedMessageCount,
          draft: "",
          qState,
          deferredQuestionState,
          pendingWorkflowUploadKind,
          pendingChoiceQuestion: pendingWorkflowUploadKind ? null : questionToDismiss,
          interruptedChoiceQuestion: pendingWorkflowUploadKind ? null : interruptedChoiceQuestion,
          selectedValues: [],
          deferredSelectedValues,
          deferredDraft,
          surfacedTaskIds: [...surfacedTaskIdsRef.current],
          surfacedTaskFollowupKeys: [...surfacedTaskFollowupIdsRef.current],
          surfacedProjectSuggestionKeys: [...surfacedProjectSuggestionKeysRef.current],
          fullAutoRun: runtimeRef.current.fullAutoRun ?? null,
          fullAutoChecklistCollapsed,
        }, 120, { persistFullBackup: false });
      }
      setPopoverOverride(questionToDismiss);
      setSuggested(null);
    },
    [
      activeProjectId,
      automationMode,
      compactedMessageCount,
      creationMode,
      deferredDraft,
      deferredQuestionState,
      deferredSelectedValues,
      devMode,
      fullAutoChecklistCollapsed,
      imageGenerationPrefs,
      interruptedChoiceQuestion,
      pendingWorkflowUploadKind,
      messages,
      mode,
      qState,
      restoredProjectSuggestionKeysRef,
      runtime,
      runtimeRef,
      selectedImageModelFamily,
      selectedTextModelKey,
      selectedVideoModelKey,
      setPopoverOverride,
      setSuggested,
      surfacedProjectSuggestionKeysRef,
      surfacedTaskFollowupIdsRef,
      surfacedTaskIdsRef,
      videoGenerationPrefs,
    ],
  );

  // 鏂板缓椤圭洰鍓嶅厛鎶婂綋鍓嶉」鐩?ID 鏍囪涓?stale锛岄槻姝㈠叾鍚庡彴 delta 姹℃煋鏂伴」鐩潰鏉?
  // 鍚屾椂鎸佷箙鍖栧綋鍓嶉」鐩紝闃叉鍒囨崲鍚庨」鐩涪澶?
  const handleNewProject = useCallback(() => {
    suppressAutoRestore();
    cancelPendingProjectOpen();
    const currentProjectId = runtimeRef.current.currentProjectSnapshot?.projectId;
    if (currentProjectId) {
      staleProjectIdsRef.current.add(currentProjectId);
    }
    // 无项目的自由对话：reset 前先保存，防止切换后历史丢失
    if (!currentProjectId && messagesRef.current.length > 0) {
      flushSessionRef.current();
    }
    // 濡傛灉褰撳墠鏈夊墽鏈」鐩紝鍏堜繚瀛樺埌 localStorage 鍐?reset
    const currentDramaProject = runtimeRef.current.currentDramaProject;
    if (currentDramaProject) {
      void import("@/lib/home-agent/project-store").then(({ upsertStoredDramaProject }) => {
        upsertStoredDramaProject(currentDramaProject);
      });
    }
    handleReset();
  }, [cancelPendingProjectOpen, handleReset, runtimeRef, suppressAutoRestore]);

  // 鍖呰 send锛屽鐞嗛檮鍔犳枃浠?
  /*
  const sendWithFiles = useCallback(
    async (rawPrompt: string, shown?: string, opts?: { skipUserBubble?: boolean }) => {
      if (attachedFiles.length === 0) {
        return send(rawPrompt, shown, opts);
      }

      // 濡傛灉娌℃湁鏂囧瓧锛屼娇鐢ㄩ粯璁ゆ彁绀鸿瘝
      const effectivePrompt = rawPrompt.trim() || "请分析以下上传的文件内容。";
      const fileNames = attachedFiles.map((f) => f.name);
      const displayText = (shown ?? rawPrompt).trim() || `上传了 ${fileNames.join("、")}`;

      // 妫€娴嬫槸鍚︿负瀹℃牳鎰忓浘 + 鏈夋枃浠?鈫?瑙﹀彂鍚堣宸ヤ綔娴?
      const isComplianceIntent = COMPLIANCE_KEYWORDS.test(effectivePrompt);
      const snapshot = runtimeRef.current.currentProjectSnapshot;

      if (isComplianceIntent && snapshot && attachedFiles.length > 0) {
        // 鍙栫涓€涓枃浠朵綔涓哄緟瀹℃枃浠讹紝瑙﹀彂鍚堣瀵煎叆宸ヤ綔娴?
        const file = attachedFiles[0];
        const currentFiles = [...attachedFiles];
        setAttachedFiles([]);
        push(
          "user",
          displayText,
          undefined,
          currentFiles.map((file) => ({
            id: crypto.randomUUID(),
            fileName: file.name,
            mimeType: file.type || "application/octet-stream",
            size: file.size,
            kind: "binary" as const,
          })),
        );
        void runWorkflowActionShortcut(
          "update_compliance_workspace",
          { projectId: snapshot.projectId, file },
          `导入待审文件：${file.name}`,
        );
        return;
      }

      // 鏅€氬彂閫侊細瑙ｆ瀽鏂囦欢鍐呭闄勫姞鍒版彁绀鸿瘝
      try {
        const imageFiles = attachedFiles.filter(isSupportedImageFile);
        const documentFiles = attachedFiles.filter((file) => !isSupportedImageFile(file));
        const contextBlocks: string[] = [];

        if (imageFiles.length > 0) {
          try {
            const recognition = await analyzeHomeAgentImageStyleFiles(imageFiles, {
              userPrompt: effectivePrompt,
            });
            contextBlocks.push(buildHomeAgentImageAnalysisContext(recognition));
          } catch {
            contextBlocks.push(
              [
                "以下图片已上传，但自动识别失败，请直接结合文件名理解：",
                ...imageFiles.map((file) => `- ${file.name}`),
              ].join("\n"),
            );
          }
        }

        if (documentFiles.length > 0) {
          const parsedContents = await Promise.all(
            documentFiles.map(async (file) => {
              try {
                const { sourceText } = await parseComplianceImportFile(file);
                return `【文件：${file.name}】\n${sourceText.slice(0, 8000)}`;
              } catch {
                return `【文件：${file.name}（解析失败）】`;
              }
            }),
          );
          contextBlocks.push(...parsedContents);
        }

        const fileContext = contextBlocks.join("\n\n");
        const promptWithFiles = `${effectivePrompt}\n\n以下是用户上传的文件内容：\n\n${fileContext}`;
        setAttachedFiles([]);
        push(
          "user",
          displayText,
          undefined,
          currentFiles.map((file) => ({
            id: crypto.randomUUID(),
            fileName: file.name,
            mimeType: file.type || "application/octet-stream",
            size: file.size,
            kind: "binary" as const,
          })),
        );
        return send(promptWithFiles, undefined, { skipUserBubble: true });
      } catch {
        setAttachedFiles([]);
        push(
          "user",
          displayText,
          undefined,
          currentFiles.map((file) => ({
            id: crypto.randomUUID(),
            fileName: file.name,
            mimeType: file.type || "application/octet-stream",
            size: file.size,
            kind: "binary" as const,
          })),
        );
        return send(effectivePrompt, undefined, { skipUserBubble: true });
      }
    },
    [attachedFiles, send, push, runtimeRef, runWorkflowActionShortcut, setAttachedFiles],
  );

  */
  const sendWithPreparedFiles = useCallback(
    async (
      rawPrompt: import("@/lib/agent/types").MessageInput,
      shown?: string,
      opts?: {
        skipUserBubble?: boolean;
        attachments?: ChatAttachment[];
        workflowAttachments?: ChatAttachment[];
        disableAutoResearch?: boolean;
      },
    ) => {
      if (attachedFiles.length === 0) {
        return send(rawPrompt, shown, opts);
      }

      const currentFiles = [...attachedFiles];
      const rawText = typeof rawPrompt === "string" ? rawPrompt : textOf(rawPrompt);
      const imageFiles = currentFiles.filter((f) => f.type.startsWith("image/"));
      const imageNames = imageFiles.map((f) => f.name).join("、");
      const effectivePrompt =
        rawText.trim() ||
        (imageFiles.length > 0
          ? `这是图片「${imageNames}」，请帮我识别图片内容，并结合当前项目上下文给出合理的分析或下一步建议。`
          : "请先分析这些附件内容，并说明当前最合适的下一步。");
      const displayText = (shown ?? rawText).trim() || `上传了 ${currentFiles.map((file) => file.name).join("、")}`;

      try {
        if (
          await handlePendingVideoKickoffStyleReferenceUpload(
            currentFiles,
            rawText,
          )
        ) {
          return;
        }

        if (await handlePendingCharacterAudioReferenceUpload(currentFiles)) {
          return;
        }

        const textModelRuntime = resolveHomeAgentTextModelRuntime(
          await loadApiConfigModule(),
          selectedTextModelKey,
        );
        const capabilities = inferModelInputCapabilities({
          provider: textModelRuntime.provider,
          model: textModelRuntime.model,
        });
        const preparedAttachments = await prepareChatAttachments(currentFiles);
        const promptWithFiles = await buildMessageInputFromAttachments({
          prompt: effectivePrompt,
          attachments: preparedAttachments,
          capabilities,
        });

        setAttachedFiles([]);
        return send(promptWithFiles, displayText, {
          ...opts,
          workflowAttachments: preparedAttachments,
          attachments: preparedAttachments.map((attachment) =>
            stripAttachmentPayloadForHistory(attachment),
          ),
        });
      } catch {
        setAttachedFiles([]);
        return send(effectivePrompt, displayText, {
          ...opts,
          attachments: currentFiles.map((file) => ({
            id: crypto.randomUUID(),
            fileName: file.name,
            mimeType: file.type || "application/octet-stream",
            size: file.size,
            kind: "binary" as const,
            fallbackDigest: `${file.name} (${file.type || "unknown"}, ${file.size} bytes)`,
          })),
        });
      }
    },
    [
      attachedFiles,
      handlePendingCharacterAudioReferenceUpload,
      handlePendingVideoKickoffStyleReferenceUpload,
      loadApiConfigModule,
      selectedTextModelKey,
      send,
      textOf,
    ],
  );

  const hasPendingMediaMessage = useMemo(
    () =>
      messages.some(
        (message) =>
          message.role === "assistant" &&
          message.status === "pending" &&
          message.attachments?.some(
            (attachment) =>
              (attachment.kind === "image" || attachment.kind === "video") &&
              attachment.pending,
          ),
      ),
    [messages],
  );
  const hasRunningVideoGeneration = useMemo(() => {
    const project = runtime.currentVideoProject;
    return (
      listRunningVideoScenes(project).length > 0 ||
      listRunningSegmentVideoLabels(project).length > 0
    );
  }, [runtime.currentVideoProject]);
  const isMediaGenerating = hasPendingMediaMessage || hasRunningVideoGeneration;

  const { idleComposer, activeComposer, workflowProgress } = useHomeAgentComposerBindings({
    idle,
    currentProject,
    maintenanceHint,
    videoTransportHint,
    launchNotice,
    suppressFloatingTaskBoard: pendingDeleteSnapshot !== null,
    draftInitialValue,
    draftResetVersion,
    draftPresence,
    syncComposerDraft,
    placeholder,
    question,
    qState,
    selectedValues,
    streaming,
    fullAutoRun: runtime.fullAutoRun ?? null,
    isMediaGenerating,
    isAwaitingWorkflowDocumentUpload,
    reduceMotion,
    composerShellClass,
    activeTheme,
    activeWorkflowAction,
    selectedTextModelKey,
    selectedTextModelLabel: selectedTextModelOption.shortLabel,
    textModelGroups,
    onSelectTextModel: setSelectedTextModelKey,
    selectedImageModelKey: selectedImageModelFamily,
    selectedImageModelLabel: selectedImageModelOption.label,
    imageModelOptions,
    imageGenerationPrefs,
    onSelectImageModel: handleSelectImageModel,
    onConfirmImageSettings: handleConfirmImageSettings,
    onRecognizeImageStyle: handleRecognizeImageStyle,
    selectedVideoModelKey,
    selectedVideoModelLabel: selectedVideoModelOption.label,
    videoModelOptions,
    videoGenerationPrefs,
    onSelectVideoModel: handleSelectVideoModel,
    onConfirmVideoResolution: handleConfirmVideoResolution,
    onConfirmVideoPrefs: handleConfirmVideoResolution,
    onDevVideoGenerationModeChange: handleDevVideoGenerationModeChange,
    onDevImageViewModeChange: handleDevImageViewModeChange,
    creationMode,
    onCreationModeChange: setCreationMode,
    devMode,
    onDevModeChange: setDevMode,
    automationMode,
    runtimeRef,
    draftRef,
    engineRef,
    setStreaming,
    answer,
    send: sendWithPreparedFiles,
    setDeferredQuestionState,
    setDeferredSelectedValues,
    setDeferredDraft,
    setRuntime,
    setSelectedValues,
    setQState,
    setMessages,
    setSuggested,
    setPopoverOverride,
    dismissCurrentChoiceQuestion,
    deferDismissedQuestion: dismissDeferredQuestion,
    resetComposerDraft,
    videoProjectChoiceHandler,
    videoAssetChoiceHandler,
    scriptProjectChoiceHandler,
    autoResearchChoiceHandler,
    onBeforeChoiceSelect: (value, label, currentQuestion) =>
      handlePendingCharacterAudioUploadChoice(value, label, currentQuestion),
    canHandleQuestionBack: (currentQuestion) =>
      currentQuestion?.answerKey === PENDING_CHARACTER_AUDIO_QUESTION_KEY ||
      currentQuestion?.answerKey === CHARACTER_AUDIO_PRESET_PICKER_ANSWER_KEY,
    onBeforeQuestionBack: (currentQuestion) => {
      if (
        currentQuestion?.answerKey !== PENDING_CHARACTER_AUDIO_QUESTION_KEY
      ) {
        if (
          currentQuestion?.answerKey === CHARACTER_AUDIO_PRESET_PICKER_ANSWER_KEY
        ) {
          return exitCharacterAudioReferencePresetPicker();
        }
        return false;
      }
      return cancelPendingCharacterAudioReferenceUpload({ restoreMenu: true });
    },
    handleFullAutoChoiceSelect,
    handleFullAutoQuestionBack,
    handleFullAutoQuestionReset,
    onLaunchAction: handleLaunchNoticeAction,
    onStopFullAuto: handleStopFullAuto,
    activeTrackClassName: ACTIVE_TRACK_CLASS,
    idleTrackClassName: IDLE_TRACK_CLASS,
    lastSuggestedRef,
    interruptWorkflowShortcut,
    onGlobalInterrupt: handleGlobalInterrupt,
    clearInterruptRestoreQuestion: () => {
      interruptRestoreQuestionRef.current = null;
      setInterruptedChoiceQuestion(null);
    },
    rememberInterruptRestoreQuestion: (nextQuestion) => {
      interruptRestoreQuestionRef.current = nextQuestion;
      setInterruptedChoiceQuestion(nextQuestion);
    },
    getInterruptedChoiceQuestion: () => interruptRestoreQuestionRef.current ?? interruptedChoiceQuestion,
    attachedFiles,
    onAttachedFilesChange: handleAttachedFilesChange,
    setMode,
    queueWorkflowPopoverAfterAssistantReply,
  });
  const suppressSyntheticStreamingMessage = shouldForceSilentWorkflowShortcut(activeWorkflowAction ?? "");

  return (
    <div
      ref={scrollContainerRef}
      className="app-main-container relative h-screen overflow-x-hidden overflow-y-auto overscroll-contain app-main-scrollbar bg-background text-foreground"
      style={{ overflowAnchor: "none" }}
    >
      <HomeSurfaceBackdrop idle={idle} />
      {renameTarget ? (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setRenameTarget(null)}>
          <div className="w-[min(92vw,400px)] rounded-[20px] border border-border bg-card p-5 shadow-[0_24px_64px_rgba(0,0,0,0.3)]" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 text-[14px] font-medium text-foreground">重命名会话</div>
            <input
              autoFocus
              type="text"
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleRenameConfirm(); if (e.key === "Escape") setRenameTarget(null); }}
              className="w-full rounded-[12px] border border-border bg-muted/40 px-3 py-2 text-[13px] text-foreground outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/40"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => setRenameTarget(null)} className="h-8 rounded-full px-3.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors">取消</button>
              <button type="button" onClick={() => void handleRenameConfirm()} className="h-8 rounded-full bg-primary px-3.5 text-[12px] text-primary-foreground hover:bg-primary/90 transition-colors">确认</button>
            </div>
          </div>
        </div>
      ) : null}
      <HomeAgentConfirmDialog
        open={pendingDeleteSnapshot !== null}
        title={pendingDeleteSnapshot ? `删除《${pendingDeleteSnapshot.title}》？` : "删除当前会话？"}
        meta={
          pendingDeleteSnapshot
            ? `${pendingDeleteSnapshot.projectKind === "video" ? "视频工作流" : pendingDeleteSnapshot.projectKind === "adaptation" ? "参考改编" : "原创剧本"} · ${pendingDeleteSnapshot.derivedStage}`
            : undefined
        }
        description="这会同时移除本地会话记录、项目数据和恢复快照。删除后无法恢复，也不会把这次确认动作写入当前主会话。"
        pending={Boolean(pendingDeleteSnapshot && deletingProjectId === pendingDeleteSnapshot.projectId)}
        onOpenChange={(open) => {
          if (!open && !deletingProjectId) {
            setPendingDeleteSnapshot(null);
          }
        }}
        onConfirm={handleDeleteProjectConfirm}
      />
      {importPreviewState && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setImportPreviewState(null)}>
          <div className="w-[min(92vw,420px)] rounded-[20px] border border-border bg-card p-5 shadow-[0_24px_64px_rgba(0,0,0,0.3)]" onClick={(e) => e.stopPropagation()}>
            <div className="mb-1 text-[14px] font-medium text-foreground">导入聊天记录</div>
            <div className="mb-3 text-[12px] text-muted-foreground">{importPreviewState.preview.title}</div>
            <div className="mb-4 flex gap-4 text-[12px] text-muted-foreground">
              <span>{importPreviewState.preview.messageCount} 条消息</span>
              <span>{importPreviewState.preview.artifactCount} 个 artifact</span>
              {!importPreviewState.preview.isFullVersion && (
                <span className="text-yellow-500">旧版导出，部分内容可能不完整</span>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setImportPreviewState(null)} className="h-8 rounded-full px-3.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors">取消</button>
              <button type="button" onClick={() => void handleImportPreviewConfirm("new-project")} className="h-8 rounded-full border border-border px-3.5 text-[12px] text-foreground hover:bg-muted/40 transition-colors">新建项目</button>
              {importPreviewState.snapshot.projectId && (
                <button type="button" onClick={() => void handleImportPreviewConfirm("overwrite")} className="h-8 rounded-full bg-primary px-3.5 text-[12px] text-primary-foreground hover:bg-primary/90 transition-colors">覆盖当前项目</button>
              )}
            </div>
          </div>
        </div>
      )}
      {shouldUseMobileLayout ? (
        <React.Suspense fallback={<MobileSidebarFallback open={mobileNavOpen} />}>
          <LazyMobileSidebarSheet
            open={mobileNavOpen}
            onOpenChange={setMobileNavOpen}
            idle={idle}
            recentProjects={deferredRecentProjects}
            recentProjectSessions={runtime.recentProjectSessions}
            recentProjectsReady={recentProjectsReady}
            templates={sidebarTemplates}
            assets={deferredSidebarAssets}
            currentProjectId={activeProjectId}
            currentProjectSnapshot={runtime.currentProjectSnapshot}
            brandLabel={SIDEBAR_BRAND}
            sheetClassName={MOBILE_NAV_SHEET}
            onTemplateLaunch={handleTemplateLaunch}
            onOpenProject={handleOpenProject}
            onTogglePinProject={handleToggleProjectPin}
            onRenameProject={handleRenameProject}
            onDuplicateProject={handleDuplicateProject}
            onCleanExpiredVideos={handleCleanExpiredVideos}
            onDeleteProject={handleDeleteProject}
            onBulkDeleteProjects={handleBulkDeleteProjects}
            onExportChatHistory={handleExportChatHistory}
            onImportChatHistory={handleImportChatHistory}
            onOpenProjectFolder={handleOpenProjectFolder}
            onGlobalImportChatHistory={handleGlobalImportChatHistory}
            onNewProject={handleNewProject}
            onOpenSettings={handleToggleSettings}
            onRefreshProjects={handleRefreshProjects}
            isRefreshingProjects={isRefreshingProjects}
            onDeleteAsset={handleDeleteAsset}
            onUploadCharacterAudioReference={handleUploadCharacterAudioReferenceFromSidebar}
            onRemoveCharacterAudioReference={handleRemoveCharacterAudioReferenceFromSidebar}
            onRefreshSegmentContinuity={handleRefreshSegmentContinuityAsset}
            highlightedAssetId={sidebarAssetFocus?.assetId}
            highlightedAssetMessage={sidebarAssetFocus?.message}
            automationMode={historyAutomationMode}
            fullAutoRunStatus={runtime.fullAutoRun?.status ?? null}
          />
        </React.Suspense>
      ) : (
        <React.Suspense
          fallback={
            <DesktopSidebarFallback
              collapsed={desktopSidebarCollapsed}
              expandedWidth={sidebarWidth}
              collapsedWidth={DESKTOP_SIDEBAR_COLLAPSED_WIDTH}
            />
          }
        >
          <LazyDesktopSidebar
            idle={idle}
            recentProjects={deferredRecentProjects}
            recentProjectSessions={runtime.recentProjectSessions}
            recentProjectsReady={recentProjectsReady}
            templates={sidebarTemplates}
            assets={deferredSidebarAssets}
            currentProjectId={activeProjectId}
            currentProjectSnapshot={runtime.currentProjectSnapshot}
            collapsed={desktopSidebarCollapsed}
            brandLabel={SIDEBAR_BRAND}
            expandedWidth={sidebarWidth}
            collapsedWidth={DESKTOP_SIDEBAR_COLLAPSED_WIDTH}
            onWidthChange={handleSidebarWidthChange}
            onTemplateLaunch={handleTemplateLaunch}
            onOpenProject={handleOpenProject}
            onTogglePinProject={handleToggleProjectPin}
            onRenameProject={handleRenameProject}
            onDuplicateProject={handleDuplicateProject}
            onCleanExpiredVideos={handleCleanExpiredVideos}
            onDeleteProject={handleDeleteProject}
            onBulkDeleteProjects={handleBulkDeleteProjects}
            onExportChatHistory={handleExportChatHistory}
            onImportChatHistory={handleImportChatHistory}
            onOpenProjectFolder={handleOpenProjectFolder}
            onGlobalImportChatHistory={handleGlobalImportChatHistory}
            onNewProject={handleNewProject}
            onOpenSettings={handleToggleSettings}
            onToggleCollapse={handleToggleDesktopSidebar}
            onRefreshProjects={handleRefreshProjects}
            isRefreshingProjects={isRefreshingProjects}
            onDeleteAsset={handleDeleteAsset}
            onUploadCharacterAudioReference={handleUploadCharacterAudioReferenceFromSidebar}
            onRemoveCharacterAudioReference={handleRemoveCharacterAudioReferenceFromSidebar}
            onRefreshSegmentContinuity={handleRefreshSegmentContinuityAsset}
            highlightedAssetId={sidebarAssetFocus?.assetId}
            highlightedAssetMessage={sidebarAssetFocus?.message}
            automationMode={historyAutomationMode}
            fullAutoRunStatus={runtime.fullAutoRun?.status ?? null}
          />
        </React.Suspense>
      )}
      <DesktopSettingsPanel
        open={settingsOpen}
        onClose={handleCloseSettings}
        onSaved={handleSettingsSaved}
        leftOffset={desktopSidebarOffset}
        width={DESKTOP_SETTINGS_WIDTH}
      />
      <MobileSettingsSheet
        open={settingsOpen}
        onOpenChange={handleSettingsOpenChange}
        onSaved={handleSettingsSaved}
      />

      <div className="relative z-10 flex min-h-screen flex-col">
        {shouldUseMobileLayout ? (
          <MobileTopbar
            idle={idle}
            brandLabel={SIDEBAR_BRAND}
            onOpenNavigation={handleOpenMobileNavigation}
          />
        ) : null}
        <main
          className={cn(
            "relative flex-1 overflow-x-visible overflow-y-visible px-3.5 transition-[padding-left] duration-300 ease-out motion-reduce:transition-none sm:px-4 md:px-8",
            idle ? "pb-0 pt-4 lg:pl-[var(--home-sidebar-offset)]" : "pb-0 pt-2 lg:pl-[var(--home-sidebar-offset)]",
          )}
          style={
            {
              "--home-sidebar-offset": `${desktopSidebarOffset}px`,
              transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
              willChange: "padding-left",
            } as React.CSSProperties
          }
        >
          {maintenanceHints.length ? (
            <div className="pointer-events-none fixed right-3 top-3 z-[90] flex w-[min(78vw,360px)] flex-col gap-2 sm:right-4 sm:top-4 md:right-6">
              <AnimatePresence initial={false}>
                {maintenanceHints
                  .slice()
                  .reverse()
                  .map((hint) => (
                    <motion.div
                      key={hint.id}
                      layout
                      data-testid="home-maintenance-hint-panel"
                      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -10, scale: 0.985 }}
                      animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
                      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -14, scale: 0.975 }}
                      transition={{
                        duration: reduceMotion ? 0.14 : 0.28,
                        ease: [0.22, 1, 0.36, 1],
                      }}
                      className={cn(
                        "pointer-events-auto rounded-[20px] border px-3.5 py-3 shadow-[0_18px_48px_rgba(0,0,0,0.22)] backdrop-blur-xl",
                        "text-[12px] leading-[1.55] transition-all duration-200 ease-out",
                        hint.tone !== "error" && "border-border/35 bg-background/92 text-foreground/88",
                        hint.tone === "error" &&
                          "border-rose-400/24 bg-rose-500/[0.09] text-rose-50 dark:text-rose-100",
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div
                            className={cn(
                              "text-[10px] font-medium uppercase tracking-[0.18em]",
                              hint.tone !== "error" && "text-muted-foreground/70",
                              hint.tone === "error" && "text-rose-100/70",
                            )}
                          >
                            {hint.tone === "error" ? "处理失败" : "系统提示"}
                          </div>
                          <div className="mt-1 break-words">{hint.message}</div>
                        </div>
                        <button
                          type="button"
                          aria-label="关闭提示"
                          className={cn(
                            "mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full transition",
                            hint.tone !== "error" && "text-muted-foreground/70 hover:bg-muted/70 hover:text-foreground",
                            hint.tone === "error" && "text-rose-100/72 hover:bg-rose-400/12 hover:text-rose-50",
                          )}
                          onClick={() => dismissMaintenanceHint(hint.id)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </motion.div>
                  ))}
              </AnimatePresence>
            </div>
          ) : null}
          {idle ? (
            <IdleLanding composer={idleComposer} reduceMotion={reduceMotion} title={TITLE} trackClassName={IDLE_TRACK_CLASS} />
          ) : (
            <>
              <ActiveConversationShell
                conversationId={runtime.sessionId}
                messages={deferredMessages}
                tasks={deferredVisibleTasks}
                onStopTask={handleStopTask}
                endRef={endRef}
                scrollContainerRef={scrollContainerRef}
                onRequestOlderHistory={handleRequestOlderHistory}
                composer={activeComposer}
                streaming={streaming}
                suppressSyntheticStreamingMessage={suppressSyntheticStreamingMessage}
                hasUnreadMessage={hasUnreadMessage}
                trackClassName={ACTIVE_TRACK_CLASS}
                snapshot={currentProject}
                workflowProgress={workflowProgress}
                fullAutoRun={runtime.fullAutoRun ?? null}
                fullAutoChecklistCollapsed={fullAutoChecklistCollapsed}
                onFullAutoChecklistCollapsedChange={setFullAutoChecklistCollapsed}
                onStopFullAuto={handleStopFullAuto}
                onArtifactAction={(value, label, input, sourceSnapshot) => {
                  const actionSnapshot = sourceSnapshot ?? currentProject;
                  if (!actionSnapshot) return;

                  if (
                    actionSnapshot.projectKind === "video" &&
                    (videoProjectChoiceHandler(actionSnapshot, value, label) ||
                      videoAssetChoiceHandler(actionSnapshot, value, label))
                  ) {
                    return;
                  }

                  scriptProjectChoiceHandler(actionSnapshot, value, label, input);
                }}
                onSaveArtifactText={handleSaveArtifactText}
                onRelationshipDiagramCollapsedChange={handleRelationshipDiagramCollapsedChange}
                onEditUserMessage={handleEditUserMessage}
                onAssistantFeedback={handleAssistantFeedback}
                onRegenerateAssistant={handleRegenerateAssistant}
                onCreationGuidePick={handleCreationGuidePick}
              />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
