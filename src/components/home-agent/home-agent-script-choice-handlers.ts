import type { ComposerQuestion, ConversationProjectSnapshot } from "@/lib/home-agent/types";
import { abortOutlineGeneration } from "@/lib/home-agent/services/drama-workflow-service";
import { resolveScriptWorkflowStage } from "./home-agent-project-questions";

export type ExportLocalAction = "copy" | "download-md" | "word" | "episodes-download";

type WorkflowShortcutRunner = (
  action: string,
  input: Record<string, unknown>,
  label: string,
  options?: {
    restoreQuestionOnInterrupt?: ComposerQuestion | null;
    restoreQuestionOnCancel?: ComposerQuestion | null;
    restoreQuestionOnError?: ComposerQuestion | null;
    restoreQuestionAfterRun?: ComposerQuestion | null;
    skipUserBubble?: boolean;
    skipAssistantSummary?: boolean;
  },
) => void | Promise<void>;

type ShowChoicePopover = (
  label: string,
  assistantMessage: string,
  nextQuestion: ComposerQuestion,
) => void;

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

type ComplianceRunSettings = {
  reviewMode?: "text" | "script";
  strictness?: string;
  model?: string;
  dialogueReviewEnabled?: boolean;
  smartRerun?: boolean;
};

type BeatPacket = {
  id: string;
  title: string;
  episodeNumber: number;
  status: string;
};

type ScriptChoiceHandler = (
  snapshot: ConversationProjectSnapshot,
  value: string,
  label: string,
  input?: Record<string, unknown>,
) => boolean;

function readComplianceRunSettings(snapshot: ConversationProjectSnapshot): ComplianceRunSettings {
  const complianceArtifact = snapshot.artifacts.find(
    (artifact) => artifact.kind === "compliance" && artifact.payload?.type === "complianceSummary",
  );
  const payload = complianceArtifact?.payload?.type === "complianceSummary" ? complianceArtifact.payload : null;
  if (!payload) return {};
  return {
    reviewMode: payload.mode === "script" ? "script" : "text",
    strictness: payload.strictness,
    model: payload.workspace.model,
    dialogueReviewEnabled: payload.workspace.dialogueReviewEnabled,
  };
}

function buildComplianceRunInput(
  snapshot: ConversationProjectSnapshot,
  overrides: Partial<ComplianceRunSettings> = {},
): Record<string, unknown> {
  const settings = { ...readComplianceRunSettings(snapshot), ...overrides };
  return {
    projectId: snapshot.projectId,
    sourceStrategy: "project-script",
    ...(settings.reviewMode ? { reviewMode: settings.reviewMode } : {}),
    ...(typeof settings.strictness === "string" ? { strictness: settings.strictness } : {}),
    ...(typeof settings.model === "string" ? { model: settings.model } : {}),
    ...(typeof settings.dialogueReviewEnabled === "boolean"
      ? { dialogueReviewEnabled: settings.dialogueReviewEnabled }
      : {}),
    ...(typeof settings.smartRerun === "boolean" ? { smartRerun: settings.smartRerun } : {}),
  };
}

type ScriptChoiceHandlerDeps = {
  runWorkflowActionShortcut: WorkflowShortcutRunner;
  interruptWorkflowShortcut?: () => void;
  send: (prompt: string, label: string) => void | Promise<void>;
  showChoicePopover: ShowChoicePopover;
  setPopoverOverride?: (question: ComposerQuestion | null) => void;
  buildOutlinesWorkflowQuestion?: (snapshot: ConversationProjectSnapshot) => ComposerQuestion | null;
  buildEpisodeDurationGateQuestion?: (snapshot: ConversationProjectSnapshot) => ComposerQuestion | null;
  buildEpisodeWorkflowQuestion?: (snapshot: ConversationProjectSnapshot) => ComposerQuestion | null;
  listUnlockedCharacterCards: (snapshot: ConversationProjectSnapshot) => CharacterCard[];
  buildCharacterCardListQuestion: (snapshot: ConversationProjectSnapshot) => ComposerQuestion | null;
  findCharacterCard: (snapshot: ConversationProjectSnapshot, cardId: string) => CharacterCard | undefined;
  buildCharacterCardDecisionQuestion: (
    snapshot: ConversationProjectSnapshot,
    cardId: string,
  ) => ComposerQuestion | null;
  listPendingCompliancePackets: (snapshot: ConversationProjectSnapshot) => CompliancePacket[];
  buildComplianceListQuestion: (snapshot: ConversationProjectSnapshot) => ComposerQuestion | null;
  findCompliancePacket: (
    snapshot: ConversationProjectSnapshot,
    packetId: string,
  ) => CompliancePacket | undefined;
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
  /** 客户端本地导出操作（复制/下载/Word/分集下载），不走 AI 工作流 */
  onExportLocalAction?: (action: ExportLocalAction) => void;
  /** 直接触发面板内批量质量审查 Dialog（不走 agent workflow） */
  onDirectBatchReview?: () => void;
  /** 直接触发面板内单集质量自检 Dialog */
  onDirectSingleReview?: (episodeNumber: number) => void;
  /** 触发视频工作流入口问卷（替代直接调用 prepare_video_generation） */
  onVideoKickoff?: () => void;
};

function decodeStructuredValue(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function parseEpisodeNumberSelection(raw: string): number[] {
  const parts = decodeStructuredValue(raw)
    .split(/[,，]/)
    .map((part) => part.trim())
    .filter(Boolean);
  const episodeNumbers = new Set<number>();

  parts.forEach((part) => {
    const rangeMatch = part.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return;
      const [from, to] = start <= end ? [start, end] : [end, start];
      for (let episodeNumber = from; episodeNumber <= to; episodeNumber += 1) {
        episodeNumbers.add(episodeNumber);
      }
      return;
    }

    const episodeNumber = Number(part);
    if (Number.isFinite(episodeNumber)) {
      episodeNumbers.add(episodeNumber);
    }
  });

  return [...episodeNumbers].sort((a, b) => a - b);
}

const SCRIPT_STEP_VALUES = new Set([
  "setup",
  "reference-script",
  "creative-plan",
  "structure-transform",
  "characters",
  "character-transform",
  "directory",
  "outlines",
  "episodes",
  "compliance",
  "export",
]);

const COMPLIANCE_IMPORT_ACCEPT = ".txt,.csv,.xls,.xlsx,.pdf,.doc,.docx";

function parseScriptStepEnterValue(value: string): string | null {
  if (!value.startsWith("script:step-enter-")) return null;
  const step = value.replace("script:step-enter-", "");
  return SCRIPT_STEP_VALUES.has(step) ? step : null;
}

function parseComplianceApplyValue(value: string): { riskId: string; replacement: string } | null {
  const match = value.match(/^script:compliance-apply:([^:]+):([\s\S]+)$/);
  if (!match) return null;
  const riskId = match[1]?.trim();
  const replacement = decodeStructuredValue(match[2] ?? "").trim();
  if (!riskId || !replacement) return null;
  return {
    riskId,
    replacement,
  };
}

function isComplianceWorkspaceChoice(value: string): boolean {
  return value.startsWith("script:compliance-");
}

async function pickComplianceImportFile(): Promise<File | null> {
  if (typeof document === "undefined") return null;
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = COMPLIANCE_IMPORT_ACCEPT;
    input.multiple = false;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

function isCharacterWorkflowEntry(value: string): boolean {
  return (
    value === "进入角色开发" ||
    value === "进入角色开发步骤" ||
    value === "进入角色设计" ||
    value === "进入角色设计步骤" ||
    value === "推进角色设计" ||
    value === "继续角色设定" ||
    value === "继续角色开发" ||
    value === "继续角色设计" ||
    value === "补充人物冲突"
  );
}

export function createScriptProjectChoiceHandler(deps: ScriptChoiceHandlerDeps): ScriptChoiceHandler {
  return (snapshot, value, label, input) => {
    if (snapshot.projectKind !== "script" && snapshot.projectKind !== "adaptation") {
      return false;
    }

    if (value === "script:step-enter-episodes") {
      const q = deps.buildEpisodeDurationGateQuestion?.(snapshot);
      if (q) deps.setPopoverOverride?.(q);
      return true;
    }

    if (value.startsWith("script:episode-duration-gate:")) {
      const rawDuration = value.replace(/^script:episode-duration-gate:(?:custom:)?/, "");
      const durationSeconds = Number(rawDuration);
      if (!Number.isFinite(durationSeconds)) return true;

      void deps.runWorkflowActionShortcut(
        "enter_drama_step",
        { projectId: snapshot.projectId, step: "episodes", durationSeconds },
        label,
      );
      return true;
    }

    const workflowStage = resolveScriptWorkflowStage(snapshot.derivedStage);
    const isCharacterStage = workflowStage === "characters";
    const isComplianceStage = workflowStage === "compliance";
    const isBeatStage = workflowStage === "outlines";

    if (!isComplianceStage && isComplianceWorkspaceChoice(value)) {
      return true;
    }

    // 回退到单集细纲：立即切换面板，再异步执行步骤切换
    if (value === "script:step-enter-outlines") {
      const syntheticSnapshot = { ...snapshot, derivedStage: "单集细纲" };
      const q = deps.buildOutlinesWorkflowQuestion?.(syntheticSnapshot);
      if (q) deps.setPopoverOverride?.(q);
      void deps.runWorkflowActionShortcut(
        "enter_drama_step",
        { projectId: snapshot.projectId, step: "outlines" },
        label,
      );
      return true;
    }

    const stepToEnter = parseScriptStepEnterValue(value);
    if (stepToEnter === "characters") {
      void deps.runWorkflowActionShortcut(
        snapshot.projectKind === "adaptation" ? "generate_character_transform" : "generate_characters",
        { projectId: snapshot.projectId },
        label,
      );
      return true;
    }

    if (stepToEnter) {
      void deps.runWorkflowActionShortcut(
        "enter_drama_step",
        { projectId: snapshot.projectId, step: stepToEnter },
        label,
      );
      return true;
    }

    if (value === "script:generate-creative-plan") {
      void deps.runWorkflowActionShortcut(
        "generate_creative_plan",
        { projectId: snapshot.projectId },
        label,
      );
      return true;
    }

    if (value === "script:analyze-reference-script") {
      void deps.runWorkflowActionShortcut(
        "analyze_reference_script",
        { projectId: snapshot.projectId },
        label,
      );
      return true;
    }

    if (value.startsWith("script:adaptation-total-episodes:")) {
      const rawCount = value.replace(/^script:adaptation-total-episodes:(?:custom:)?/, "");
      const totalEpisodes = Number(rawCount);
      if (!Number.isFinite(totalEpisodes)) return true;

      void deps.runWorkflowActionShortcut(
        "confirm_adaptation_episode_count",
        { projectId: snapshot.projectId, totalEpisodes },
        label,
      );
      return true;
    }

    if (value.startsWith("script:adaptation-target-market:")) {
      const targetMarket = value.replace("script:adaptation-target-market:", "").trim();
      if (!targetMarket) return true;

      void deps.runWorkflowActionShortcut(
        "confirm_adaptation_target_market",
        { projectId: snapshot.projectId, targetMarket },
        label,
      );
      return true;
    }

    if (
      workflowStage === "structure-transform" &&
      snapshot.projectKind === "adaptation" &&
      value.trim() &&
      !value.startsWith("script:")
    ) {
      void deps.runWorkflowActionShortcut(
        "confirm_adaptation_genres",
        { projectId: snapshot.projectId, genres: value },
        label,
      );
      return true;
    }

    if (value === "script:generate-structure-transform") {
      void deps.runWorkflowActionShortcut(
        "generate_structure_transform",
        { projectId: snapshot.projectId },
        label,
      );
      return true;
    }

    if (value === "script:generate-characters") {
      void deps.runWorkflowActionShortcut(
        "generate_characters",
        { projectId: snapshot.projectId },
        label,
      );
      return true;
    }

    if (value === "script:generate-character-transform") {
      void deps.runWorkflowActionShortcut(
        "generate_character_transform",
        { projectId: snapshot.projectId },
        label,
      );
      return true;
    }

    if (value === "script:generate-directory") {
      void deps.runWorkflowActionShortcut(
        "generate_directory",
        { projectId: snapshot.projectId },
        label,
      );
      return true;
    }

    if (value === "生成创作方案") {
      void deps.runWorkflowActionShortcut(
        "generate_creative_plan",
        { projectId: snapshot.projectId },
        label,
      );
      return true;
    }

    if (isCharacterWorkflowEntry(value)) {
      void deps.runWorkflowActionShortcut(
        snapshot.projectKind === "adaptation" ? "generate_character_transform" : "generate_characters",
        { projectId: snapshot.projectId },
        label,
      );
      return true;
    }

    if (value.includes("分析参考内容") || value.includes("识别参考文本结构")) {
      void deps.runWorkflowActionShortcut(
        "analyze_reference_script",
        { projectId: snapshot.projectId },
        label,
      );
      return true;
    }

    if (value.includes("结构转译")) {
      void deps.runWorkflowActionShortcut(
        "generate_structure_transform",
        { projectId: snapshot.projectId },
        label,
      );
      return true;
    }

    if (value === "script:outline-generate-all") {
      void deps.runWorkflowActionShortcut(
        "generate_outlines",
        { projectId: snapshot.projectId, keepCurrentStep: true },
        label,
      );
      return true;
    }

    if (value === "script:outline-fill-missing") {
      void deps.runWorkflowActionShortcut(
        "generate_outlines",
        { projectId: snapshot.projectId, fillMissingOutlines: true, keepCurrentStep: true },
        label,
      );
      return true;
    }

    if (value.startsWith("script:outline-generate-single:")) {
      const episodeNumber = Number(value.replace("script:outline-generate-single:", ""));
      if (!Number.isFinite(episodeNumber)) return true;
      void deps.runWorkflowActionShortcut(
        "generate_outlines",
        {
          projectId: snapshot.projectId,
          episodeNumbers: [episodeNumber],
          keepCurrentStep: true,
        },
        label,
      );
      return true;
    }

    if (value.startsWith("script:outline-generate-batch:")) {
      const match = value.match(/^script:outline-generate-batch:(\d+):(\d+)$/);
      const rangeStart = match ? Number(match[1]) : NaN;
      const rangeEnd = match ? Number(match[2]) : NaN;

      if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd)) {
        return true;
      }

      void deps.runWorkflowActionShortcut(
        "generate_outlines",
        {
          projectId: snapshot.projectId,
          rangeStart,
          rangeEnd,
          keepCurrentStep: true,
        },
        label,
      );
      return true;
    }

    if (value === "script:outline-stop") {
      if (deps.interruptWorkflowShortcut) {
        deps.interruptWorkflowShortcut();
      } else {
        abortOutlineGeneration();
      }
      return true;
    }

    if (value === "script:outline-regenerate-all") {
      void deps.runWorkflowActionShortcut(
        "generate_outlines",
        { projectId: snapshot.projectId, regenerateAll: true, keepCurrentStep: true },
        label,
      );
      return true;
    }

    if (value.startsWith("script:outline-regenerate:")) {
      const match = value.match(/^script:outline-regenerate:(\d+)(?::([\s\S]+))?$/);
      const encodedInstruction = match?.[2] ? decodeURIComponent(match[2]) : undefined;
      const episodeNumber =
        typeof input?.episodeNumber === "number"
          ? input.episodeNumber
          : match
            ? Number(match[1])
            : NaN;
      const customInstruction =
        typeof input?.customInstruction === "string"
          ? input.customInstruction
          : encodedInstruction;

      if (!Number.isFinite(episodeNumber)) {
        return true;
      }

      void deps.runWorkflowActionShortcut(
        "generate_outlines",
        {
          projectId: snapshot.projectId,
          episodeNumbers: [episodeNumber],
          keepCurrentStep:
            typeof input?.keepCurrentStep === "boolean" ? input.keepCurrentStep : true,
          ...(customInstruction?.trim() ? { customInstruction: customInstruction.trim() } : {}),
        },
        label,
      );
      return true;
    }

    if (value.includes("分集目录")) {
      void deps.runWorkflowActionShortcut(
        "generate_directory",
        { projectId: snapshot.projectId },
        label,
      );
      return true;
    }

    // 正文/撰写/集数 检查必须在"细纲"之前，避免"细纲已就绪，生成第 X 集正文"被误路由到 generate_outlines
    const episodeMatch = value.match(/第\s*(\d+)\s*集/);
    if (value.includes("正文") || value.includes("撰写") || (episodeMatch && !value.includes("细纲"))) {
      const episodeNumber = episodeMatch ? Number(episodeMatch[1]) : undefined;
      void deps.runWorkflowActionShortcut(
        "generate_episode",
        {
          projectId: snapshot.projectId,
          ...(typeof input?.durationSeconds === "number" ? { durationSeconds: input.durationSeconds } : {}),
          ...(Number.isFinite(episodeNumber) ? { episodeNumber } : {}),
        },
        label,
      );
      return true;
    }

    if (value.includes("细纲")) {
      void deps.runWorkflowActionShortcut(
        "generate_outlines",
        { projectId: snapshot.projectId },
        label,
      );
      return true;
    }

    if (value.includes("合规审查")) {
      void deps.runWorkflowActionShortcut("run_compliance_review", buildComplianceRunInput(snapshot), label);
      return true;
    }

    if (value.includes("导出")) {
      void deps.runWorkflowActionShortcut(
        "export_project",
        { projectId: snapshot.projectId },
        label,
      );
      return true;
    }

    if (value === "script:compliance-run:text" || value === "script:compliance-run:script") {
      void deps.runWorkflowActionShortcut(
        "run_compliance_review",
        buildComplianceRunInput(snapshot, {
          reviewMode: value.endsWith(":script") ? "script" : "text",
        }),
        label,
      );
      return true;
    }

    if (value.startsWith("script:compliance-set-strictness:")) {
      const strictness = value.replace("script:compliance-set-strictness:", "");
      void deps.runWorkflowActionShortcut(
        "update_compliance_workspace",
        { projectId: snapshot.projectId, strictness },
        label,
      );
      return true;
    }

    if (value.startsWith("script:compliance-set-model:")) {
      const model = value.replace("script:compliance-set-model:", "");
      void deps.runWorkflowActionShortcut(
        "update_compliance_workspace",
        { projectId: snapshot.projectId, model },
        label,
      );
      return true;
    }

    if (value === "script:compliance-import") {
      void (async () => {
        const file = await pickComplianceImportFile();
        if (!file) return;
        await deps.runWorkflowActionShortcut(
          "update_compliance_workspace",
          { projectId: snapshot.projectId, file },
          label,
        );
      })();
      return true;
    }

    if (value === "script:compliance-auto-adjust") {
      void deps.runWorkflowActionShortcut(
        "auto_adjust_compliance",
        { projectId: snapshot.projectId, sourceStrategy: "project-script" },
        label,
      );
      return true;
    }

    if (value === "script:compliance-undo" || value === "script:compliance-redo") {
      void deps.runWorkflowActionShortcut(
        "update_compliance_workspace",
        {
          projectId: snapshot.projectId,
          operation: value.endsWith(":redo") ? "redo" : "undo",
        },
        label,
      );
      return true;
    }

    if (value === "script:compliance-toggle-dialogue:on" || value === "script:compliance-toggle-dialogue:off") {
      void deps.runWorkflowActionShortcut(
        "update_compliance_workspace",
        {
          projectId: snapshot.projectId,
          dialogueReviewEnabled: value.endsWith(":on"),
        },
        label,
        { skipUserBubble: true, skipAssistantSummary: true },
      );
      return true;
    }

    if (value === "script:compliance-export:docx" || value === "script:compliance-export:xlsx") {
      void deps.runWorkflowActionShortcut(
        "export_compliance_palette",
        {
          projectId: snapshot.projectId,
          format: value.endsWith(":xlsx") ? "xlsx" : "docx",
        },
        label,
        { skipUserBubble: true, skipAssistantSummary: true },
      );
      return true;
    }

    const complianceApply = parseComplianceApplyValue(value);
    if (complianceApply) {
      void deps.runWorkflowActionShortcut(
        "apply_compliance_adjustment",
        {
          projectId: snapshot.projectId,
          riskId: complianceApply.riskId,
          replacement: complianceApply.replacement,
        },
        label,
      );
      return true;
    }

    if (value.startsWith("script:compliance-resolve-risk:")) {
      const riskId = value.replace("script:compliance-resolve-risk:", "").trim();
      if (!riskId) return true;
      void deps.runWorkflowActionShortcut(
        "apply_compliance_adjustment",
        {
          projectId: snapshot.projectId,
          riskId,
        },
        label,
      );
      return true;
    }

    if (value === "script:character-lock-next") {
      if (!isCharacterStage) return true;
      const nextCard = deps.listUnlockedCharacterCards(snapshot)[0];
      if (!nextCard) return true;

      void deps.runWorkflowActionShortcut(
        "lock_character_cards",
        { projectId: snapshot.projectId, targetIds: [nextCard.id] },
        label,
      );
      return true;
    }

    if (value === "script:character-list") {
      if (!isCharacterStage) return true;
      const nextQuestion = deps.buildCharacterCardListQuestion(snapshot);
      if (nextQuestion) {
        deps.showChoicePopover(label, "先选一张角色卡。", nextQuestion);
      }
      return true;
    }

    if (value.startsWith("script:character-item:")) {
      if (!isCharacterStage) return true;
      const cardId = value.replace("script:character-item:", "");
      const card = deps.findCharacterCard(snapshot, cardId);
      const nextQuestion = deps.buildCharacterCardDecisionQuestion(snapshot, cardId);
      if (!card || !nextQuestion) return true;

      deps.showChoicePopover(label, `已定位角色卡「${card.name}」，现在要锁定还是继续深化？`, nextQuestion);
      return true;
    }

    if (value.startsWith("script:character-lock:")) {
      if (!isCharacterStage) return true;
      const cardId = value.replace("script:character-lock:", "");
      void deps.runWorkflowActionShortcut(
        "lock_character_cards",
        { projectId: snapshot.projectId, targetIds: [cardId] },
        label,
      );
      return true;
    }

    if (value.startsWith("script:character-refine:")) {
      if (!isCharacterStage) return true;
      const cardId = value.replace("script:character-refine:", "");
      const card = deps.findCharacterCard(snapshot, cardId);
      if (!card) return true;

      void deps.send(
        `请继续深化角色「${card.name}」的状态卡。角色定位：${card.role}。核心冲突：${card.coreConflict}。目标：${card.desire}。风险：${card.riskNote}。关系轴：${card.relationshipAxis.join("、") || "待补充"}。`,
        label,
      );
      return true;
    }

    if (value === "script:compliance-resolve-high") {
      if (!isComplianceStage) return true;
      const targetIds = deps
        .listPendingCompliancePackets(snapshot)
        .filter((packet) => packet.riskLevel === "high")
        .map((packet) => packet.id);

      if (!targetIds.length) {
        const nextQuestion = deps.buildComplianceListQuestion(snapshot);
        if (nextQuestion) {
          deps.showChoicePopover(label, "当前没有高风险项，先看修订列表。", nextQuestion);
        }
        return true;
      }

      void deps.runWorkflowActionShortcut(
        "resolve_compliance_revisions",
        { projectId: snapshot.projectId, targetIds },
        label,
      );
      return true;
    }

    if (value === "script:compliance-list") {
      if (!isComplianceStage) return true;
      const nextQuestion = deps.buildComplianceListQuestion(snapshot);
      if (nextQuestion) {
        deps.showChoicePopover(label, "先选一条修订包。", nextQuestion);
      }
      return true;
    }

    if (value === "script:compliance-rerun") {
      if (!isComplianceStage) return true;
      void deps.runWorkflowActionShortcut(
        "run_compliance_review",
        buildComplianceRunInput(snapshot, { smartRerun: true }),
        label,
      );
      return true;
    }

    if (value.startsWith("script:compliance-item:")) {
      if (!isComplianceStage) return true;
      const packetId = value.replace("script:compliance-item:", "");
      const packet = deps.findCompliancePacket(snapshot, packetId);
      const nextQuestion = deps.buildComplianceDecisionQuestion(snapshot, packetId);
      if (!packet || !nextQuestion) return true;

      deps.showChoicePopover(label, `已定位修订包「${packet.issueTitle}」，现在标记已处理还是继续改写？`, nextQuestion);
      return true;
    }

    if (value.startsWith("script:compliance-resolve:")) {
      if (!isComplianceStage) return true;
      const packetId = value.replace("script:compliance-resolve:", "");
      void deps.runWorkflowActionShortcut(
        "resolve_compliance_revisions",
        { projectId: snapshot.projectId, targetIds: [packetId] },
        label,
      );
      return true;
    }

    if (value.startsWith("script:compliance-rewrite:")) {
      if (!isComplianceStage) return true;
      const packetId = value.replace("script:compliance-rewrite:", "");
      const packet = deps.findCompliancePacket(snapshot, packetId);
      if (!packet) return true;

      void deps.send(
        `请根据这条合规修订继续改写当前项目：${packet.issueTitle}。风险等级：${packet.riskLevel}。建议：${packet.recommendation}`,
        label,
      );
      return true;
    }

    if (value === "script:beat-lock-next") {
      if (!isBeatStage) return true;
      const nextPacket = deps.listUnlockedBeatPackets(snapshot)[0];
      if (!nextPacket) return true;

      void deps.runWorkflowActionShortcut(
        "lock_story_beats",
        { projectId: snapshot.projectId, targetIds: [nextPacket.id] },
        label,
      );
      return true;
    }

    if (value === "script:beat-lock-drafted") {
      if (!isBeatStage) return true;
      const targetIds = deps
        .listUnlockedBeatPackets(snapshot)
        .filter((packet) => packet.status === "drafted")
        .map((packet) => packet.id);

      if (!targetIds.length) {
        const nextQuestion = deps.buildBeatPacketListQuestion(snapshot);
        if (nextQuestion) {
          deps.showChoicePopover(label, "当前没有已起草的情节 beat，先看剧情列表。", nextQuestion);
        }
        return true;
      }

      void deps.runWorkflowActionShortcut(
        "lock_story_beats",
        { projectId: snapshot.projectId, targetIds },
        label,
      );
      return true;
    }

    if (value === "script:beat-list") {
      if (!isBeatStage) return true;
      const nextQuestion = deps.buildBeatPacketListQuestion(snapshot);
      if (nextQuestion) {
        deps.showChoicePopover(label, "先选一条剧情 beat。", nextQuestion);
      }
      return true;
    }

    if (value.startsWith("script:beat-item:")) {
      if (!isBeatStage) return true;
      const packetId = value.replace("script:beat-item:", "");
      const packet = deps.findBeatPacket(snapshot, packetId);
      const nextQuestion = deps.buildBeatPacketDecisionQuestion(snapshot, packetId);
      if (!packet || !nextQuestion) return true;

      deps.showChoicePopover(
        label,
        `已定位第 ${packet.episodeNumber} 集 ${packet.title}，现在锁定还是继续写？`,
        nextQuestion,
      );
      return true;
    }

    if (value.startsWith("script:beat-lock:")) {
      if (!isBeatStage) return true;
      const packetId = value.replace("script:beat-lock:", "");
      void deps.runWorkflowActionShortcut(
        "lock_story_beats",
        { projectId: snapshot.projectId, targetIds: [packetId] },
        label,
      );
      return true;
    }

    if (value.startsWith("script:beat-write:")) {
      if (!isBeatStage) return true;
      const episodeNumber = Number(value.replace("script:beat-write:", ""));
      if (!Number.isFinite(episodeNumber)) return true;

      void deps.runWorkflowActionShortcut(
        "generate_episode",
        { projectId: snapshot.projectId, episodeNumber },
        label,
      );
      return true;
    }

    if (value.startsWith("script:episode-generate:")) {
      const rawEpisodeNumber = value.replace("script:episode-generate:", "");
      const episodeNumber = Number(rawEpisodeNumber);

      void deps.runWorkflowActionShortcut(
        "generate_episode",
        {
          projectId: snapshot.projectId,
          ...(Number.isFinite(episodeNumber) ? { episodeNumber } : {}),
        },
        label,
      );
      return true;
    }

    if (value.startsWith("script:episode-generate-range:")) {
      const rawSelection = value.replace("script:episode-generate-range:", "");
      const episodeNumbers = parseEpisodeNumberSelection(rawSelection);
      if (!episodeNumbers.length) return true;

      void deps.runWorkflowActionShortcut(
        "generate_episode_batch",
        {
          projectId: snapshot.projectId,
          episodeNumbers,
          ...(typeof input?.durationSeconds === "number" ? { durationSeconds: input.durationSeconds } : {}),
        },
        label,
      );
      return true;
    }

    if (value === "script:episode-review:batch-group" || value.startsWith("script:episode-review:single-group:")) {
      return true;
    }

    if (value === "script:episode-review") {
      if (deps.onDirectBatchReview) {
        deps.setPopoverOverride?.(null);
        deps.onDirectBatchReview();
      } else {
        void deps.runWorkflowActionShortcut(
          "review_episode_quality",
          { projectId: snapshot.projectId, defaultReviewCount: 10 },
          label,
        );
      }
      return true;
    }

    if (value === "script:episode-review:remaining") {
      void deps.runWorkflowActionShortcut(
        "review_episode_quality",
        { projectId: snapshot.projectId, reviewRemaining: true, defaultReviewCount: 10 },
        label,
      );
      return true;
    }

    if (value === "script:episode-review:single") {
      // 弹出三级菜单：选择要自检的集数
      const epArtifact = snapshot.artifacts.find(
        (a) => a.kind === "episode" && a.payload?.type === "episodes+batchProgress",
      );
      const doneEntries =
        epArtifact?.payload?.type === "episodes+batchProgress"
          ? epArtifact.payload.entries.filter((e) => e.status === "done")
          : [];

      if (!doneEntries.length) {
        deps.showChoicePopover(label, "当前还没有已完成的集数可以自检。", {
          id: `${snapshot.projectId}-review-single-empty`,
          title: "暂无可自检集数",
          description: "请先完成至少一集正文撰写。",
          options: [],
          allowCustomInput: false,
          submissionMode: "immediate",
          multiSelect: false,
          stepIndex: 0,
          totalSteps: 1,
          answerKey: "review-single-empty",
        });
        return true;
      }

      const episodeOptions = doneEntries.map((e) => ({
        id: `${snapshot.projectId}-review-single-ep-${e.number}`,
        label: `第 ${e.number} 集${e.title ? `·${e.title}` : ""}`,
        value: `script:episode-review:single:${e.number}`,
        rationale: `对第 ${e.number} 集正文进行质量自检，在面板内展示评分结果。`,
      }));

      deps.showChoicePopover(label, "选择要自检的集数：", {
        id: `${snapshot.projectId}-review-single-pick`,
        title: "选择自检集数",
        description: "选择后将在右侧面板内展示评分结果。",
        options: episodeOptions,
        allowCustomInput: false,
        submissionMode: "immediate",
        multiSelect: false,
        stepIndex: 0,
        totalSteps: 1,
        answerKey: "review-single-pick",
      });
      return true;
    }

    if (value.startsWith("script:episode-review:single:")) {
      const epNum = Number(value.replace("script:episode-review:single:", ""));
      if (!Number.isFinite(epNum)) return true;
      deps.setPopoverOverride?.(null);
      if (deps.onDirectSingleReview) {
        deps.onDirectSingleReview(epNum);
      } else {
        void deps.runWorkflowActionShortcut(
          "review_episode_quality",
          { projectId: snapshot.projectId, episodeNumbers: [epNum] },
          label,
        );
      }
      return true;
    }

    if (value.startsWith("script:episode-review:count:")) {
      const rawCount = value.replace(/^script:episode-review:count:(?:custom:)?/, "");
      const reviewCount = Number(rawCount);
      if (!Number.isFinite(reviewCount)) return true;

      void deps.runWorkflowActionShortcut(
        "review_episode_quality",
        { projectId: snapshot.projectId, reviewCount },
        label,
      );
      return true;
    }

    if (value.startsWith("script:episode-review:episodes:")) {
      const rawSelection = value.replace("script:episode-review:episodes:", "");
      const episodeNumbers = parseEpisodeNumberSelection(rawSelection);
      if (!episodeNumbers.length) return true;

      void deps.runWorkflowActionShortcut(
        "review_episode_quality",
        { projectId: snapshot.projectId, episodeNumbers },
        label,
      );
      return true;
    }

    if (value === "script:episode-generate-batch" || value === "script:episode-fill-missing") {
      void deps.runWorkflowActionShortcut(
        "generate_episode_batch",
        {
          projectId: snapshot.projectId,
          ...(value === "script:episode-fill-missing" ? { fillMissingEpisodes: true } : {}),
          ...(typeof input?.durationSeconds === "number" ? { durationSeconds: input.durationSeconds } : {}),
        },
        label,
      );
      return true;
    }

    if (value.startsWith("script:episode-duration:")) {
      return true;
    }

    if (value === "script:episode-review:repair-worst") {
      void deps.runWorkflowActionShortcut(
        "rewrite_episode_from_review",
        { projectId: snapshot.projectId },
        label,
      );
      return true;
    }

    if (value === "script:episode-review:repair-all") {
      void deps.runWorkflowActionShortcut(
        "rewrite_episode_from_review",
        { projectId: snapshot.projectId, repairAll: true, repairLimit: 10 },
        label,
      );
      return true;
    }

    if (value.startsWith("script:episode-review:repair:")) {
      const episodeNumber = Number(value.replace("script:episode-review:repair:", ""));
      if (!Number.isFinite(episodeNumber)) return true;
      const customInstruction = typeof input?.instruction === "string" ? input.instruction : undefined;
      void deps.runWorkflowActionShortcut(
        "rewrite_episode_from_review",
        {
          projectId: snapshot.projectId,
          episodeNumber,
          ...(customInstruction ? { customInstruction } : {}),
        },
        label,
      );
      return true;
    }

    if (
      value === "script:episode-compliance" ||
      value === "script:episode-compliance:text" ||
      value === "script:episode-compliance:script"
    ) {
      void deps.runWorkflowActionShortcut(
        "run_compliance_review",
        buildComplianceRunInput(snapshot, {
          ...(value.endsWith(":text")
            ? { reviewMode: "text" as const }
            : value.endsWith(":script")
              ? { reviewMode: "script" as const }
              : {}),
        }),
        label,
      );
      return true;
    }

    if (value === "script:episode-skip-compliance" || value === "script:skip-compliance-review") {
      void deps.runWorkflowActionShortcut("skip_compliance_review", { projectId: snapshot.projectId }, label);
      return true;
    }

    if (value === "script:compliance-mode:text" || value === "script:compliance-mode:script") {
      if (!isComplianceStage) return true;
      void deps.runWorkflowActionShortcut(
        "run_compliance_review",
        buildComplianceRunInput(snapshot, {
          reviewMode: value.endsWith(":script") ? "script" : "text",
        }),
        label,
      );
      return true;
    }

    if (value === "script:export-document") {
      void deps.runWorkflowActionShortcut("export_project", { projectId: snapshot.projectId }, label);
      return true;
    }

    if (value === "script:export-refine") {
      void deps.runWorkflowActionShortcut(
        "refine_export_document",
        { projectId: snapshot.projectId },
        label,
      );
      return true;
    }

    if (value === "script:export-patch") {
      void deps.runWorkflowActionShortcut(
        "analyze_export_patch",
        { projectId: snapshot.projectId },
        label,
      );
      return true;
    }

    if (value === "script:export-video") {
      if (deps.onVideoKickoff) {
        deps.onVideoKickoff();
      } else {
        void deps.runWorkflowActionShortcut(
          "prepare_video_generation",
          {
            projectId: snapshot.projectId,
            sourceProjectId: snapshot.projectId,
            title: snapshot.title,
          },
          label,
        );
      }
      return true;
    }

    // 快速拼接：父级菜单展开子选项，本身不触发工作流
    if (value === "script:export-quick-splice" || value === "script:export-group") {
      return true;
    }

    // 本地导出操作：复制 / 下载.md / Word / 分集下载
    if (value === "script:export-copy") {
      deps.onExportLocalAction?.("copy");
      return true;
    }

    if (value === "script:export-download-md") {
      deps.onExportLocalAction?.("download-md");
      return true;
    }

    if (value === "script:export-word") {
      deps.onExportLocalAction?.("word");
      return true;
    }

    if (value === "script:export-episodes-download") {
      deps.onExportLocalAction?.("episodes-download");
      return true;
    }

    return false;
  };
}
