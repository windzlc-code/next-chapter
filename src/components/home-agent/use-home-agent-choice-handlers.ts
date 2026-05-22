import { useCallback, useMemo } from "react";
import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import type {
  AgentConversationMode,
  ComposerQuestion,
  ConversationProjectSnapshot,
  HomeAgentMessage,
  StudioRuntimeState,
} from "@/lib/home-agent/types";
import type { HomeAgentImageStyleRecognitionResult } from "@/lib/home-agent/image-style-analysis";
import type { CharacterAudioPresetBindSelection } from "@/lib/home-agent/character-audio-preset-library";
import type { VideoGenerationPrefs, VideoImageGenerationPrefs } from "@/types/project";
import { createScriptProjectChoiceHandler, type ExportLocalAction } from "./home-agent-script-choice-handlers";
import {
  createVideoAssetChoiceHandler,
  createVideoProjectChoiceHandler,
} from "./home-agent-video-choice-handlers";
import { showChoiceNoticeMessage, showChoicePopoverMessage } from "./home-agent-workflow-ui";

type PushMessage = (role: HomeAgentMessage["role"], content: string) => void;
type SubmittedStyleReferenceResult =
  HomeAgentImageStyleRecognitionResult & { handledLocally?: boolean };
type ChoiceHandler = (
  snapshot: ConversationProjectSnapshot,
  value: string,
  label: string,
  input?: Record<string, unknown>,
) => boolean;
type WorkflowShortcutRunner = (
  action: string,
  input: Record<string, unknown>,
  userBubble: string,
  options?: {
    restoreQuestionOnInterrupt?: ComposerQuestion | null;
    restoreQuestionOnCancel?: ComposerQuestion | null;
    restoreQuestionOnError?: ComposerQuestion | null;
    restoreQuestionAfterRun?: ComposerQuestion | null;
    skipUserBubble?: boolean;
    skipAssistantSummary?: boolean;
  },
) => void | Promise<void>;
type WorkflowShortcutChainRunner = (
  steps: Array<{ action: string; input: Record<string, unknown> }>,
  userBubble: string,
  options?: {
    restoreQuestionOnInterrupt?: ComposerQuestion | null;
    restoreQuestionOnCancel?: ComposerQuestion | null;
    restoreQuestionOnError?: ComposerQuestion | null;
    restoreQuestionAfterRun?: ComposerQuestion | null;
    skipUserBubble?: boolean;
  },
) => void | Promise<void>;
type BackgroundVideoBridgeResearchRunner = (
  userBubble: string,
  mode?: "all" | "targetPlatform" | "shotStyle" | "outputGoal",
) => void | Promise<void>;
type MediaPrefsCommitter<TPrefs> = (
  prefs: Partial<TPrefs>,
  options?: {
    referenceStyleSummary?: string | null;
    projectPatch?: Partial<PersistedVideoProject>;
  },
) => void | Promise<unknown>;
type VideoProjectPatcher = (patch: Partial<PersistedVideoProject>) => void | Promise<void>;
type SceneLike = { id: string };
type CharacterCard = {
  id: string;
  name: string;
  role: string;
  coreConflict: string;
  desire: string;
  riskNote: string;
  relationshipAxis: string[];
};
type CompliancePacket = {
  id: string;
  issueTitle: string;
  riskLevel: string;
  recommendation: string;
};
type BeatPacket = {
  id: string;
  title: string;
  episodeNumber: number;
  status: string;
};

export function useHomeAgentChoiceHandlers(params: {
  runtimeRef: React.MutableRefObject<StudioRuntimeState>;
  getCurrentQuestion: () => ComposerQuestion | null;
  rememberInterruptRestoreQuestion: (question: ComposerQuestion | null) => void;
  push: PushMessage;
  setPopoverOverride: React.Dispatch<React.SetStateAction<ComposerQuestion | null>>;
  openPopoverQuestion?: (question: ComposerQuestion | null) => void | boolean;
  setSuggested: React.Dispatch<React.SetStateAction<ComposerQuestion | null>>;
  setMode: React.Dispatch<React.SetStateAction<AgentConversationMode>>;
  resetComposerDraft: (value?: string) => void;
  send: (prompt: string, shown?: string) => Promise<void>;
  runBackgroundVideoBridgeResearch: BackgroundVideoBridgeResearchRunner;
  commitVideoProjectPatch?: VideoProjectPatcher;
  commitImageGenerationPrefs?: MediaPrefsCommitter<VideoImageGenerationPrefs>;
  commitVideoGenerationPrefs?: MediaPrefsCommitter<VideoGenerationPrefs>;
  getImageGenerationPrefs?: () => VideoImageGenerationPrefs;
  getVideoGenerationPrefs?: () => VideoGenerationPrefs;
  getAttachedImageCount?: () => number;
  clearAttachedFiles?: () => void;
  recognizeImageStyle?: () => Promise<HomeAgentImageStyleRecognitionResult | null>;
  submitAttachedStyleReference?: (label: string) => Promise<SubmittedStyleReferenceResult | null>;
  onAwaitVideoKickoffStyleReferenceUpload?: (label: string) => void;
  onAwaitCharacterAudioReferenceUpload?: (
    label: string,
    characterId: string,
    characterName?: string,
    restoreQuestion?: ComposerQuestion | null,
  ) => void;
  onOpenCharacterAudioReferencePresetPicker?: (
    label: string,
    characterId: string,
    characterName?: string,
    restoreQuestion?: ComposerQuestion | null,
  ) => void | Promise<void>;
  onBindCharacterAudioReferencePreset?: (
    selection: CharacterAudioPresetBindSelection & {
      label: string;
      characterName?: string;
      restoreQuestion?: ComposerQuestion | null;
    },
  ) => void | Promise<void>;
  onClearVideoKickoffStyleReferenceUploadWait?: () => void;
  runWorkflowActionShortcut: WorkflowShortcutRunner;
  runWorkflowActionShortcutChain: WorkflowShortcutChainRunner;
  interruptWorkflowShortcut: () => void;
  switchVideoStep: (projectId: string, targetStep: number, statusText: string) => void;
  buildVideoGenerationQuestion: (
    snapshot: ConversationProjectSnapshot,
    project: PersistedVideoProject | null | undefined,
  ) => ComposerQuestion | null;
  buildVideoGenerationSceneListQuestion: (
    snapshot: ConversationProjectSnapshot,
    project: PersistedVideoProject | null | undefined,
  ) => ComposerQuestion | null;
  listGeneratableVideoScenes: (project: PersistedVideoProject | null | undefined) => SceneLike[];
  listFailedVideoScenes: (project: PersistedVideoProject | null | undefined) => SceneLike[];
  listRunningVideoScenes: (project: PersistedVideoProject | null | undefined) => SceneLike[];
  listUnlockedCharacterCards: (snapshot: ConversationProjectSnapshot) => CharacterCard[];
  buildCharacterCardListQuestion: (snapshot: ConversationProjectSnapshot) => ComposerQuestion | null;
  findCharacterCard: (snapshot: ConversationProjectSnapshot, cardId: string) => CharacterCard | undefined;
  buildCharacterCardDecisionQuestion: (
    snapshot: ConversationProjectSnapshot,
    cardId: string,
  ) => ComposerQuestion | null;
  listPendingCompliancePackets: (snapshot: ConversationProjectSnapshot) => CompliancePacket[];
  buildComplianceListQuestion: (snapshot: ConversationProjectSnapshot) => ComposerQuestion | null;
  findCompliancePacket: (snapshot: ConversationProjectSnapshot, packetId: string) => CompliancePacket | undefined;
  buildComplianceDecisionQuestion: (
    snapshot: ConversationProjectSnapshot,
    packetId: string,
  ) => ComposerQuestion | null;
  listUnlockedBeatPackets: (snapshot: ConversationProjectSnapshot) => BeatPacket[];
  buildBeatPacketListQuestion: (snapshot: ConversationProjectSnapshot) => ComposerQuestion | null;
  findBeatPacket: (snapshot: ConversationProjectSnapshot, packetId: string) => BeatPacket | undefined;
  buildBeatPacketDecisionQuestion: (
    snapshot: ConversationProjectSnapshot,
    packetId: string,
  ) => ComposerQuestion | null;
  buildOutlinesWorkflowQuestion: (snapshot: ConversationProjectSnapshot) => ComposerQuestion | null;
  buildEpisodeDurationGateQuestion: (snapshot: ConversationProjectSnapshot) => ComposerQuestion | null;
  buildEpisodeWorkflowQuestion: (snapshot: ConversationProjectSnapshot) => ComposerQuestion | null;
  onExportLocalAction?: (action: ExportLocalAction) => void;
  onDirectBatchReview?: () => void;
  onDirectSingleReview?: (episodeNumber: number) => void;
  onVideoKickoff?: () => void;
}) {
  const {
    runtimeRef,
    getCurrentQuestion,
    rememberInterruptRestoreQuestion,
    push,
    setPopoverOverride,
    openPopoverQuestion,
    setSuggested,
    setMode,
    resetComposerDraft,
    send,
    runBackgroundVideoBridgeResearch,
    commitVideoProjectPatch,
    commitImageGenerationPrefs,
    commitVideoGenerationPrefs,
    getImageGenerationPrefs,
    getVideoGenerationPrefs,
    getAttachedImageCount,
    clearAttachedFiles,
    recognizeImageStyle,
    submitAttachedStyleReference,
    onAwaitVideoKickoffStyleReferenceUpload,
    onAwaitCharacterAudioReferenceUpload,
    onOpenCharacterAudioReferencePresetPicker,
    onBindCharacterAudioReferencePreset,
    onClearVideoKickoffStyleReferenceUploadWait,
    runWorkflowActionShortcut,
    runWorkflowActionShortcutChain,
    interruptWorkflowShortcut,
    switchVideoStep,
    buildVideoGenerationQuestion,
    buildVideoGenerationSceneListQuestion,
    listGeneratableVideoScenes,
    listFailedVideoScenes,
    listRunningVideoScenes,
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
    onExportLocalAction,
    onDirectBatchReview,
    onDirectSingleReview,
    onVideoKickoff,
  } = params;

  const showChoicePopover = useCallback(
    (label: string, assistantMessage: string, nextQuestion: ComposerQuestion) => {
      showChoicePopoverMessage({
        label,
        assistantMessage,
        nextQuestion,
        push,
        setPopoverOverride,
        openPopoverQuestion,
        setSuggested,
        setMode,
        resetComposerDraft,
      });
    },
    [openPopoverQuestion, push, resetComposerDraft, setMode, setPopoverOverride, setSuggested],
  );

  const showChoiceNotice = useCallback(
    (
      label: string,
      assistantMessage: string,
      nextSuggestion: ComposerQuestion | null = null,
      options?: { preservePopover?: boolean },
    ) => {
      showChoiceNoticeMessage({
        label,
        assistantMessage,
        nextSuggestion,
        preservePopover: options?.preservePopover,
        push,
        setPopoverOverride,
        setSuggested,
        setMode,
        resetComposerDraft,
      });
    },
    [push, resetComposerDraft, setMode, setPopoverOverride, setSuggested],
  );

  const runWorkflowActionShortcutWithRestore = useCallback<WorkflowShortcutRunner>(
    (action, input, userBubble, options) => {
      const currentQuestion = getCurrentQuestion();
      rememberInterruptRestoreQuestion(options?.restoreQuestionOnInterrupt ?? currentQuestion);
      return runWorkflowActionShortcut(action, input, userBubble, {
        ...options,
        ...(action === "export_video_asset_bundle"
          ? {
              restoreQuestionOnCancel:
                options?.restoreQuestionOnCancel ?? currentQuestion,
            }
          : {}),
      });
    },
    [getCurrentQuestion, rememberInterruptRestoreQuestion, runWorkflowActionShortcut],
  );

  const runWorkflowActionShortcutChainWithRestore = useCallback<WorkflowShortcutChainRunner>(
    (steps, userBubble) => {
      const restoreQuestion = getCurrentQuestion();
      rememberInterruptRestoreQuestion(restoreQuestion);
      return runWorkflowActionShortcutChain(steps, userBubble, {
        restoreQuestionOnInterrupt: restoreQuestion,
      });
    },
    [getCurrentQuestion, rememberInterruptRestoreQuestion, runWorkflowActionShortcutChain],
  );

  const sendWithRestore = useCallback(
    (prompt: string, shown?: string) => {
      rememberInterruptRestoreQuestion(getCurrentQuestion());
      return send(prompt, shown);
    },
    [getCurrentQuestion, rememberInterruptRestoreQuestion, send],
  );

  const awaitVideoKickoffStyleReferenceUpload = useCallback(
    (label: string) => {
      onAwaitVideoKickoffStyleReferenceUpload?.(label);
      showChoiceNotice(
        label,
        "请先上传一张参考图。发送后我会先识别画面风格并给出摘要，然后停在“补齐平台与镜头偏好”这一步等你确认。",
      );
    },
    [onAwaitVideoKickoffStyleReferenceUpload, showChoiceNotice],
  );

  const clearAwaitVideoKickoffStyleReferenceUpload = useCallback(() => {
    onClearVideoKickoffStyleReferenceUploadWait?.();
  }, [onClearVideoKickoffStyleReferenceUploadWait]);

  const awaitCharacterAudioReferenceUpload = useCallback(
    (label: string, characterId: string, characterName?: string) => {
      const restoreQuestion = getCurrentQuestion();
      rememberInterruptRestoreQuestion(restoreQuestion);
      onAwaitCharacterAudioReferenceUpload?.(
        label,
        characterId,
        characterName,
        restoreQuestion,
      );
      const notice = characterName
        ? `请上传角色《${characterName}》的音频参考。一次只能绑定 1 个音色；如果重新上传，我会用最新这条覆盖当前角色的声音参考。`
        : "请上传角色音频参考。一次只能绑定 1 个音色；如果重新上传，我会用最新这条覆盖当前角色的声音参考。";
      showChoiceNotice(label, notice, null, { preservePopover: true });
    },
    [
      getCurrentQuestion,
      onAwaitCharacterAudioReferenceUpload,
      rememberInterruptRestoreQuestion,
      showChoiceNotice,
    ],
  );

  const openCharacterAudioReferencePresetPicker = useCallback(
    (
      label: string,
      characterId: string,
      characterName?: string,
    ) => {
      const restoreQuestion = getCurrentQuestion();
      rememberInterruptRestoreQuestion(restoreQuestion);
      return onOpenCharacterAudioReferencePresetPicker?.(
        label,
        characterId,
        characterName,
        restoreQuestion,
      );
    },
    [
      getCurrentQuestion,
      onOpenCharacterAudioReferencePresetPicker,
      rememberInterruptRestoreQuestion,
    ],
  );

  const bindCharacterAudioReferencePreset = useCallback(
    (
      selection: CharacterAudioPresetBindSelection & {
        label: string;
        characterName?: string;
      },
    ) => {
      const restoreQuestion = getCurrentQuestion();
      rememberInterruptRestoreQuestion(restoreQuestion);
      return onBindCharacterAudioReferencePreset?.({
        ...selection,
        restoreQuestion,
      });
    },
    [
      getCurrentQuestion,
      onBindCharacterAudioReferencePreset,
      rememberInterruptRestoreQuestion,
    ],
  );

  const videoProjectChoiceHandler = useMemo<ChoiceHandler>(
    () =>
      createVideoProjectChoiceHandler({
        getCurrentVideoProject: () => runtimeRef.current.currentVideoProject,
        runBackgroundVideoBridgeResearch,
        commitVideoProjectPatch,
        commitImageGenerationPrefs,
        commitVideoGenerationPrefs,
        getImageGenerationPrefs,
        getVideoGenerationPrefs,
        getAttachedImageCount,
        clearAttachedFiles,
        recognizeImageStyle,
        submitAttachedStyleReference,
        awaitImageStyleReferenceUpload: awaitVideoKickoffStyleReferenceUpload,
        awaitCharacterAudioReferenceUpload,
        openCharacterAudioReferencePresetPicker,
        bindCharacterAudioReferencePreset,
        clearAwaitImageStyleReferenceUpload: clearAwaitVideoKickoffStyleReferenceUpload,
        runWorkflowActionShortcut: runWorkflowActionShortcutWithRestore,
        switchVideoStep,
        send: sendWithRestore,
        showChoicePopover,
        showChoiceNotice,
        buildVideoGenerationQuestion,
        listGeneratableVideoScenes,
        listRunningVideoScenes,
      }),
    [
      buildVideoGenerationQuestion,
      listGeneratableVideoScenes,
      listRunningVideoScenes,
      commitImageGenerationPrefs,
      commitVideoProjectPatch,
      commitVideoGenerationPrefs,
      clearAttachedFiles,
      getAttachedImageCount,
      getImageGenerationPrefs,
      getVideoGenerationPrefs,
      awaitVideoKickoffStyleReferenceUpload,
      awaitCharacterAudioReferenceUpload,
      openCharacterAudioReferencePresetPicker,
      bindCharacterAudioReferencePreset,
      clearAwaitVideoKickoffStyleReferenceUpload,
      recognizeImageStyle,
      runBackgroundVideoBridgeResearch,
      runWorkflowActionShortcutWithRestore,
      submitAttachedStyleReference,
      switchVideoStep,
      runtimeRef,
      sendWithRestore,
      showChoiceNotice,
      showChoicePopover,
    ],
  );

  const videoAssetChoiceHandler = useMemo<ChoiceHandler>(
    () =>
      createVideoAssetChoiceHandler({
        getCurrentVideoProject: () => runtimeRef.current.currentVideoProject,
        runWorkflowActionShortcut: runWorkflowActionShortcutWithRestore,
        runWorkflowActionShortcutChain: runWorkflowActionShortcutChainWithRestore,
        showChoicePopover,
        buildVideoGenerationSceneListQuestion,
        listFailedVideoScenes,
        listGeneratableVideoScenes,
      }),
    [
      buildVideoGenerationSceneListQuestion,
      listFailedVideoScenes,
      listGeneratableVideoScenes,
      runWorkflowActionShortcutChainWithRestore,
      runWorkflowActionShortcutWithRestore,
      runtimeRef,
      showChoicePopover,
    ],
  );

  const scriptProjectChoiceHandler = useMemo<ChoiceHandler>(
    () =>
      createScriptProjectChoiceHandler({
        runWorkflowActionShortcut: runWorkflowActionShortcutWithRestore,
        interruptWorkflowShortcut,
        send: sendWithRestore,
        showChoicePopover,
        setPopoverOverride,
        buildOutlinesWorkflowQuestion,
        buildEpisodeDurationGateQuestion,
        buildEpisodeWorkflowQuestion,
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
        onExportLocalAction,
        onDirectBatchReview,
        onDirectSingleReview,
        onVideoKickoff,
      }),
    [
      buildBeatPacketDecisionQuestion,
      buildBeatPacketListQuestion,
      buildCharacterCardDecisionQuestion,
      buildCharacterCardListQuestion,
      buildComplianceDecisionQuestion,
      buildComplianceListQuestion,
      buildEpisodeWorkflowQuestion,
      buildEpisodeDurationGateQuestion,
      buildOutlinesWorkflowQuestion,
      findBeatPacket,
      findCharacterCard,
      findCompliancePacket,
      interruptWorkflowShortcut,
      listPendingCompliancePackets,
      listUnlockedBeatPackets,
      listUnlockedCharacterCards,
      onDirectBatchReview,
      onDirectSingleReview,
      onExportLocalAction,
      onVideoKickoff,
      runWorkflowActionShortcutWithRestore,
      sendWithRestore,
      setPopoverOverride,
      showChoicePopover,
    ],
  );

  return {
    videoProjectChoiceHandler,
    videoAssetChoiceHandler,
    scriptProjectChoiceHandler,
  };
}
