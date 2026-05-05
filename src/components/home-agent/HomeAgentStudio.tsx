import * as React from "react";
import { flushSync } from "react-dom";
import {
  Wand2,
  Compass,
  PanelsTopLeft,
} from "lucide-react";
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
  DesktopSidebar,
  MobileSidebarSheet,
} from "./home-agent-sidebar";
import {
  ActiveConversationShell,
  HomeSurfaceBackdrop,
  IdleLanding,
  MobileTopbar,
} from "./home-agent-shell";
import HomeAgentConfirmDialog from "./HomeAgentConfirmDialog";
import {
  areProjectSnapshotsEquivalent,
  areRecentSessionsEquivalent,
  buildProjectSuggestionKey,
  createInitialStudioSeed,
  hasSavedSessionContent,
  qStepKey,
  mergeRecentProjects,
} from "./home-agent-session-utils";
import { createQuestionState, textOf, toQuery } from "./home-agent-protocol-utils";
import {
  buildBeatPacketDecisionQuestion,
  buildBeatPacketListQuestion,
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
  listRunningVideoScenes,
  listUnlockedBeatPackets,
  listUnlockedCharacterCards,
  buildVideoBridgeRetryQuestion,
} from "./home-agent-project-questions";
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
import { useHomeAgentRuntimeActions } from "./use-home-agent-runtime-actions";
import { useHomeAgentRecoveryFlow } from "./use-home-agent-recovery-flow";
import { useHomeAgentQuestionView } from "./use-home-agent-question-view";
import { useHomeAgentShellHandlers } from "./use-home-agent-shell-handlers";
import { useHomeAgentSurfaceState } from "./use-home-agent-surface-state";
import {
  areTaskListsEquivalent,
  buildTaskResultMessage,
  isTaskVisibleForSession,
  parseTaskHeading,
  truncateCopy,
} from "./home-agent-task-utils";
import { useHomeAgentWorkflowShortcuts } from "./use-home-agent-workflow-shortcuts";
import { useHomeAgentComposerBindings } from "./use-home-agent-composer-bindings";
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
import { upsertStoredVideoProject } from "@/hooks/use-local-persistence";
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
  normalizeSidebarAssetPath,
} from "./home-agent-sidebar-utils";
import { resolveArtifactSnapshots } from "@/lib/home-agent/message-artifact-snapshots";
import {
  cacheProjectVideoSource,
  resolveVideoAttachmentSource,
} from "@/lib/home-agent/video-cache";
import { synchronizeVideoProductionState } from "@/lib/home-agent/video-production-memory";
import { isExpiredRemoteSignedMediaUrl } from "@/lib/home-agent/media-url";

const { useCallback, useEffect, useMemo, useRef, useState, startTransition } = React;

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
};
type IncomingAssetItem = {
  url: string;
  fileName: string;
  kind: "image" | "video";
  target?: AssetLibraryTarget;
  preferredTab?: "image" | "video";
  preferredImageSubTab?: AssetLibraryImageSubTab;
  isHistoricalVersion?: boolean;
};

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

const PROMPT = [
  "你是 InFinio 首页里的主控创作 Agent。",
  "所有推进都优先留在当前首页会话里完成，不要把用户推回模块页、步骤页或手动表单。",
  "当需要用户做选择、补参数或确认分支时，必须在同一轮调用 AskUserQuestion，给出可点击的结构化选项。",
  "当需要执行项目动作时调用 HomeStudioWorkflow；当适合并行研究或后台长任务时可以启动 Agent，但结果必须收口回当前会话。",
  "默认使用简体中文，回复简洁、专业，不暴露内部推理。",
  "每次回复都要明确引导下一步；如果用户输入含糊，不要猜测，改为继续追问。",
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
  "MANDATORY: Every reply must end with forward guidance 鈥?either call AskUserQuestion to show a decision popup, or append a short '涓嬩竴姝ワ細XXX' hint. Never leave the user without a clear next action.",
  "MANDATORY: Never expose internal reasoning, chain-of-thought, or self-check steps in the reply. Output conclusions and actions only. Never write '鎵ц鍔ㄤ綔:', '鎵ц鎿嶄綔:', tool names like 'AskUserQuestion' or 'HomeStudioWorkflow' as plain text, and never list option values (snake_case identifiers) as bullet points. Call tools directly 鈥?the UI renders them automatically.",
  "MANDATORY: NEVER output raw XML tool-call markup in your reply text. Do NOT write <function_calls>, <invoke>, <parameter>, or any similar XML tags as visible text. When you need to call a tool, call it as a structured tool call 鈥?never as inline XML text in the message.",
  "MANDATORY: Output must be complete and untruncated. Never cut off mid-sentence or use placeholders like '锛堢暐锛? or '锛堜互涓嬬渷鐣ワ級'. If content is long, split into complete readable paragraphs.",
  "MANDATORY: When the user's input is vague, ambiguous, or says things like '闅忎究'/'閮借'/'浣犲喅瀹?, do NOT guess 鈥?immediately call AskUserQuestion with 2-4 concrete options to help the user clarify.",
  "When information is missing, the workflow reaches a turning point, or a workflow action finishes, reply with a brief status summary and then use AskUserQuestion for the next choice.",
  "At every major decision or explicit tradeoff, do both in the same turn: explain the choices briefly in text and call AskUserQuestion so the popup appears.",
  "Do not assume the UI will auto-open a scripted next-step panel for you.",
  "Do not silently execute the next workflow action. Offer choices first.",
  "Proactively gather missing structured details through AskUserQuestion, following the same level of specificity as the dev-mode step popups such as duration, batch scope, export choices, and bridge decisions.",
  "MANDATORY: Do NOT front-load all required parameters at the start of a step. Use a progressive guidance approach: briefly introduce the current step's goal first, then collect key information one question at a time via AskUserQuestion. Never dump a list of required fields on the user before they understand what the step is about.",
  "MANDATORY: Even when the conversation goes severely off-track (topic drift, unrelated questions, tangents), do NOT abandon the workflow. First respond briefly to the user's current topic, then gently guide back to the paused workflow step 鈥?append a soft prompt like '椤轰究璇翠竴涓嬶紝鎴戜滑涔嬪墠鍦ㄥ仛 XXX锛岃缁х画鍚楋紵' and call AskUserQuestion to resume. Never give up on the workflow no matter how far the conversation drifts.",
  "If the user goes off-topic during a workflow or question flow, answer the user's current request first, then restore the paused step with AskUserQuestion at the end of the same reply.",
  "Do not treat free-text input or uploaded files as the answer to a paused workflow question unless the user explicitly confirms that intent.",
  "When a script is ready to move into video, keep the same conversation alive and guide the user step by step through the video workflow instead of treating it as a disconnected module.",
  "Every uploaded file must still receive an LLM response, even when you can only reason from extracted text, metadata, or a fallback digest.",
  "[Video Workflow LLM Rules]",
  "Video workflow is fully LLM-driven. You decide when to show popups and what options to offer based on what the user needs.",
  "Collect user config step by step through AskUserQuestion: platform goal, shot style, storyboard scope, prompt batch size, generation batch, refresh scope, and review decisions.",
  "When the user uploads a script document, analyze it strictly 鈥?do NOT add plot, characters, or scenes that are not in the uploaded content.",
  "At each video workflow stage transition (analyze 鈫?entities 鈫?storyboard 鈫?prompts 鈫?generate 鈫?review 鈫?export), use AskUserQuestion to confirm the user is ready and collect any missing parameters before calling HomeStudioWorkflow.",
  "Do not collapse multiple video workflow steps into a single broad question. Use one focused AskUserQuestion per decision point.",
  "If the user selects 'use-current-project', read the current drama project content, automatically write targetPlatform, shotStyle, and outputGoal, then continue into the video workflow without asking the user to run a separate prefix panel.",
  "[Image Generation Direct Call Rules]",
  "MANDATORY: When the user explicitly asks to generate character reference images, scene reference images, or any reference assets (e.g. '鐢熸垚瑙掕壊鍙傝€冨浘', '鐢熸垚鍦烘櫙鍙傝€冨浘', '鐢熸垚鍙傝€冭祫浜?, 'generate reference images', 'generate character images'), you MUST immediately call HomeStudioWorkflow with action='generate_video_reference_assets'. Do NOT use advance_video_workflow for this.",
  "MANDATORY: When the user explicitly asks to generate storyboard frames or storyboard images (e.g. '鐢熸垚鍒嗛暅鍥?, '鐢熸垚鍒嗛暅', 'generate storyboard', 'generate storyboard frames'), you MUST immediately call HomeStudioWorkflow with action='generate_storyboard_frames'. Do NOT use advance_video_workflow for this.",
  "These two actions are direct image generation calls 鈥?they call the image generation API immediately. Use them whenever the user's intent is clearly to generate images, without waiting for advance_video_workflow to decide.",
  "If the user says '甯垜鐢熷浘', '鐢熸垚鍥剧墖', or any similar phrasing in a video project context, determine from context whether they mean reference assets or storyboard frames, then call the appropriate action directly.",
  "MANDATORY: When the user asks to generate a single image from a text description (e.g. '甯垜鐢讳竴寮犲浘', '鐢熸垚涓€寮犲浘鐗?, '鏍规嵁杩欐鎻忚堪鐢熸垚鍥?, 'generate an image of ...'), call HomeStudioWorkflow with action='generate_project_image' and pass the visual description as imagePrompt. IMPORTANT: if the image is of a character, person, or portrait, also pass imageKind='character'; if it is a scene, environment, or background, pass imageKind='scene' (or omit it). The generated image will automatically appear in the chat 鈥?do NOT describe the image in text after calling the tool.",
  "OVERRIDE: generate_video_reference_assets, generate_storyboard_frames, and generate_project_image are asset-creation actions. They must go straight to the generation tool call. Do NOT call query_asset_status before these actions.",
  "[Script Breakdown Pre-collection Rules]",
  "MANDATORY: When the user's intent is to do script breakdown (鎷嗚В鍓ф湰 / analyze script / start breakdown), you MUST immediately call AskUserQuestion 鈥?do NOT output text saying 'I need to collect parameters first' without actually calling the tool. Outputting text instead of calling the tool is a violation.",
  "MANDATORY: Before executing the script breakdown (鎷嗚В鍓ф湰) action, collect two parameters via AskUserQuestion in sequence: (1) Episode duration (鍗曢泦鏃堕暱) 鈥?options: 60s / 90s / 120s / 鑷畾涔? If the user selects 鑷畾涔? immediately call AskUserQuestion again to prompt the user to type a custom duration value; wait for that input before proceeding. (2) Video pace (瑙嗛鑺傚) 鈥?options: 鎱㈤€?(2~4 shots/segment) / 涓瓑 (3~5 shots/segment) / 蹇€?(4~6 shots/segment). Only after BOTH parameters are confirmed, call HomeStudioWorkflow with action='analyze_script_for_video', videoPace, and episodeDuration. If either parameter is missing or skipped, re-ask before executing.",
  "NOTE: The system panel's '瀹屾垚鍓ф湰鎷嗚В'/'鎷嗚В鑴氭湰' button is handled by the UI layer with its own parameter collection popups 鈥?the LLM does NOT need to handle that path. The LLM only needs to handle cases where the user triggers breakdown intent via text input or AskUserQuestion option selection.",
  "MANDATORY: When exporting storyboard (瀵煎嚭鍒嗛暅), the format is always xlsx. Pass xlsx as the format parameter directly 鈥?do not offer other format options.",
  "[Material Package Check Rules]",
  "MANDATORY: The ONLY valid source of truth for asset existence is the asset library (assetManifest). Assets generated inside the current video workflow are automatically synchronized into assetManifest, and manually added library assets are valid too. Raw project fields like imageUrl, storyboardUrl, and videoUrl are NOT valid indicators on their own.",
  "IMPORTANT: For the current video workflow, newly generated reference images, storyboard frames, and generated videos are automatically synchronized into assetManifest. Manual '鍔犲叆绱犳潗搴? is still allowed, but not required for assets that were just generated inside the project workflow.",
  "MANDATORY: NEVER infer or assume asset existence from memory, context, or project fields. Before any step that depends on assets, call HomeStudioWorkflow with action='query_asset_status' to get the real asset library status.",
  "OVERRIDE: query_asset_status only applies when a step needs to consume assets that should already exist in the asset library, such as generate_video_assets, review, export, or explicit asset-library inspection. It does NOT apply to generate_video_reference_assets, generate_storyboard_frames, or generate_project_image.",
  "If the library HAS the required assets: show the returned table to the user, then call AskUserQuestion to ask what to do next.",
  "If the library is EMPTY or MISSING required assets: clearly tell the user which assets still need to be generated or synchronized first. Newly generated workflow assets will automatically appear in the library 鈥?call AskUserQuestion to guide this step.",
  "NEVER advance to a downstream step when the asset library does not have the required assets.",
  "MANDATORY: When the user explicitly asks to generate video and storyboard/material assets are ready, call HomeStudioWorkflow with action='generate_video_assets'. The tool will show '正在生成视频，请稍等…' in the chat, and completed video cards will display automatically in the assistant bubble; do not tell the user to leave the homepage or open another module.",
].join("\n");

const MOBILE_NAV_SHEET =
  "w-full border-r border-border bg-background p-0 text-foreground shadow-[18px_0_48px_rgba(0,0,0,0.2)] overscroll-contain sm:max-w-[360px]";
const IDLE =
  "和 Agent 说出你的目标，例如：我想做一部面向女性市场的都市反转短剧，请一步一步带我完成。";
const ACTIVE =
  "继续补充目标、修改意见、素材条件或你想推进的下一步，整个生产都会在这一页完成。";
const CUSTOM = "也可以跳过上方建议，直接输入你的自定义回答。";
const TITLE = "InFinio-一站式智能体自动化平台";
const SIDEBAR_BRAND = "InFinio";
const DESKTOP_SIDEBAR_WIDTH = 272;
const DESKTOP_SIDEBAR_COLLAPSED_WIDTH = 80;
const DESKTOP_SIDEBAR_OFFSET = 296;
const DESKTOP_SIDEBAR_COLLAPSED_OFFSET = 108;
const DESKTOP_SETTINGS_WIDTH = 456;
const DESKTOP_SIDEBAR_COLLAPSE_KEY = "storyforge-home-agent-desktop-sidebar-collapsed-v1";
const DESKTOP_SIDEBAR_WIDTH_KEY = "infinio-sidebar-width-v1";
const DESKTOP_SIDEBAR_MIN_WIDTH = 200;
const DESKTOP_SIDEBAR_MAX_WIDTH = 480;
const ACTIVE_TRACK_CLASS = "max-w-[820px]";
const IDLE_TRACK_CLASS = "max-w-[800px]";
type RuntimeTask = Task;
type DreaminaCapabilityState = {
  ready: boolean;
  available: boolean;
  message?: string;
};

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
): HomeAgentMessage => ({
  id: crypto.randomUUID(),
  role,
  content,
  createdAt: new Date().toISOString(),
  status: "complete",
  ...(artifactIds?.length ? { artifactIds } : {}),
  ...(artifactSnapshots?.length ? { artifactSnapshots } : {}),
  ...(attachments?.length ? { attachments } : {}),
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

function buildVideoMediaMessageV2(detail: {
  count?: number;
  model?: string;
  resolution?: string;
  provider?: string;
  mode?: string;
  contentSummary?: string;
  videoLabels?: string[];
}) {
  const count = Math.max(1, detail.count ?? 1);
  const isMultiple = count > 1;
  const modeLabel = localizeMediaSettingValue(detail.mode, "mode") || "\u89c6\u9891\u751f\u6210";
  const detailLine =
    isMultiple && detail.videoLabels?.length
      ? detail.videoLabels.length <= 3
        ? formatMediaDetailLine([`${count} \u6761\u89c6\u9891`, ...detail.videoLabels])
        : [`${count} \u6761\u89c6\u9891`, ...detail.videoLabels.map((label) => `- ${label}`)].join("\n")
      : formatMediaDetailLine([
          `${count} \u6761\u89c6\u9891`,
          detail.contentSummary ? `\u5185\u5bb9 ${detail.contentSummary}` : "",
          `\u6a21\u5f0f ${modeLabel}`,
          detail.provider ? `\u901a\u9053 ${localizeMediaSettingValue(detail.provider, "provider")}` : "",
        ]);

  // \u590d\u6570\u65f6\u6807\u9898\u4e0d\u8ffd\u52a0\u8d44\u4ea7\u540d\u79f0\uff0c\u5355\u6761\u65f6\u663e\u793a
  const headingContentSummary = isMultiple ? undefined : detail.contentSummary;

  return {
    start: [
      buildCompactMediaStatusHeadingV2({
        phase: "start",
        fallbackLabel: "\u89c6\u9891",
        contentSummary: headingContentSummary,
      }),
      detailLine,
    ]
      .filter(Boolean)
      .join("\n"),
    done: [
      buildCompactMediaStatusHeadingV2({
        phase: "done",
        fallbackLabel: "\u89c6\u9891",
        contentSummary: headingContentSummary,
      }),
      detailLine,
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
  return JSON.stringify([
    attachment.kind,
    attachment.localPath || "",
    attachment.previewUrl || "",
    attachment.fileName || "",
  ]);
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

function buildPendingMediaStreamLabel(params: {
  fallbackLabel: string;
  contentSummary?: string;
}) {
  const primaryLabel = extractCompactMediaContentLabel(params.contentSummary);
  return primaryLabel ? `\u6b63\u5728\u751f\u6210${primaryLabel}` : `\u6b63\u5728\u751f\u6210${params.fallbackLabel}`;
}

export default function HomeAgentStudio({ initialUtility, onUtilityChange }: Props) {
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
  const [devMode, setDevMode] = useState<boolean>(session?.devMode ?? readStoredDevMode());
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
  const lastSuggestedRef = useRef<ComposerQuestion | null>(null);
  const [popoverOverride, setPopoverOverride] = useState<ComposerQuestion | null>(() => {
    const stored = session?.pendingChoiceQuestion ?? null;
    if (!stored || stored.answerKey !== "video-bridge-panel") return stored;
    const currentMode =
      seedRef.current?.runtime.currentVideoProject?.videoGenerationPrefs?.mode ??
      DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.mode;
    const isT2V = stored.id.endsWith("-t2v");
    const compatible = currentMode === "text-to-video" ? isT2V : !isT2V;
    return compatible ? stored : null;
  });
  const [selectedValues, setSelectedValues] = useState<string[]>(session?.selectedValues ?? []);
  const [deferredSelectedValues, setDeferredSelectedValues] = useState<string[]>(
    session?.deferredSelectedValues ?? [],
  );
  const [draftInitialValue, setDraftInitialValue] = useState(session?.draft ?? "");
  const [draftResetVersion, setDraftResetVersion] = useState(0);
  const [draftPresence, setDraftPresence] = useState(Boolean(session?.draft?.trim()));
  const [persistedDraft, setPersistedDraft] = useState(session?.draft ?? "");
  const [deferredDraft, setDeferredDraft] = useState(session?.deferredDraft ?? "");
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
  const [maintenanceHint, setMaintenanceHint] = useState<string | null>(null);
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
  const [dreaminaCapability, setDreaminaCapability] = useState<DreaminaCapabilityState>({
    ready: false,
    available: false,
  });
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [awaitingVideoKickoffStyleReferenceUpload, setAwaitingVideoKickoffStyleReferenceUpload] = useState(false);

  useEffect(() => {
    writeStoredCreationMode(creationMode);
  }, [creationMode]);

  useEffect(() => {
    writeStoredDevMode(devMode);
  }, [devMode]);
  useEffect(() => {
    if (runtime.currentProjectSnapshot?.projectKind === "video") return;
    pendingVideoKickoffStyleReferenceUploadRef.current = null;
    setAwaitingVideoKickoffStyleReferenceUpload(false);
  }, [runtime.currentProjectSnapshot?.projectId, runtime.currentProjectSnapshot?.projectKind]);

  // 鍚屾 activeProjectId 鍒?localStorage锛屼緵 uploadImageToStorage 绛夊伐鍏峰嚱鏁拌鍙?
  useEffect(() => {
    if (activeProjectId) {
      localStorage.setItem("storyforge_current_project", activeProjectId);
    }
  }, [activeProjectId]);

  const runtimeRef = useRef(runtime);
  const messagesRef = useRef(messages);
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
  // 璁板綍鐢ㄦ埛涓诲姩鏀惧純鐨勯」鐩?ID锛岄槻姝㈠叾鍚庡彴 delta 浜嬩欢姹℃煋鏂伴」鐩潰鏉?
  const staleProjectIdsRef = useRef<Set<string>>(new Set());
  // 防止 workflow shortcut 和后台轮询同时 dispatch agent:video-generated 导致重复消息
  const recentlyProcessedVideoUrlsRef = useRef<Set<string>>(new Set());
  const surfacedDreaminaHintRef = useRef(false);
  const maintenanceHintTimerRef = useRef<number | null>(null);
  const compactionJobVersionRef = useRef(0);
  const selectedTextModelKeyRef = useRef(selectedTextModelKey);
  // 鍒囨崲椤圭洰鍓嶅悓姝?flush 褰撳墠浼氳瘽锛岄槻姝㈤槻鎶栦繚瀛樿鍙栨秷瀵艰嚧鐘舵€佷涪澶?
  const flushSessionRef = useRef<() => void>(() => {});
  const previousQuestionStepRef = useRef<string | null>(
    session?.qState ? `${session.qState.request.id}:${session.qState.currentIndex}` : null,
  );
  const interruptRestoreQuestionRef = useRef<ComposerQuestion | null>(null);
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
  }, [activeProjectId]);
  const {
    loadEngineDeps,
    loadProjectStore,
    loadApiConfigModule,
    loadAskUserQuestionModule,
    loadStructuredQuestionParser,
    loadWorkflowActionsModule,
    loadSemanticSummaryModule,
    loadConversationMemoryModule,
    loadDreaminaCliModule,
  } = useHomeAgentModuleLoaders();

  const { currentProject, question } = useHomeAgentQuestionView({
    runtime,
    qState,
    popoverOverride,
    suggested,
    selectedValues,
    dismissedProjectSuggestionKeys: dismissedProjectSuggestionKeysRef.current,
    dismissedQuestionStepKey: dismissedDeferredQuestionStepRef.current,
    devMode,
  });
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
    setMaintenanceHint,
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
  const { hasUnreadMessage } = useSmartScroll({
    containerRef: scrollContainerRef,
    endRef,
    active: !idle,
    forceBottomDependency:
      lastMessageForScroll?.role === "user" ||
      (lastMessageForScroll?.role === "assistant" && lastMessageHasMedia)
        ? `${lastMessageForScroll.id}:${lastMessageForScroll.content.length}:${lastAttachmentScrollKey}`
        : null,
    followTargetSelector: "[data-home-agent-message-row]",
    followTargetOffsetRatio: 0.36,
    resetKey: activeProjectId ?? runtime.currentProjectSnapshot?.projectId ?? null,
    showUnreadOnBlocked: lastMessageForScroll?.role === "assistant",
    dependency: `${messages.length}:${lastMessageForScroll?.id ?? ""}:${lastMessageForScroll?.content.length ?? 0}:${lastAttachmentScrollKey}:${streaming ? "streaming" : "idle"}`,
  });
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
        return {
          ...template,
          badge: "待定",
          disabled: true,
          description: "全自动入口待开放，第一版先支持原创剧本。",
        };
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
        if ((draftRef.current || persistedDraft) === seedDraft) {
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
      setPopoverOverride(resolvedQuestion);
      return true;
    },
    [
      resetComposerDraft,
      setMode,
      setPopoverOverride,
      setQState,
      setSelectedValues,
      setSuggested,
    ],
  );

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
    setPopoverOverride(nextQuestion);
    return true;
  }, [
    draftPresence,
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

  const commitEffectiveImagePrefs = useCallback(
    async (nextPrefsInput: Partial<VideoImageGenerationPrefs>) => {
      const nextPrefs = normalizeVideoImageGenerationPrefs(nextPrefsInput);
      setSelectedImageModelFamily(nextPrefs.familyKey);
      setImageGenerationPrefs(nextPrefs);
      writeStoredHomeAgentImageGenerationPrefs(nextPrefs);

      const currentVideoProject = runtimeRef.current.currentVideoProject;
      if (!currentVideoProject) {
        return;
      }

      const nextProject = await upsertStoredVideoProject({
        ...currentVideoProject,
        artStyle: resolveVideoImageProjectArtStyle(
          nextPrefs,
          currentVideoProject.artStyle || "live-action",
        ),
        imageGenerationPrefs: nextPrefs,
        styleLock: null,
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

  const handleRecognizeImageStyle = useCallback(async () => {
    const imageFiles = attachedFiles.filter(isSupportedImageFile);
    if (!imageFiles.length) {
      throw new Error("请先上传至少一张图片参考图。");
    }
    return analyzeHomeAgentImageStyleFiles(imageFiles, {
      userPrompt: draftRef.current || persistedDraft || "识别当前上传参考图的画面风格。",
    });
  }, [attachedFiles, persistedDraft]);

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

  useEffect(() => {
    const handleAutomationModeUpdated = (event: Event) => {
      const mode = normalizeAutomationMode(
        (event as CustomEvent<{ mode?: AutomationMode }>).detail?.mode ?? readStoredAutomationMode(),
      );
      setAutomationMode(mode);
    };
    window.addEventListener(HOME_AGENT_AUTOMATION_MODE_EVENT, handleAutomationModeUpdated as EventListener);
    return () =>
      window.removeEventListener(HOME_AGENT_AUTOMATION_MODE_EVENT, handleAutomationModeUpdated as EventListener);
  }, []);

  const push = useCallback((
    role: HomeAgentMessage["role"],
    content: string,
    artifactIds?: string[],
    attachments?: ChatAttachment[],
    artifactSnapshots?: import("@/lib/home-agent/types").ConversationArtifact[],
  ) => {
    if (!content.trim()) return null;
    const resolvedArtifactSnapshots =
      artifactSnapshots?.length
        ? artifactSnapshots
        : resolveArtifactSnapshots(runtimeRef.current.currentProjectSnapshot, artifactIds);
    const trimmedContent = content.trim();
    const message = {
      ...mk(role, trimmedContent, artifactIds, attachments, resolvedArtifactSnapshots),
      ...(role === "user" && (trimmedContent.startsWith("全自动：") || trimmedContent.startsWith("AI代理："))
        ? { automationOrigin: "full-auto" as const }
        : {}),
    };
    setMessages((prev) => [
      ...prev,
      message,
    ]);
    return message.id;
  }, []);

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

      startTransition(() => {
        setRuntime((previous) => mergeRuntimeWithWorkflowDelta(previous, delta));
        setActiveProjectId(nextSnapshot.projectId);
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
  }, [activeProjectId, setActiveProjectId, setRuntime]);

  // 鐩戝惉鍥剧墖鐢熸垚寮€濮嬩簨浠讹紝娉ㄥ叆甯﹀崰浣嶇鐨?pending 娑堟伅
  useEffect(() => {
    const handleImageGeneratingStart = (event: Event) => {
      const detail = ((event as CustomEvent<{
        count: number;
        action: string;
        modelFamily?: string;
        resolution?: string;
        aspectRatio?: string;
        contentSummary?: string;
        targetLabels?: string[];
      }>).detail ?? {}) as Partial<{
        count: number;
        action: string;
        modelFamily?: string;
        resolution?: string;
        aspectRatio?: string;
        contentSummary?: string;
        targetLabels?: string[];
      }>;
      const { count = 1, action = "" } = detail;
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
        actionLabel?: string;
        action?: string;
        count?: number;
        modelFamily?: string;
        resolution?: string;
        aspectRatio?: string;
        contentSummary?: string;
      }>;
      const { imageUrls, imageLabels, actionLabel } = detail;
      const successUrls = imageUrls ?? [];

      const attachments: ChatAttachment[] = await Promise.all(
        successUrls.map(async (url, index) => {
          let previewUrl: string | undefined;
          if (url.startsWith("data:")) {
            previewUrl = url;
          } else if (url.startsWith("http://") || url.startsWith("https://")) {
            previewUrl = url;
          } else if (isLocalSidebarAssetUrl(url)) {
            const normalizedPath = normalizeSidebarAssetPath(url);
            const result = await window.electronAPI?.storage?.readBase64?.(normalizedPath);
            if (result?.ok && result?.base64) {
              previewUrl = `data:${result.mimeType || "image/jpeg"};base64,${result.base64}`;
            }
          }
          const perImageLabel = imageLabels?.[index];
          const baseName = perImageLabel
            ? perImageLabel
            : actionLabel
              ? successUrls.length > 1
                ? `${actionLabel}_${index + 1}`
                : actionLabel
              : (url.split(/[\/]/).pop()?.replace(/\.[^.]+$/, "") ??
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
        const lastPendingIdx = [...prev].reverse().findIndex(
          (m) =>
            m.role === "assistant" &&
            m.status === "pending" &&
            m.attachments?.some((a) => a.kind === "image"),
        );

        if (lastPendingIdx !== -1) {
          const idx = prev.length - 1 - lastPendingIdx;
          const target = prev[idx];
          // 保留已成功（real）和已失败（failed）的 attachment，丢弃仍 pending 的
          const existingSettled = (target?.attachments ?? []).filter(
            (a) => a.kind === "image" && !a.pending && !a.cancelled,
          );
          // 如果有逐张写入的结果（成功或失败），优先用它们；否则用最终批量 attachments
          const rawAttachments = existingSettled.length > 0 ? existingSettled : attachments;
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
        const realMsg = mk("assistant", mediaCopy.done, undefined, attachments);
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
      const detail = ((event as CustomEvent<{ url: string; label?: string; index: number }>).detail ?? {}) as Partial<{ url: string; label?: string; index: number }>;
      const { url, label, index } = detail;
      if (!url) return;

      let previewUrl: string | undefined;
      if (url.startsWith("data:")) {
        previewUrl = url;
      } else if (url.startsWith("http://") || url.startsWith("https://")) {
        previewUrl = url;
      } else if (isLocalSidebarAssetUrl(url)) {
        const normalizedPath = normalizeSidebarAssetPath(url);
        const result = await window.electronAPI?.storage?.readBase64?.(normalizedPath);
        if (result?.ok && result?.base64) {
          previewUrl = `data:${result.mimeType || "image/jpeg"};base64,${result.base64}`;
        }
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
      };

      setMessages((prev) => {
        const lastPendingIdx = [...prev].reverse().findIndex(
          (m) =>
            m.role === "assistant" &&
            m.status === "pending" &&
            m.attachments?.some((a) => a.kind === "image"),
        );
        if (lastPendingIdx === -1) return prev;

        const msgIdx = prev.length - 1 - lastPendingIdx;
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
      const detail = ((event as CustomEvent<{ index: number; label?: string; reason?: string }>).detail ?? {}) as Partial<{ index: number; label?: string; reason?: string }>;
      const { index, label, reason } = detail;
      const failureReason = resolveImageFailureReason(reason);

      setMessages((prev) => {
        const lastPendingIdx = [...prev].reverse().findIndex(
          (m) =>
            m.role === "assistant" &&
            m.status === "pending" &&
            m.attachments?.some((a) => a.kind === "image"),
        );
        if (lastPendingIdx === -1) return prev;

        const msgIdx = prev.length - 1 - lastPendingIdx;
        const target = prev[msgIdx];
        if (!target?.attachments) return prev;

        const imageAttachments = target.attachments.filter((a) => a.kind === "image");
        const targetPlaceholder = imageAttachments[index];
        if (!targetPlaceholder) return prev;

        const next = [...prev];
        next[msgIdx] = {
          ...target,
          attachments: target.attachments.map((a) =>
            a.id === targetPlaceholder.id
              ? { ...a, pending: false, failed: true, failureReason, label: label || a.label }
              : a,
          ),
        };
        return next;
      });
    };
    window.addEventListener("agent:image-generated-one-failed", handleImageGeneratedOneFailed as EventListener);
    return () => window.removeEventListener("agent:image-generated-one-failed", handleImageGeneratedOneFailed as EventListener);
  }, []);

  useEffect(() => {
    const handleImageGeneratingCancelled = () => {
      setMessages((prev) => {
        const lastPendingIdx = [...prev].reverse().findIndex(
          (m) =>
            m.role === "assistant" &&
            m.status === "pending" &&
            m.attachments?.some((a) => a.kind === "image" && a.pending),
        );
        if (lastPendingIdx === -1) return prev;

        const idx = prev.length - 1 - lastPendingIdx;
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
          model?: string;
          resolution?: string;
          provider?: string;
          mode?: string;
          aspectRatio?: string;
          contentSummary?: string;
          targetLabels?: string[];
        }>).detail ?? {}) as Partial<{
          count?: number;
          sceneCount?: number;
          action?: string;
          model?: string;
          resolution?: string;
          provider?: string;
          mode?: string;
          aspectRatio?: string;
          contentSummary?: string;
          targetLabels?: string[];
        }>;
      const count = Math.max(1, Math.min(6, detail.sceneCount ?? detail.count ?? 1));
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
        provider: detail.provider,
        mode: detail.mode,
        contentSummary: detail.contentSummary,
        videoLabels: targetLabels,
      });
      setMessages((prev) => [
        ...prev,
        {
          ...mk("assistant", mediaCopy.start, undefined, placeholderAttachments),
          status: "pending" as const,
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
          count?: number;
          model?: string;
          resolution?: string;
          provider?: string;
          mode?: string;
          contentSummary?: string;
        }>).detail ?? {}) as Partial<{
          videoUrls: string[];
          count?: number;
          model?: string;
          resolution?: string;
          provider?: string;
          mode?: string;
          contentSummary?: string;
        }>;
      const { videoUrls: rawVideoUrls } = detail;
      if (!rawVideoUrls?.length) return;

      // 去重：过滤掉近期已处理过的 URL，防止 workflow shortcut 和后台轮询双重 dispatch 导致重复消息
      const videoUrls = rawVideoUrls.filter(url => !recentlyProcessedVideoUrlsRef.current.has(url));
      // 若所有 URL 均已被 agent:video-generated-one 逐条处理，只需将 pending 消息标记为完成
      if (!videoUrls.length) {
        setMessages((prev) => {
          const lastPendingIdx = [...prev].reverse().findIndex(
            (m) => m.role === "assistant" && m.status === "pending" && m.attachments?.some((a) => a.kind === "video"),
          );
          if (lastPendingIdx === -1) return prev;
          const idx = prev.length - 1 - lastPendingIdx;
          const next = [...prev];
          next[idx] = { ...next[idx], status: "complete", streamLabel: undefined };
          return next;
        });
        reopenWorkflowPopupAfterMediaCompletion();
        return;
      }
      videoUrls.forEach(url => recentlyProcessedVideoUrlsRef.current.add(url));
      setTimeout(() => videoUrls.forEach(url => recentlyProcessedVideoUrlsRef.current.delete(url)), 30_000);

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
        const lastPendingIdx = [...prev].reverse().findIndex(
          (m) =>
            m.role === "assistant" &&
            m.status === "pending" &&
            m.attachments?.some((a) => a.kind === "video" && a.pending),
        );
        const mediaCopy = buildVideoMediaMessageV2({
          count: detail.count ?? videoUrls.length,
          model: detail.model,
          resolution: detail.resolution,
          provider: detail.provider,
          mode: detail.mode,
          contentSummary: detail.contentSummary,
        });
        if (lastPendingIdx !== -1) {
          const idx = prev.length - 1 - lastPendingIdx;
          const target = prev[idx];
          const realMsg = mk(
            "assistant",
            preserveExistingMediaDetailLines({
              existingContent: target?.content,
              nextContent: mediaCopy.done,
              preserveExistingDetails: !detail.contentSummary,
            }),
            undefined,
            attachments,
          );
          const next = [...prev];
          next[idx] = realMsg;
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
      const detail = ((event as CustomEvent<{ url: string; label?: string; index: number; sceneId?: string; projectId?: string; segmentLabel?: string }>).detail ?? {}) as Partial<{ url: string; label?: string; index: number; sceneId?: string; projectId?: string; segmentLabel?: string }>;
      const { url, label, index, sceneId, projectId: eventProjectId, segmentLabel } = detail;
      if (!url) return;

      // 标记为已处理，防止 agent:video-generated 最终事件重复创建消息
      recentlyProcessedVideoUrlsRef.current.add(url);
      setTimeout(() => recentlyProcessedVideoUrlsRef.current.delete(url), 30_000);

      const currentProjectId = eventProjectId ?? runtimeRef.current.currentProjectSnapshot?.projectId ?? activeProjectId;
      const rawFileName = url.split(/[\\/]/).pop()?.split("?")[0] || buildGeneratedMediaFallbackName("video", 1, 0);
      let urlFileName = rawFileName;
      try { urlFileName = decodeURIComponent(rawFileName); } catch { urlFileName = rawFileName; }
      const contentStem = label ? label.replace(/\s*·\s*版本\d+$/, "") : urlFileName.replace(/\.[^.]+$/, "");
      const fileName = contentStem ? `${contentStem}.mp4` : urlFileName;
      const cachedVideo = await cacheProjectVideoSource(url, fileName, currentProjectId);
      const fallbackVideo = resolveVideoAttachmentSource(url);

      const attachment: ChatAttachment = {
        id: crypto.randomUUID(),
        fileName,
        label: contentStem || undefined,
        mimeType: cachedVideo?.mimeType ?? "video/mp4",
        size: cachedVideo?.size ?? 0,
        kind: "video" as const,
        localPath: cachedVideo?.localPath ?? fallbackVideo.localPath,
        previewUrl: cachedVideo?.previewUrl ?? fallbackVideo.previewUrl,
        ...(segmentLabel && currentProjectId
          ? {
              generationContext: {
                action: "generate_segment_video" as const,
                projectId: currentProjectId,
                targetId: segmentLabel,
                regenerateMode: "redo-and-generate" as const,
              },
            }
          : sceneId && currentProjectId
          ? {
              generationContext: {
                action: "generate_video_assets" as const,
                projectId: currentProjectId,
                targetId: sceneId,
                regenerateMode: "redo-and-generate" as const,
              },
            }
          : {}),
      };

      setMessages((prev) => {
        const lastPendingIdx = [...prev].reverse().findIndex(
          (m) => m.role === "assistant" && m.status === "pending" && m.attachments?.some((a) => a.kind === "video"),
        );
        if (lastPendingIdx === -1) return prev;

        const msgIdx = prev.length - 1 - lastPendingIdx;
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
    const handleVideoGeneratingCancelled = () => {
      setMessages((prev) => {
        const lastPendingIdx = [...prev].reverse().findIndex(
          (m) =>
            m.role === "assistant" &&
            m.status === "pending" &&
            m.attachments?.some((a) => a.kind === "video" && a.pending),
        );
        if (lastPendingIdx === -1) return prev;

        const idx = prev.length - 1 - lastPendingIdx;
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
          !isExpiredRemoteSignedMediaUrl(asset.url),
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
          workingProject = applyAssetReplacement(workingProject, resolvedTarget, incoming);
          focusAssetId = deriveAssetIdFromTarget(resolvedTarget);
          focusMessage = incoming.kind === "video" ? "已替换当前视频素材" : "已替换当前图片素材";
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
                  },
                }
              : prev.currentProjectSnapshot,
        }));
      });

      if (nextFocusId && focusMessage) {
        setSidebarAssetFocus({ assetId: nextFocusId, message: focusMessage });
        flashMaintenanceHint(focusMessage, 2400);
      }
    };
    window.addEventListener("agent:add-to-assets", handleAddToAssets);
    return () => window.removeEventListener("agent:add-to-assets", handleAddToAssets);
  }, [flashMaintenanceHint, resolveAssetTargetFromLookup, setRuntime]);

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
        const url = item.url?.trim();
        if (!url || isExpiredRemoteSignedMediaUrl(url)) {
          invalidIds.push(item.id);
          continue;
        }
        if (isLocalSidebarAssetUrl(url) && window.electronAPI?.storage?.readBase64) {
          const result = await window.electronAPI.storage.readBase64(normalizeSidebarAssetPath(url));
          if (result?.exists === false) {
            invalidIds.push(item.id);
          }
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
    resolveDreaminaCapability,
    send,
    reset,
    answer,
    handleTemplateLaunch,
    autoResearchChoiceHandler,
    handleFullAutoChoiceSelect,
    stopFullAutoExecution,
    stopActiveExecution,
  } = useHomeAgentRuntimeActions({
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
    surfacedDreaminaHintRef,
    loadEngineDeps,
    loadApiConfigModule,
    loadStructuredQuestionParser,
    loadConversationMemoryModule,
    loadProjectStore,
    loadAskUserQuestionModule,
    loadDreaminaCliModule,
    loadWorkflowActionsModule,
    flashMaintenanceHint,
    resetComposerDraft,
    dreaminaCapability,
    setDreaminaCapability,
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
    activeProjectId,
    setDeferredDraft,
    lastSuggestedRef,
    backgroundResearchGroupsRef,
    selectedImageModelFamily,
    imageGenerationPrefs,
    selectedVideoModelKey,
    videoGenerationPrefs,
    restoreInterruptedChoiceQuestion,
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
          setActiveProjectId(nextSnapshot.projectId);
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
    [flashMaintenanceHint, loadWorkflowActionsModule, setActiveProjectId, setRuntime],
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
            const nextRecentProjects = sortConversationSnapshots(
              [nextSnapshot, ...prev.recentProjects.filter((item) => item.projectId !== nextSnapshot.projectId)],
            );

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
          const normalizedPath = normalizeSidebarAssetPath(url);
          const result = await window.electronAPI?.storage?.readBase64?.(normalizedPath);
          if (result?.ok && result?.base64) {
            previewUrl = `data:${result.mimeType || "image/jpeg"};base64,${result.base64}`;
            mimeType = result.mimeType || mimeType;
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

      if (attachmentId) {
        const message = list[idx];
        const attachment = message.attachments?.find((item) => item.id === attachmentId);
        if (!attachment) return;

        const target = resolveInlineAttachmentTarget(attachment);
        if (!target) {
          flashMaintenanceHint("这条素材暂时还无法精确映射到项目资产，请先从弹窗面板里重新生成一次。", 2600);
          return;
        }
        if (!target.projectId || !target.targetId) {
          flashMaintenanceHint("这条素材缺少项目定位信息，请先从弹窗面板里重新生成一次。", 2600);
          return;
        }

        const workflow = await loadWorkflowActionsModule();
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
          result: Awaited<ReturnType<typeof workflow.runWorkflowAction>>,
        ) => {
          if (!result.data) return currentRuntime;
          const nextRuntime = mergeRuntimeWithWorkflowDelta(currentRuntime, result.data);
          startTransition(() => {
            setRuntime(nextRuntime);
            if (nextRuntime.currentProjectSnapshot?.projectId) {
              setActiveProjectId(nextRuntime.currentProjectSnapshot.projectId);
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

        setInlineAttachmentPending(assistantMessageId, attachmentId, true);
        try {
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
          flashMaintenanceHint(error instanceof Error ? error.message : "鍘熷湴閲嶆柊鐢熸垚澶辫触", 2800);
        }
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

  const handleJimengExecutionModeChange = useCallback(
    async (nextMode: JimengExecutionMode) => {
      try {
        const apiConfig = await loadApiConfigModule();
        apiConfig.saveApiConfig({ jimengExecutionMode: nextMode });
        setJimengExecutionMode(nextMode);
        setSuppressedLaunchNoticeKey(null);

        if (nextMode === "cli") {
          const capability = await resolveDreaminaCapability();
          await refreshLaunchReadiness();
          flashMaintenanceHint(
            capability.available
              ? "已切到 Dreamina CLI，后续视频默认走本机登录态。"
              : "已切到 Dreamina CLI，但当前本机还未就绪。",
            2600,
          );
          return;
        }

        await refreshLaunchReadiness();
        flashMaintenanceHint("宸插垏鍒?Seedance API锛屽悗缁棰戦粯璁よ蛋 API", 2400);
      } catch (error) {
        flashMaintenanceHint(
          error instanceof Error ? error.message : "鍒囨崲瑙嗛杩愯閫氶亾澶辫触",
          2600,
        );
      }
    },
    [flashMaintenanceHint, loadApiConfigModule, refreshLaunchReadiness, resolveDreaminaCapability],
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
      label: jimengExecutionMode === "cli" ? "褰撳墠閫夋嫨 CLI" : "褰撳墠瀹為檯璧?API",
      detail: jimengExecutionMode === "cli" ? "Dreamina 鐘舵€佹鏌ヤ腑" : "Seedance API",
      tone: "neutral" as const,
    };
  }, [currentProject, deferredProjectSnapshot, jimengExecutionMode, launchReadiness?.video]);

  useHomeAgentBootstrapEffects({
    runtime,
    mode,
    metaReady,
    messages,
    compactedMessageCount,
    desktopSidebarCollapsed,
    dreaminaCapability,
    maintenanceHintTimerRef,
    draftPersistTimerRef,
    messagesRef,
    compactedMessageCountRef,
    surfacedTaskIdsRef,
    surfacedTaskFollowupIdsRef,
    surfacedDreaminaHintRef,
    setRuntime,
    setRecentProjectsReady,
    setMetaReady,
    setActiveProjectId,
    setTasks,
    loadProjectStore,
    resolveDreaminaCapability,
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
    popoverOverride,
    suggested,
    suppressVideoWorkflowSuggestions: awaitingVideoKickoffStyleReferenceUpload,
    draftPresence,
    persistedDraft,
    deferredDraft,
    recentSessionSummary,
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
  }, [
    deferredDraft,
    deferredQuestionState,
    deferredSelectedValues,
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
    const currentProjectId = runtime.currentProjectSnapshot?.projectId ?? activeProjectId;
    if (wasStreaming && !streaming && currentProjectId) {
      flushSessionRef.current();
    }
  }, [streaming, activeProjectId, runtime.currentProjectSnapshot?.projectId]);

  // 姣忔娓叉煋鏃舵洿鏂?flush 鍑芥暟锛岀‘淇濆垏鎹㈤」鐩墠鑳戒繚瀛樻渶鏂扮姸鎬?
  flushSessionRef.current = () => {
    const currentProjectId = runtimeRef.current.currentProjectSnapshot?.projectId ?? activeProjectId;
    if (!currentProjectId) return;
    const pendingChoiceQuestion =
      qState || deferredQuestionState
        ? null
        : (popoverOverride ?? suggested ?? null);
    writeStudioSession({
      sessionId: runtimeRef.current.sessionId,
      mode,
      creationMode,
      automationMode: normalizeAutomationMode(runtime.currentProjectSnapshot?.automationMode ?? automationMode),
      devMode,
      messages,
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
      draft: draftRef.current || persistedDraft,
      qState,
      deferredQuestionState,
      pendingChoiceQuestion,
      selectedValues,
      deferredSelectedValues,
      deferredDraft,
      surfacedTaskIds: [...surfacedTaskIdsRef.current],
      surfacedTaskFollowupKeys: [...surfacedTaskFollowupIdsRef.current],
      surfacedProjectSuggestionKeys: [...surfacedProjectSuggestionKeysRef.current],
      fullAutoRun: runtime.fullAutoRun ?? null,
    });
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

  const handleProjectSwitchInterrupt = useCallback(
    (nextProjectId: string) => {
      if (!activeProjectId || activeProjectId === nextProjectId) return;
      if (!activeWorkflowAction) return;

      const activeSnapshot = runtimeRef.current.currentProjectSnapshot;
      const retryQuestion =
        activeWorkflowAction === "video:bridge:platform"
          ? buildVideoBridgeRetryQuestion(activeSnapshot)
          : null;

      interruptRestoreQuestionRef.current = null;
      stopActiveExecution();
      interruptWorkflowShortcutRef.current();
      stopRunningTasks();

      if (!retryQuestion) return;

      void writeProjectStudioSession({
        sessionId: runtimeRef.current.sessionId,
        mode,
        creationMode,
        automationMode: normalizeAutomationMode(activeSnapshot?.automationMode ?? automationMode),
        devMode,
        messages,
        currentProjectSnapshot: activeSnapshot
          ? {
              ...activeSnapshot,
              automationMode: normalizeAutomationMode(activeSnapshot.automationMode ?? automationMode),
            }
          : null,
        recentMessageSummary: runtimeRef.current.recentMessageSummary,
        projectId: activeProjectId,
        selectedTextModelKey,
        selectedImageModelFamily,
        imageGenerationPrefs,
        selectedVideoModelKey,
        videoGenerationPrefs,
        compactedMessageCount,
        draft: draftRef.current || persistedDraft,
        qState: null,
        deferredQuestionState: null,
        pendingChoiceQuestion: retryQuestion,
        selectedValues: [],
        deferredSelectedValues: [],
        deferredDraft: "",
        surfacedTaskIds: [...surfacedTaskIdsRef.current],
        surfacedTaskFollowupKeys: [...surfacedTaskFollowupIdsRef.current],
        surfacedProjectSuggestionKeys: [],
        fullAutoRun: runtimeRef.current.fullAutoRun ?? null,
      });
    },
    [
      activeProjectId,
      activeWorkflowAction,
      compactedMessageCount,
      creationMode,
      devMode,
      imageGenerationPrefs,
      messages,
      mode,
      persistedDraft,
      selectedImageModelFamily,
      selectedTextModelKey,
      selectedVideoModelKey,
      stopActiveExecution,
      stopRunningTasks,
      videoGenerationPrefs,
    ],
  );

  const { openProject, cancelPendingProjectOpen } = useHomeAgentRecoveryFlow({
    handoffRef,
    engineRef,
    loadProjectStore,
    flushSessionRef,
    beforeProjectOpen: handleProjectSwitchInterrupt,
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
    setPopoverOverride,
    setSuggested,
    setSelectedValues,
    setDeferredSelectedValues,
    setStreaming,
    setMode,
    setMessages,
    setCompactedMessageCount,
    setRuntime,
    setMetaReady,
    resetComposerDraft,
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
    dreaminaCapability,
    flashMaintenanceHint,
    surfacedDreaminaHintRef,
    send,
    createQuestionState,
    mk,
    mergeRecentProjects,
  });

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
    reset,
    utilityPanel,
    setMobileNavOpen,
    setTasks,
    setDesktopSidebarCollapsed,
    onUtilityChange,
    areTaskListsEquivalent,
  });

  // 鏂囦欢绯荤粺浼氳瘽鎭㈠锛氬綋 localStorage 涓虹┖鏃讹紙濡傞厤棰濊秴鍑哄悗鏁版嵁琚竻闄わ級锛屼粠鏂囦欢绯荤粺鍔犺浇涓婃浼氳瘽
  useEffect(() => {
    if (seedRef.current?.session) return; // localStorage 宸叉湁鏁版嵁锛屾棤闇€鎭㈠
    void import("@/lib/home-agent/session-store").then(async ({ readLastSessionFromFile, writeStudioSession: writeSession, readSessionResetMarker }) => {
      const fileSession = await readLastSessionFromFile();
      if (!fileSession?.projectId) return;
      // 鑻ヨ椤圭洰琚富鍔ㄦ竻闄よ繃锛岃烦杩囨仮澶嶏紝闃叉鍒锋柊鍚庡巻鍙查噸鏂拌烦鍑?
      if (fileSession.projectId === readSessionResetMarker()) return;
      // 灏嗘枃浠剁郴缁熶腑鐨勫畬鏁翠細璇濆啓鍥?localStorage锛屽啀閫氳繃 openProject 鎭㈠ UI 鐘舵€?
      writeSession(fileSession);
      void openProject(fileSession.projectId);
    });
  }, [openProject]);

  const handleRefreshProjects = useCallback(async () => {
    setIsRefreshingProjects(true);
    try {
      const store = await loadProjectStore();
      const { pruneHistoryIfNeeded } = await import("@/lib/home-agent/project-store");
      await pruneHistoryIfNeeded();
      const items = await store.listRecentConversationSnapshots(50);
      const { readProjectSessionFromFile } = await import("@/lib/home-agent/session-store");
      const sessions = (
        await Promise.all(items.map((snapshot) => readProjectSessionFromFile(snapshot.projectId)))
      ).filter((s): s is NonNullable<typeof s> => Boolean(s));
      React.startTransition(() => {
        setRuntime((prev) => ({ ...prev, recentProjects: items, recentProjectSessions: sessions }));
        setRecentProjectsReady(true);
      });
    } catch {
      // 闈欓粯澶辫触
    } finally {
      setIsRefreshingProjects(false);
    }
  }, [loadProjectStore, setRuntime]);

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
        draft: draftRef.current || persistedDraft,
        qState,
        deferredQuestionState,
        pendingChoiceQuestion:
          qState || deferredQuestionState
            ? null
            : (popoverOverride ?? suggested ?? null),
        selectedValues,
        deferredSelectedValues,
        deferredDraft,
        surfacedTaskIds: [...surfacedTaskIdsRef.current],
        surfacedTaskFollowupKeys: [...surfacedTaskFollowupIdsRef.current],
        surfacedProjectSuggestionKeys: [...surfacedProjectSuggestionKeysRef.current],
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
      messages,
      mode,
      persistedDraft,
      popoverOverride,
      qState,
      runtime,
      selectedImageModelFamily,
      selectedTextModelKey,
      selectedValues,
      selectedVideoModelKey,
      suggested,
      videoGenerationPrefs,
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

      writeStudioSession(replacedSession);

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
          recentProjectSessions: [
            replacedSession,
            ...(runtimeRef.current.recentProjectSessions ?? []).filter((item) => item.projectId !== snapshot.projectId),
          ],
        };
        startTransition(() => {
          setMessages(replacedSession.messages);
          setMode(replacedSession.mode === "recovering" || replacedSession.mode === "maintenance-review" ? replacedSession.mode : "active");
          setQState(replacedSession.qState ?? null);
          setDeferredQuestionState(replacedSession.deferredQuestionState ?? null);
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
            recentProjectSessions: [
              replacedSession,
              ...(prev.recentProjectSessions ?? []).filter((item) => item.projectId !== snapshot.projectId),
            ],
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
            recentProjectSessions: [
              replacedSession,
              ...(prev.recentProjectSessions ?? []).filter((item) => item.projectId !== snapshot.projectId),
            ],
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
      const others = runtimeRef.current.recentProjects.filter((p) => p.projectId !== snapshot.projectId);
      const wasActive = activeProjectId === snapshot.projectId;

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
          setStreaming(false);
          setQState(null);
          setPopoverOverride(null);
          setSuggested(null);
          setSelectedValues([]);
        });
      }

      try {
        const store = await loadProjectStore();
        await store.deleteConversationProject(snapshot);
      } catch (error) {
        flashMaintenanceHint(
          error instanceof Error ? error.message : "删除会话失败，请稍后重试。",
          3200,
        );
        return;
      }

      startTransition(() => {
        setRuntime((prev) => ({
          ...prev,
          recentProjects: sortConversationSnapshots(
            prev.recentProjects.filter((p) => p.projectId !== snapshot.projectId),
          ),
          recentProjectSessions: (prev.recentProjectSessions ?? []).filter(
            (s) => s.projectId !== snapshot.projectId,
          ),
          ...(prev.currentProjectSnapshot?.projectId === snapshot.projectId
            ? {
                currentProjectSnapshot: null,
                currentDramaProject: null,
                currentVideoProject: null,
              }
            : {}),
        }));
      });

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
        const next = others[0];
        if (next) {
          void openProject(next.projectId);
        } else {
          staleProjectIdsRef.current.add(snapshot.projectId);
          reset();
        }
      } else {
        flashMaintenanceHint("已删除该会话。", 2200);
      }
    },
    [
      activeProjectId,
      cancelPendingProjectOpen,
      flashMaintenanceHint,
      loadAskUserQuestionModule,
      loadProjectStore,
      openProject,
      qState?.request.id,
      reset,
      restoredProjectSuggestionKeysRef,
      runtimeRef,
      setPopoverOverride,
      setQState,
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
            setMessages(nextSession.messages);
            setCompactedMessageCount(nextSession.compactedMessageCount ?? 0);
          }

          setRuntime((prev) => ({
            ...prev,
            recentProjects: result.snapshot
              ? sortConversationSnapshots(
                  prev.recentProjects.map((item) =>
                    item.projectId === snapshot.projectId ? result.snapshot! : item,
                  ),
                )
              : prev.recentProjects,
            recentProjectSessions: nextSession
              ? [
                  nextSession,
                  ...(prev.recentProjectSessions ?? []).filter(
                    (item) => item.projectId !== snapshot.projectId,
                  ),
                ]
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

      if (actionId === "switch_to_api") {
        void handleJimengExecutionModeChange("api");
        return;
      }

      if (actionId === "switch_to_cli") {
        void handleJimengExecutionModeChange("cli");
        return;
      }

      if (actionId === "continue_script_only" && launchNoticeKey) {
        setSuppressedLaunchNoticeKey(launchNoticeKey);
        flashMaintenanceHint("已按仅剧本 / 改编模式继续，视频配置提醒本轮先收起。", 2400);
      }
    },
    [flashMaintenanceHint, handleJimengExecutionModeChange, handleOpenSettings, launchNoticeKey],
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

  // 包装 runWorkflowActionShortcut：对单目标媒体重生成 action，优先走 inline 路径（和卡片重生成按钮行为一致）
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
            if (result.data.projectSnapshot?.projectId) {
              setActiveProjectId(result.data.projectSnapshot.projectId);
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

      const isMediaRegenAction =
        action === "generate_video_assets" ||
        action === "generate_storyboard_frames" ||
        action === "generate_video_reference_assets";

      if (isMediaRegenAction) {
        const targetIds = Array.isArray(input.targetIds) ? (input.targetIds as string[]) : [];
        if (targetIds.length === 1) {
          const targetId = targetIds[0];
          const list = messagesRef.current;
          // 找最新 assistant 消息（即重生成按钮可见的那条）
          const lastAssistantIdx = [...list].reduce<number>((acc, m, i) => (m.role === "assistant" ? i : acc), -1);
          const lastAssistantMsg = lastAssistantIdx >= 0 ? list[lastAssistantIdx] : null;
          if (lastAssistantMsg?.attachments?.length) {
            for (const attachment of lastAssistantMsg.attachments) {
              if (attachment.pending) continue;
              const target = resolveInlineAttachmentTarget(attachment);
              if (target && target.targetId === targetId && target.action === action) {
                void handleRegenerateAssistant(lastAssistantMsg.id, attachment.id);
                return;
              }
            }
          }
        }
      }

      runWorkflowActionShortcut(action, input, label, options);
    },
    [
      flashMaintenanceHint,
      loadWorkflowActionsModule,
      messagesRef,
      resolveInlineAttachmentTarget,
      handleRegenerateAssistant,
      runWorkflowActionShortcut,
      runtimeRef,
      setActiveProjectId,
      setPopoverOverride,
      setRuntime,
      setSuggested,
    ],
  );

  const handlePendingVideoKickoffStyleReferenceUpload = useCallback(
    async (
      currentFiles: File[],
      displayText: string,
      rawText: string,
      preparedAttachments: ChatAttachment[],
    ) => {
      const pendingRequest = pendingVideoKickoffStyleReferenceUploadRef.current;
      if (!pendingRequest) return false;

      setAttachedFiles([]);
      push(
        "user",
        displayText,
        undefined,
        preparedAttachments.map((attachment) => stripAttachmentPayloadForHistory(attachment)),
      );

      const imageFiles = currentFiles.filter(isSupportedImageFile);
      if (!imageFiles.length) {
        push("assistant", "我正在等你上传参考图。请至少上传一张图片，发送后我会继续识别并自动进入下一步。");
        return true;
      }

      try {
        const recognition = await analyzeHomeAgentImageStyleFiles(imageFiles, {
          userPrompt: rawText.trim() || draftRef.current || persistedDraft || "识别当前上传参考图的画面风格。",
        });
        const nextImagePrefs = normalizeVideoImageGenerationPrefs({
          ...imageGenerationPrefs,
          ...buildImagePrefsPatchFromRecognition(recognition),
        });
        await commitEffectiveImagePrefs(nextImagePrefs);
        pendingVideoKickoffStyleReferenceUploadRef.current = null;
        setAwaitingVideoKickoffStyleReferenceUpload(false);
        push(
          "assistant",
          [
            "已识别参考图风格，摘要如下：",
            `画面风格：${buildVideoImageStyleSummary(nextImagePrefs)}`,
            `参考图摘要：${recognition.summary}`,
            "接下来我会自动继续补平台与镜头偏好。",
          ].join("\n"),
        );
        void runBackgroundVideoBridgeResearch(
          pendingRequest.label || "继续补齐平台与镜头偏好",
          "all",
        );
        return true;
      } catch (error) {
        push(
          "assistant",
          `${
            error instanceof Error ? error.message : "参考图风格识别失败。"
          }请重新上传参考图，或改用自定义风格说明。`,
        );
        return true;
      }
    },
    [
      commitEffectiveImagePrefs,
      imageGenerationPrefs,
      persistedDraft,
      push,
      runBackgroundVideoBridgeResearch,
    ],
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
    const hasDramaProject = Boolean(runtimeRef.current.currentDramaProject?.id);
    push("user", "接入视频工作流");
    push("assistant", buildVideoWorkflowKickoffIntro());
    setPopoverOverride(null);
    setSuggested(null);
    setSelectedValues([]);
    setMode("active");
    resetComposerDraft("");
    setQState(createQuestionState(buildVideoWorkflowKickoffRequest(hasDramaProject), "restored"));
  }, [createQuestionState, push, resetComposerDraft, runtimeRef, setMode, setPopoverOverride, setQState, setSelectedValues, setSuggested]);

  const {
    videoProjectChoiceHandler,
    videoAssetChoiceHandler,
    scriptProjectChoiceHandler,
  } = useHomeAgentChoiceHandlers({
    runtimeRef,
    getCurrentQuestion: () => question,
    rememberInterruptRestoreQuestion: (nextQuestion) => {
      interruptRestoreQuestionRef.current = nextQuestion;
    },
    push,
    setPopoverOverride,
    setSuggested,
    setMode,
    resetComposerDraft,
    runWorkflowActionShortcut: runWorkflowActionShortcutWithInlineCheck,
    runWorkflowActionShortcutChain,
    runBackgroundVideoBridgeResearch,
    commitImageGenerationPrefs: commitEffectiveImagePrefs,
    commitVideoGenerationPrefs: commitEffectiveVideoPrefs,
    getImageGenerationPrefs: () => imageGenerationPrefs,
    getVideoGenerationPrefs: () => videoGenerationPrefs,
    getAttachedImageCount: () => attachedFiles.filter(isSupportedImageFile).length,
    recognizeImageStyle: handleRecognizeImageStyle,
    onAwaitVideoKickoffStyleReferenceUpload: (label) => {
      pendingVideoKickoffStyleReferenceUploadRef.current = { label };
      setAwaitingVideoKickoffStyleReferenceUpload(true);
    },
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

  const handleGlobalInterrupt = useCallback(() => {
    const restoreQuestion = interruptRestoreQuestionRef.current;
    interruptRestoreQuestionRef.current = null;
    const activeSnapshot = runtimeRef.current.currentProjectSnapshot;
    const bridgeRetryQuestion =
      activeWorkflowAction === "video:bridge:platform"
        ? buildVideoBridgeRetryQuestion(activeSnapshot)
        : null;

    const stopResult = stopActiveExecution();
    interruptWorkflowShortcut();
    const stoppedTaskCount = stopRunningTasks();

    setStreaming(false);
    if (bridgeRetryQuestion) {
      setMode("active");
      setPopoverOverride(bridgeRetryQuestion);
      setSuggested(null);
      resetComposerDraft("");
      const interruptMessage =
        stopResult.cancelledRemoteVideoTaskCount > 0
          ? `已停止当前补齐，并已向视频生成服务发起 ${stopResult.cancelledRemoteVideoTaskCount} 条撤销请求。你可以继续补齐平台与镜头偏好。`
          : "已停止当前补齐。你可以继续补齐平台与镜头偏好。";
      push("assistant", interruptMessage);
      return;
    }
    if (restoreQuestion) {
      restoreInterruptedChoiceQuestion(restoreQuestion);
      const restoreInterruptMessage =
        stopResult.cancelledRemoteVideoTaskCount > 0
          ? `已停止当前执行，并已向视频生成服务发起 ${stopResult.cancelledRemoteVideoTaskCount} 条撤销请求。刚才的弹窗已恢复，你可以重新选择。`
          : "已停止当前执行，刚才的弹窗已恢复，你可以重新选择。";
      push("assistant", restoreInterruptMessage);
      return;
    }

    if (lastSuggestedRef.current) {
      setSuggested(lastSuggestedRef.current);
    }

    if (stopResult.hadActiveExecution || stoppedTaskCount > 0) {
      push("assistant", "已停止当前执行。你可以调整后继续。");
    }
  }, [
    activeWorkflowAction,
    buildVideoBridgeRetryQuestion,
    interruptWorkflowShortcut,
    lastSuggestedRef,
    push,
    resetComposerDraft,
    runtimeRef,
    setMode,
    setPopoverOverride,
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
      const currentProjectId = runtimeRef.current.currentProjectSnapshot?.projectId ?? activeProjectId;
      dismissedDeferredQuestionStepRef.current = `${questionState.request.id}:${questionState.currentIndex}`;
      setDeferredQuestionState(nextDeferredQuestionState);
      setDeferredSelectedValues(nextSelectedValues);
      setDeferredDraft(nextDraft);
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
          pendingChoiceQuestion: null,
          selectedValues: [],
          deferredSelectedValues: nextSelectedValues,
          deferredDraft: nextDraft,
          surfacedTaskIds: [...surfacedTaskIdsRef.current],
          surfacedTaskFollowupKeys: [...surfacedTaskFollowupIdsRef.current],
          surfacedProjectSuggestionKeys: [...surfacedProjectSuggestionKeysRef.current],
          fullAutoRun: runtimeRef.current.fullAutoRun ?? null,
        });
      }
    },
    [
      activeProjectId,
      automationMode,
      compactedMessageCount,
      creationMode,
      devMode,
      imageGenerationPrefs,
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
      const currentProjectId = runtimeRef.current.currentProjectSnapshot?.projectId ?? activeProjectId;
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
          pendingChoiceQuestion: questionToDismiss,
          selectedValues: [],
          deferredSelectedValues,
          deferredDraft,
          surfacedTaskIds: [...surfacedTaskIdsRef.current],
          surfacedTaskFollowupKeys: [...surfacedTaskFollowupIdsRef.current],
          surfacedProjectSuggestionKeys: [...surfacedProjectSuggestionKeysRef.current],
          fullAutoRun: runtimeRef.current.fullAutoRun ?? null,
        });
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
      imageGenerationPrefs,
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
    const currentProjectId = runtimeRef.current.currentProjectSnapshot?.projectId;
    if (currentProjectId) {
      staleProjectIdsRef.current.add(currentProjectId);
    }
    // 濡傛灉褰撳墠鏈夊墽鏈」鐩紝鍏堜繚瀛樺埌 localStorage 鍐?reset
    const currentDramaProject = runtimeRef.current.currentDramaProject;
    if (currentDramaProject) {
      void import("@/lib/home-agent/project-store").then(({ upsertStoredDramaProject }) => {
        upsertStoredDramaProject(currentDramaProject);
      });
    }
    handleReset();
  }, [handleReset, runtimeRef]);

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

        if (
          await handlePendingVideoKickoffStyleReferenceUpload(
            currentFiles,
            displayText,
            rawText,
            preparedAttachments,
          )
        ) {
          return;
        }

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
      handlePendingVideoKickoffStyleReferenceUpload,
      loadApiConfigModule,
      selectedTextModelKey,
      send,
      textOf,
    ],
  );

  // 浠庝細璇濇秷鎭腑鎻愬彇鎵€鏈夊凡鐢熸垚鐨勫浘鐗?瑙嗛闄勪欢锛堥潪 pending锛夛紝鐢ㄤ簬濯掍綋鏀剁撼鎶藉眽
  const conversationMediaItems = useMemo(() => {
    const items: ChatAttachment[] = [];
    for (const msg of messages) {
      if (!msg.attachments?.length) continue;
      for (const att of msg.attachments) {
        if (
          (att.kind === "image" || att.kind === "video") &&
          !att.pending &&
          att.previewUrl &&
          !isExpiredRemoteSignedMediaUrl(att.previewUrl) &&
          !isExpiredRemoteSignedMediaUrl(att.localPath)
        ) {
          items.push(att);
        }
      }
    }
    return items;
  }, [messages]);

  const { idleComposer, activeComposer, workflowProgress } = useHomeAgentComposerBindings({
    idle,
    currentProject,
    maintenanceHint,
    videoTransportHint,
    launchNotice,
    draftInitialValue,
    draftResetVersion,
    draftPresence,
    syncComposerDraft,
    placeholder,
    question,
    qState,
    selectedValues,
    streaming,
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
    onDevVideoGenerationModeChange: handleDevVideoGenerationModeChange,
    onDevImageViewModeChange: handleDevImageViewModeChange,
    creationMode,
    onCreationModeChange: setCreationMode,
    devMode,
    onDevModeChange: setDevMode,
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
    handleFullAutoChoiceSelect,
    onLaunchAction: handleLaunchNoticeAction,
    activeTrackClassName: ACTIVE_TRACK_CLASS,
    idleTrackClassName: IDLE_TRACK_CLASS,
    lastSuggestedRef,
    interruptWorkflowShortcut,
    onGlobalInterrupt: handleGlobalInterrupt,
    clearInterruptRestoreQuestion: () => {
      interruptRestoreQuestionRef.current = null;
    },
    rememberInterruptRestoreQuestion: (nextQuestion) => {
      interruptRestoreQuestionRef.current = nextQuestion;
    },
    attachedFiles,
    onAttachedFilesChange: setAttachedFiles,
    conversationMediaItems,
  });

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
      <DesktopSidebar
        idle={idle}
        recentProjects={deferredRecentProjects}
        recentProjectsReady={recentProjectsReady}
        templates={sidebarTemplates}
        assets={deferredSidebarAssets}
        currentProjectId={activeProjectId}
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
        jimengExecutionMode={jimengExecutionMode}
        onChangeJimengExecutionMode={handleJimengExecutionModeChange}
        dreaminaCliAvailable={dreaminaCapability.available}
        onDeleteAsset={handleDeleteAsset}
        highlightedAssetId={sidebarAssetFocus?.assetId}
        highlightedAssetMessage={sidebarAssetFocus?.message}
        automationMode={automationMode}
      />
      <MobileSidebarSheet
        open={mobileNavOpen}
        onOpenChange={setMobileNavOpen}
        idle={idle}
        recentProjects={deferredRecentProjects}
        recentProjectsReady={recentProjectsReady}
        templates={sidebarTemplates}
        assets={deferredSidebarAssets}
        currentProjectId={activeProjectId}
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
        jimengExecutionMode={jimengExecutionMode}
        onChangeJimengExecutionMode={handleJimengExecutionModeChange}
        dreaminaCliAvailable={dreaminaCapability.available}
        onDeleteAsset={handleDeleteAsset}
        highlightedAssetId={sidebarAssetFocus?.assetId}
        highlightedAssetMessage={sidebarAssetFocus?.message}
        automationMode={automationMode}
      />
      <DesktopSettingsPanel
        open={settingsOpen}
        onClose={handleCloseSettings}
        onSaved={() => {
          void refreshLaunchReadiness();
        }}
        leftOffset={desktopSidebarOffset}
        width={DESKTOP_SETTINGS_WIDTH}
      />
      <MobileSettingsSheet
        open={settingsOpen}
        onOpenChange={handleSettingsOpenChange}
        onSaved={() => {
          void refreshLaunchReadiness();
        }}
      />

      <div className="relative z-10 flex min-h-screen flex-col">
        <MobileTopbar idle={idle} brandLabel={SIDEBAR_BRAND} onOpenNavigation={handleOpenMobileNavigation} />
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
          {idle ? (
            <IdleLanding composer={idleComposer} reduceMotion={reduceMotion} title={TITLE} trackClassName={IDLE_TRACK_CLASS} />
          ) : (
            <>
              <ActiveConversationShell
                messages={deferredMessages}
                tasks={deferredVisibleTasks}
                onStopTask={handleStopTask}
                endRef={endRef}
                composer={activeComposer}
                streaming={streaming}
                hasUnreadMessage={hasUnreadMessage}
                trackClassName={ACTIVE_TRACK_CLASS}
                snapshot={currentProject}
                workflowProgress={workflowProgress}
                fullAutoRun={runtime.fullAutoRun ?? null}
                onStopFullAuto={handleStopFullAuto}
                onArtifactAction={(value, label, input) => {
                  if (currentProject) {
                    if (
                      currentProject.projectKind === "video" &&
                      (videoProjectChoiceHandler(currentProject, value, label) ||
                        videoAssetChoiceHandler(currentProject, value, label))
                    ) {
                      return;
                    }

                    scriptProjectChoiceHandler(currentProject, value, label, input);
                  }
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
