import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement, useState, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AskUserQuestionRequest } from "@/lib/agent/tools/ask-user-question";
import type { StudioRuntimeState, StudioSessionState } from "@/lib/home-agent/types";
import { createDramaSnapshot, createVideoSnapshot } from "@/lib/home-agent/project-store";
import { createEmptyDramaProject } from "@/types/drama";
import { recQuestion } from "./home-agent-project-questions";
import { buildProjectSuggestionKey } from "./home-agent-session-utils";

const STUDIO_SESSION_KEY = "storyforge-home-agent-session-v1";
const STUDIO_PROJECT_SESSIONS_KEY = "storyforge-home-agent-project-sessions-v1";
const MAINTENANCE_REPORTS_KEY = "storyforge-maintenance-reports-v1";
const SKILL_DRAFTS_KEY = "storyforge-skill-drafts-v1";
const DRAMA_PROJECTS_KEY = "storyforge_drama_projects";
const VIDEO_PROJECTS_KEY = "storyforge_projects";
const DESKTOP_SIDEBAR_COLLAPSE_KEY = "storyforge-home-agent-desktop-sidebar-collapsed-v1";
const TASK_STORAGE_KEY = "storyforge-home-agent-tasks-v1";

let assistantReply = "好的，我们开始。";
let lastQueryEngineConfig: Record<string, unknown> | null = null;
let lastSubmittedPrompt = "";
let lastEngineInterrupt = vi.fn();
let mockSubmitMessageImpl: ((prompt?: string) => AsyncGenerator<unknown, void, unknown>) | null = null;
let onMockEngineInterrupt: (() => void) | null = null;
const consumeAgentHandoff = vi.fn(() => null);
let mockApiConfig = {
  claudeKey: "test-key",
  claudeEndpoint: "https://example.test",
  geminiKey: "",
  geminiEndpoint: "",
  gptKey: "",
  gptEndpoint: "",
  jimengKey: "seedance-key",
  jimengEndpoint: "https://video.example.test",
  jimengExecutionMode: "api" as "api" | "cli",
};

const resolveAskUserQuestion = vi.fn(() => true);
const rejectAskUserQuestion = vi.fn(() => true);
const refineCompactedConversationSummary = vi.fn(async () => "目标与约束\n- 用户要继续推进项目\n已确认内容\n- 已有历史结论\n待继续推进\n- 继续完成当前阶段");
const dreaminaCliGetStatus = vi.fn(async () => ({
  ok: false,
  installed: false,
  loggedIn: false,
  message: "未检测到 Dreamina CLI",
}));
const runWorkflowAction = vi.fn(
  async (action: string, input: Record<string, unknown>, runtime: StudioRuntimeState) => {
    if (action === "approve_skill_draft" || action === "reject_skill_draft") {
      const draftId = typeof input.draftId === "string" ? input.draftId : "";
      const status = action === "approve_skill_draft" ? "approved" : "rejected";
      const storedDrafts = JSON.parse(localStorage.getItem(SKILL_DRAFTS_KEY) || "[]") as Array<{
        id: string;
        status: string;
        proposedSkillName?: string;
      }>;
      const nextDrafts = storedDrafts.map((draft) =>
        draft.id === draftId ? { ...draft, status } : draft,
      );
      localStorage.setItem(SKILL_DRAFTS_KEY, JSON.stringify(nextDrafts));
      const target = nextDrafts.find((draft) => draft.id === draftId);
      const storedReports = JSON.parse(localStorage.getItem(MAINTENANCE_REPORTS_KEY) || "[]");
      const nextReports = [
        {
          id: `report-${action}-${draftId}`,
          createdAt: "2026-04-03T00:40:00.000Z",
          summary:
            status === "approved"
              ? `已将《${target?.proposedSkillName ?? "未命名草案"}》加入已批准技能候选。`
              : `已将《${target?.proposedSkillName ?? "未命名草案"}》从待审核草案中驳回。`,
          compressedConversationCount: 0,
          archivedProjectCount: 0,
          clearedCacheKeys: [],
          mergedDraftCount: 0,
          notes: [],
        },
        ...storedReports,
      ];
      localStorage.setItem(MAINTENANCE_REPORTS_KEY, JSON.stringify(nextReports));

      return {
        summary:
          status === "approved"
            ? `已批准技能草案《${target?.proposedSkillName ?? "未命名草案"}》，并加入已批准候选队列。`
            : `已驳回技能草案《${target?.proposedSkillName ?? "未命名草案"}》。`,
        projectSnapshot: runtime.currentProjectSnapshot ?? null,
        data: {
          projectSnapshot: runtime.currentProjectSnapshot ?? null,
          skillDrafts: nextDrafts,
          maintenanceReports: nextReports,
        },
      };
    }

    if (action === "export_approved_skill_drafts") {
      const storedReports = JSON.parse(localStorage.getItem(MAINTENANCE_REPORTS_KEY) || "[]");
      const nextReports = [
        {
          id: "report-export-approved",
          createdAt: "2026-04-03T00:50:00.000Z",
          summary: "已将 1 份已批准技能草案导出到本地候选目录。",
          compressedConversationCount: 0,
          archivedProjectCount: 0,
          clearedCacheKeys: [],
          mergedDraftCount: 0,
          notes: [
            "导出目录：D:/StoryForgeFiles/home-agent/skills-drafts/approved",
            "索引文件：D:/StoryForgeFiles/home-agent/skills-drafts/approved/README.md",
          ],
        },
        ...storedReports,
      ];
      localStorage.setItem(MAINTENANCE_REPORTS_KEY, JSON.stringify(nextReports));

      return {
        summary: "已将 1 份已批准技能草案导出到本地候选目录。\n目录：D:/StoryForgeFiles/home-agent/skills-drafts/approved",
        projectSnapshot: runtime.currentProjectSnapshot ?? null,
        data: {
          projectSnapshot: runtime.currentProjectSnapshot ?? null,
          maintenanceReports: nextReports,
        },
      };
    }

    if (action === "export_approved_skill_draft_bundle") {
      const storedReports = JSON.parse(localStorage.getItem(MAINTENANCE_REPORTS_KEY) || "[]");
      const nextReports = [
        {
          id: "report-export-bundle",
          createdAt: "2026-04-03T00:55:00.000Z",
          summary: "已生成 1 份已批准技能草案的 bundle 预览。",
          compressedConversationCount: 0,
          archivedProjectCount: 0,
          clearedCacheKeys: [],
          mergedDraftCount: 0,
          notes: [
            "Markdown: D:/StoryForgeFiles/home-agent/skills-drafts/approved/bundle-preview.md",
            "JSON: D:/StoryForgeFiles/home-agent/skills-drafts/approved/bundle-preview.json",
          ],
        },
        ...storedReports,
      ];
      localStorage.setItem(MAINTENANCE_REPORTS_KEY, JSON.stringify(nextReports));

      return {
        summary:
          "已生成 1 份已批准技能草案的 bundle 预览。\nMarkdown：D:/StoryForgeFiles/home-agent/skills-drafts/approved/bundle-preview.md",
        projectSnapshot: runtime.currentProjectSnapshot ?? null,
        data: {
          projectSnapshot: runtime.currentProjectSnapshot ?? null,
          maintenanceReports: nextReports,
        },
      };
    }

    if (action === "export_approved_skill_install_candidates") {
      const storedReports = JSON.parse(localStorage.getItem(MAINTENANCE_REPORTS_KEY) || "[]");
      const nextReports = [
        {
          id: "report-export-install-candidates",
          createdAt: "2026-04-03T01:00:00.000Z",
          summary: "已整理 1 份正式 Skill 安装候选文件，等待人工审核。",
          compressedConversationCount: 0,
          archivedProjectCount: 0,
          clearedCacheKeys: [],
          mergedDraftCount: 0,
          notes: [
            "候选目录：D:/StoryForgeFiles/home-agent/skills-candidates/pending-install",
            "审核清单：D:/StoryForgeFiles/home-agent/skills-candidates/pending-install/INSTALL-REVIEW.md",
            "这些候选文件不会自动进入 .claude/skills，也不会自动生效。",
          ],
        },
        ...storedReports,
      ];
      localStorage.setItem(MAINTENANCE_REPORTS_KEY, JSON.stringify(nextReports));

      return {
        summary:
          "已整理 1 份正式 Skill 安装候选文件，等待人工审核。\n目录：D:/StoryForgeFiles/home-agent/skills-candidates/pending-install",
        projectSnapshot: runtime.currentProjectSnapshot ?? null,
        data: {
          projectSnapshot: runtime.currentProjectSnapshot ?? null,
          maintenanceReports: nextReports,
        },
      };
    }

    if (action === "export_video_production_bundle") {
      const nextSnapshot =
        runtime.currentProjectSnapshot && runtime.currentProjectSnapshot.projectKind === "video"
          ? {
              ...runtime.currentProjectSnapshot,
              recommendedActions: [
                "预览生产状态摘要",
                "打开生产状态目录",
                ...runtime.currentProjectSnapshot.recommendedActions,
              ].filter((item, index, list) => list.indexOf(item) === index),
            }
          : runtime.currentProjectSnapshot ?? null;
      return {
        summary:
          "已导出《雨夜追击预告片》的生产状态包。\n目录：D:/StoryForgeFiles/home-agent/production-state/雨夜追击预告片-video-project-export",
        projectSnapshot: nextSnapshot,
        data: {
          projectSnapshot: nextSnapshot,
        },
      };
    }

    if (action === "preview_video_production_bundle") {
      return {
        summary:
          "当前《雨夜追击预告片》的生产状态包摘要如下：\n\n- 场景数：1\n- 资产清单：0 项\n- 镜头指令包：0 个\n- 待审阅项：0 条",
        projectSnapshot: runtime.currentProjectSnapshot ?? null,
        data: {
          projectSnapshot: runtime.currentProjectSnapshot ?? null,
        },
      };
    }

    if (action === "open_video_production_bundle_directory") {
      return {
        summary:
          "已为你打开生产状态目录：D:/StoryForgeFiles/home-agent/production-state/雨夜追击预告片-video-project-export",
        projectSnapshot: runtime.currentProjectSnapshot ?? null,
        data: {
          projectSnapshot: runtime.currentProjectSnapshot ?? null,
        },
      };
    }

    return {
      summary: `workflow:${action}`,
      projectSnapshot: runtime.currentProjectSnapshot ?? null,
      data: {
        projectSnapshot: runtime.currentProjectSnapshot ?? null,
      },
    };
  },
);

vi.mock("framer-motion", () => {
  const motion = new Proxy(
    {},
    {
      get: (_target, key) => {
        const tag = typeof key === "string" ? key : "div";

        return ({ children, ...props }: Record<string, unknown> & { children?: ReactNode }) => {
          const {
            animate,
            exit,
            initial,
            layout,
            layoutId,
            transition,
            variants,
            whileHover,
            whileInView,
            whileTap,
            ...rest
          } = props;

          void animate;
          void exit;
          void initial;
          void layout;
          void layoutId;
          void transition;
          void variants;
          void whileHover;
          void whileInView;
          void whileTap;

          return createElement(tag, rest, children);
        };
      },
    },
  );

  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
    LayoutGroup: ({ children }: { children?: ReactNode }) => <>{children}</>,
    motion,
    useReducedMotion: () => true,
  };
});

vi.mock("@/pages/Settings", () => ({
  default: ({ onClose }: { onClose?: () => void }) => (
    <div>
      <div>settings-panel</div>
      <button type="button" onClick={onClose}>
        close-settings
      </button>
    </div>
  ),
}));

vi.mock("@/components/BrandMark", () => ({
  default: () => <div>brand-mark</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: Record<string, unknown> & { children?: ReactNode }) => <button {...props}>{children}</button>,
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: Record<string, unknown>) => <textarea {...props} />,
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children, open }: { children?: ReactNode; open?: boolean }) => (open ? <div>{children}</div> : null),
  SheetContent: ({ children, ...props }: Record<string, unknown> & { children?: ReactNode }) => <div {...props}>{children}</div>,
  SheetDescription: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("./ComposerChoiceModal", () => ({
  default: ({
    question,
    onSelect,
    onBack,
    onConfirm,
    onDismiss,
    canConfirm,
  }: {
    question: {
      title?: string;
      options?: Array<{ id: string; label: string; value: string }>;
      submissionMode?: string;
      multiSelect?: boolean;
    } | null;
    onSelect: (value: string, label: string) => void;
    onBack?: () => void;
    onConfirm?: () => void;
    onDismiss?: () => void;
    canConfirm?: boolean;
  }) =>
    question ? (
      <div>
        <div>{question.title}</div>
        {onBack ? (
          <button type="button" onClick={onBack}>
            返回上一步
          </button>
        ) : null}
        {question.options?.map((option) => (
          <button key={option.id} type="button" onClick={() => onSelect(option.value, option.label)}>
            {option.label}
          </button>
        ))}
        {(question.submissionMode === "confirm" || question.multiSelect) && onConfirm ? (
          <button type="button" onClick={onConfirm} disabled={!canConfirm}>
            继续
          </button>
        ) : null}
        {onDismiss ? (
          <button type="button" data-testid="mock-choice-dismiss" onClick={onDismiss}>
            关闭选项窗
          </button>
        ) : null}
      </div>
    ) : null,
}));

vi.mock("@/lib/agent/query-engine", () => ({
  QueryEngine: class MockQueryEngine {
    constructor(config: Record<string, unknown>) {
      lastQueryEngineConfig = config;
      lastEngineInterrupt = vi.fn();
    }

    interrupt() {
      lastEngineInterrupt();
      onMockEngineInterrupt?.();
    }

    async *submitMessage(prompt?: string) {
      if (mockSubmitMessageImpl) {
        yield* mockSubmitMessageImpl(prompt);
        return;
      }
      lastSubmittedPrompt = String(prompt ?? "");
      yield {
        type: "assistant",
        message: {
          message: {
            content: [{ type: "text", text: assistantReply }],
          },
        },
      };
    }
  },
}));

vi.mock("@/lib/agent/tools", () => ({
  createDefaultTools: () => [{ name: "AskUserQuestion" }, { name: "HomeStudioWorkflow" }],
}));

vi.mock("@/lib/api-config", () => ({
  API_CONFIG_UPDATED_EVENT: "storyforge:api-config-updated",
  SUPPORTED_MODEL_MAPPINGS: [
    {
      key: "claude-sonnet-4-6",
      label: "Claude Sonnet 4.6",
      provider: "claude",
      category: "text",
      defaultModelName: "claude-sonnet-4-6",
    },
    {
      key: "gemini-3-pro",
      label: "Gemini 3 Pro",
      provider: "gemini",
      category: "text",
      defaultModelName: "gemini-3-pro",
    },
    {
      key: "gpt-5.4",
      label: "GPT-5.4",
      provider: "gpt",
      category: "text",
      defaultModelName: "gpt-5.4",
    },
    {
      key: "grok-4.1",
      label: "Grok 4.1",
      provider: "grok",
      category: "text",
      defaultModelName: "grok-4.1",
    },
  ],
  getApiConfig: () => ({ ...mockApiConfig }),
  prefersJimengCli: (config: { jimengExecutionMode?: string }) => config.jimengExecutionMode === "cli",
  resolveJimengExecutionMode: (
    config: { jimengExecutionMode?: string },
    options?: { dreaminaCliAccessible?: boolean },
  ) => {
    if (config.jimengExecutionMode === "cli" || config.jimengExecutionMode === "api") {
      return config.jimengExecutionMode;
    }
    return options?.dreaminaCliAccessible ? "cli" : "api";
  },
  resolveConfiguredModelName: () => "claude-sonnet-4-6",
  saveApiConfig: (partial: Partial<typeof mockApiConfig>) => {
    mockApiConfig = {
      ...mockApiConfig,
      ...partial,
    };
    window.dispatchEvent(new CustomEvent("storyforge:api-config-updated"));
  },
  clearApiConfig: () => {
    mockApiConfig = {
      claudeKey: "",
      claudeEndpoint: "",
      geminiKey: "",
      geminiEndpoint: "",
      gptKey: "",
      gptEndpoint: "",
      jimengKey: "",
      jimengEndpoint: "",
      jimengExecutionMode: "api",
    };
    window.dispatchEvent(new CustomEvent("storyforge:api-config-updated"));
  },
}));

vi.mock("@/lib/agent/tools/ask-user-question", () => ({
  resolveAskUserQuestion,
  rejectAskUserQuestion,
}));

vi.mock("@/lib/home-agent/workflow-actions", () => ({
  runWorkflowAction,
}));

vi.mock("@/lib/home-agent/conversation-semantic-summary", () => ({
  refineCompactedConversationSummary,
}));

vi.mock("@/lib/dreamina-cli", () => ({
  dreaminaCliGetStatus,
}));

vi.mock("@/lib/agent-intake", () => ({
  consumeAgentHandoff,
}));

const { default: HomeAgentStudio } = await import("./HomeAgentStudio");
const { clearTaskRegistry, writeTask, getTask, updateTask } = await import("@/lib/agent/tools/task-tools");

/** Mirrors `Home.tsx` URL sync so settings open/close works in tests without a router. */
function HomeAgentStudioTestHarness() {
  const [utility, setUtility] = useState<"settings" | undefined>(undefined);
  return <HomeAgentStudio initialUtility={utility} onUtilityChange={setUtility} />;
}

function renderStudio(ui: ReactElement = <HomeAgentStudioTestHarness />) {
  return act(async () => {
    render(ui);
    await Promise.resolve();
  });
}

async function waitForVisibleText(text: string | RegExp, timeout = 4500) {
  await waitFor(
    () => {
      expect(screen.getByText(text)).toBeInTheDocument();
    },
    { timeout },
  );
}

function findSendButton() {
  return screen
    .getAllByRole("button")
    .find((button) => button.querySelector(".lucide-send,.lucide-loader2"));
}

async function fillComposer(value: string) {
  const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;

  await act(async () => {
    fireEvent.change(textarea, { target: { value } });
    fireEvent.input(textarea, { target: { value } });
    await Promise.resolve();
  });

  return textarea;
}

function seedDramaProject(projectId = "drama-project-1") {
  localStorage.setItem(
    DRAMA_PROJECTS_KEY,
    JSON.stringify([
      {
        id: projectId,
        dramaTitle: "契约婚姻反转录",
        currentStep: "creative-plan",
        updatedAt: "2026-04-02T00:00:00.000Z",
        createdAt: "2026-04-01T00:00:00.000Z",
        setup: {
          genres: ["都市言情"],
          audience: "女频",
          tone: "甜虐",
          ending: "HE",
          totalEpisodes: 40,
          targetMarket: "cn",
          creativeInput: "替父还债的女主和冷面继承人签下契约婚姻。",
        },
      },
    ]),
  );
}

function createQuestionRequest(overrides?: Partial<AskUserQuestionRequest>): AskUserQuestionRequest {
  return {
    id: "ask-1",
    allowCustomInput: true,
    submissionMode: "immediate",
    questions: [
      {
        header: "平台",
        question: "选择目标平台",
        multiSelect: false,
        options: [{ label: "抖音" }, { label: "小红书" }],
      },
    ],
    ...overrides,
  };
}

function createSession(overrides?: Partial<StudioSessionState>): StudioSessionState {
  return {
    sessionId: "session-current",
    compactedMessageCount: 0,
    mode: "active",
    messages: [
      {
        id: "assistant-1",
        role: "assistant",
        content: "继续保留第 2 集的张力。",
        createdAt: "2026-04-03T00:00:00.000Z",
      },
    ],
    currentProjectSnapshot: {
      projectId: "drama-project-1",
      projectKind: "script",
      title: "契约婚姻反转录",
      currentObjective: "继续完善创意方案。",
      derivedStage: "创意方案",
      agentSummary: "已进入创意方案阶段。",
      recommendedActions: ["继续推进角色设定", "重写创意方案"],
      artifacts: [],
    },
    recentMessageSummary: "assistant: 继续保留第 2 集的张力。",
    projectId: "drama-project-1",
    draft: "补充反派动机",
    qState: {
      request: createQuestionRequest({
        questions: [
          {
            header: "题材",
            question: "继续选择题材",
            multiSelect: false,
            options: [{ label: "都市" }, { label: "悬疑" }],
          },
        ],
      }),
      currentIndex: 0,
      answers: {},
      displayAnswers: {},
    },
    selectedValues: ["都市"],
    ...overrides,
  };
}

function createLongSession(): StudioSessionState {
  return createSession({
    qState: null,
    draft: "",
    selectedValues: [],
    recentMessageSummary: "",
    messages: Array.from({ length: 24 }, (_, index) => ({
      id: `long-msg-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `第 ${index + 1} 条长消息：围绕角色、市场、风格和分集推进的历史上下文。`,
      createdAt: `2026-04-03T00:00:${String(index).padStart(2, "0")}.000Z`,
    })),
  });
}

function createScriptMemorySession(overrides?: Partial<StudioSessionState>): StudioSessionState {
  return {
    mode: "active",
    messages: [
      {
        id: "assistant-script-1",
        role: "assistant",
        content: "我已经把当前剧本的关键中间层整理好了。",
        createdAt: "2026-04-03T00:00:00.000Z",
      },
    ],
    currentProjectSnapshot: {
      projectId: "script-project-current",
      projectKind: "script",
      title: "契约婚姻反转录",
      currentObjective: "先处理合规修订并锁定剧情 beat。",
      derivedStage: "合规审查",
      agentSummary: "当前有待处理修订包和未锁定剧情 beat。",
      recommendedActions: ["先处理修订包", "锁定剧情 beat"],
      artifacts: [],
      memory: {
        styleLock: null,
        worldModel: null,
        assetManifest: null,
        shotPackets: [],
        reviewQueue: [],
        characterStateCards: [
          {
            id: "script-project-current-character-card-0",
            name: "沈昭",
            role: "女主",
            coreConflict: "在自保与信任之间摇摆。",
            desire: "查清旧案。",
            riskNote: "一旦失手会失去全部筹码。",
            relationshipAxis: ["顾承砚：先婚后爱"],
            stageFocus: "继续强化人物拉扯",
            status: "locked",
          },
        ],
        storyBeatPackets: [
          {
            id: "script-project-current-beat-1",
            episodeNumber: 1,
            title: "签下契约",
            beatSummary: "女主被迫签下婚姻契约。",
            hook: "契约签订",
            payoff: "男主暴露隐藏目的。",
            status: "drafted",
          },
        ],
        complianceRevisionPackets: [
          {
            id: "script-project-current-compliance-1",
            issueTitle: "契约胁迫感过重",
            riskLevel: "high",
            recommendation: "改成双方交换条件，弱化单向控制。",
            status: "pending",
          },
        ],
      },
    },
    recentMessageSummary: "assistant: 我已经把当前剧本的关键中间层整理好了。",
    projectId: "script-project-current",
    draft: "",
    qState: null,
    selectedValues: [],
    ...overrides,
  };
}

function createCharactersStageSnapshot(projectId = "script-project-current") {
  const base = createEmptyDramaProject("traditional");
  return createDramaSnapshot({
    ...base,
    id: projectId,
    dramaTitle: "限定治愈：陆总的深夜私厨",
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:10:00.000Z",
    currentStep: "characters",
    setup: {
      genres: ["都市言情"],
      audience: "女频",
      tone: "治愈",
      ending: "HE",
      totalEpisodes: 24,
      targetMarket: "cn",
    },
    creativePlan: "创作方案已完成",
    characters: "",
  });
}

function seedCharactersStageDramaProject(projectId = "script-project-current") {
  const base = createEmptyDramaProject("traditional");
  localStorage.setItem(
    DRAMA_PROJECTS_KEY,
    JSON.stringify([
      {
        ...base,
        id: projectId,
        dramaTitle: "限定治愈：陆总的深夜私厨",
        createdAt: "2026-04-03T00:00:00.000Z",
        updatedAt: "2026-04-03T00:10:00.000Z",
        currentStep: "characters",
        setup: {
          genres: ["都市言情"],
          audience: "女频",
          tone: "治愈",
          ending: "HE",
          totalEpisodes: 24,
          targetMarket: "cn",
        },
        creativePlan: "创作方案已完成",
        characters: "",
      },
    ]),
  );
}

function seedVideoProject(
  projectId = "video-project-1",
  overrides: Record<string, unknown> = {},
) {
  localStorage.setItem(
    VIDEO_PROJECTS_KEY,
    JSON.stringify([
      {
        id: projectId,
        title: "夜雨追击预告片",
        script: "女主在雨夜奔跑，回头看见追兵。",
        targetPlatform: "抖音",
        shotStyle: "电影感近景",
        outputGoal: "预告片",
        productionNotes: "保留主角红衣和夜雨气氛。",
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "雨夜追击",
            description: "女主在雨夜奔跑，回头看见追兵。",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "中景，跟拍",
            duration: 5,
            storyboardUrl: "https://example.com/storyboard-1.jpg",
            videoUrl: "https://example.com/video-1.mp4",
            videoStatus: "completed",
          },
        ],
        characters: [
          {
            id: "char-1",
            name: "沈昭",
            description: "红衣、清冷、警觉",
            imageUrl: "https://example.com/char-1.jpg",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        sceneSettings: [
          {
            id: "setting-1",
            name: "雨夜长街",
            description: "冷色夜雨中的长街",
            imageUrl: "https://example.com/scene-1.jpg",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        artStyle: "live-action",
        currentStep: 4,
        systemPrompt: "",
        analysisSummary: "已编译镜头指令包，等待审阅。",
        storyboardPlan: "镜头 1：雨夜追击",
        videoPromptBatch: "镜头 1 提示词",
        sourceProjectId: "drama-1",
        createdAt: "2026-04-03T00:00:00.000Z",
        updatedAt: "2026-04-03T00:30:00.000Z",
        styleLock: null,
        worldModel: null,
        assetManifest: null,
        shotPackets: [
          {
            id: "packet:video-project-1:scene-1",
            sceneId: "scene-1",
            sceneNumber: 1,
            title: "雨夜追击",
            durationSec: 5,
            camera: {
              shotSize: "标准镜头",
              movement: "中景，跟拍",
            },
            characterRefs: [],
            sourceAssetIds: [],
            promptSeed: "女主在雨夜奔跑，回头看见追兵。",
            forbiddenChanges: ["不要改变主角色的识别特征和服装连续性"],
            renderMode: "img2video",
            reviewStatus: "pending",
          },
        ],
        reviewQueue: [
          {
            id: "review:packet:video-project-1:scene-1",
            title: "审阅镜头 1 · 雨夜追击",
            summary: "镜头已有可审阅素材，确认是否通过或需要重做。",
            targetIds: ["packet:video-project-1:scene-1"],
            status: "pending",
            createdAt: "2026-04-03T00:30:00.000Z",
            updatedAt: "2026-04-03T00:30:00.000Z",
          },
        ],
        ...overrides,
      },
    ]),
  );
}

function seedPromptBatchVideoProject(projectId = "video-project-prompt") {
  localStorage.setItem(
    VIDEO_PROJECTS_KEY,
    JSON.stringify([
      {
        id: projectId,
        title: "雨夜追击首轮出片",
        script: "女主在雨夜起跑，穿过长街，在巷口回头看见追兵。",
        targetPlatform: "抖音",
        shotStyle: "电影感预告片",
        outputGoal: "首轮镜头验证",
        productionNotes: "保留红衣、夜雨、追击感。",
        scenes: [
          {
            id: "scene-generate-1",
            sceneNumber: 1,
            sceneName: "雨夜起跑",
            description: "女主在雨夜冲出街口。",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "中近景，跟拍",
            duration: 5,
          },
          {
            id: "scene-generate-2",
            sceneNumber: 2,
            sceneName: "穿过长街",
            description: "红衣女主掠过霓虹长街。",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "横向追拍",
            duration: 5,
          },
          {
            id: "scene-generate-3",
            sceneNumber: 3,
            sceneName: "巷口回头",
            description: "她在巷口猛地回头，看见远处追兵。",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "手持推近",
            duration: 5,
          },
        ],
        characters: [
          {
            id: "char-prompt-1",
            name: "沈昭",
            description: "红衣、清冷、警觉",
            imageUrl: "https://example.com/char-prompt-1.jpg",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        sceneSettings: [
          {
            id: "setting-prompt-1",
            name: "夜雨长街",
            description: "霓虹冷色的夜雨街景",
            imageUrl: "https://example.com/scene-prompt-1.jpg",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        artStyle: "live-action",
        currentStep: 4,
        systemPrompt: "",
        analysisSummary: "视频提示词批次已经整理完，可直接发起第一轮出片。",
        storyboardPlan: "镜头 1-3 分镜已整理",
        videoPromptBatch: "镜头 1-3 提示词批次",
        sourceProjectId: "drama-prompt-1",
        createdAt: "2026-04-03T00:00:00.000Z",
        updatedAt: "2026-04-03T00:30:00.000Z",
        styleLock: null,
        worldModel: null,
        assetManifest: null,
        shotPackets: [],
        reviewQueue: [],
      },
    ]),
  );
}

function createRecoveryVideoProject(
  overrides?: Partial<Parameters<typeof createVideoSnapshot>[0]>,
): Parameters<typeof createVideoSnapshot>[0] {
  return {
    id: "video-recovery-project",
    title: "雨夜追击预告片",
    script: "女主在雨夜冲出街口，回头看见追兵。",
    targetPlatform: "抖音",
    shotStyle: "电影感短预告",
    outputGoal: "预告片",
    productionNotes: "",
    scenes: [],
    characters: [],
    sceneSettings: [],
    artStyle: "live-action",
    currentStep: 1,
    systemPrompt: "",
    analysisSummary: "视频桥接已建立。",
    storyboardPlan: "",
    videoPromptBatch: "",
    sourceProjectId: "drama-1",
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:10:00.000Z",
    styleLock: null,
    worldModel: null,
    assetManifest: null,
    shotPackets: [],
    reviewQueue: [],
    ...overrides,
  };
}

function seedGeneratingVideoProject(projectId = "video-project-running") {
  localStorage.setItem(
    VIDEO_PROJECTS_KEY,
    JSON.stringify([
      {
        id: projectId,
        title: "雨夜追击生成中",
        script: "女主在雨夜奔跑，追兵逐渐逼近。",
        targetPlatform: "抖音",
        shotStyle: "电影感预告片",
        outputGoal: "生成中批次回收",
        productionNotes: "维持夜雨、霓虹、追击氛围。",
        scenes: [
          {
            id: "scene-running-1",
            sceneNumber: 1,
            sceneName: "巷口冲刺",
            description: "女主冲进窄巷，雨水四溅。",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "跟拍推进",
            duration: 5,
            videoTaskId: "task-running-1",
            videoStatus: "processing",
          },
          {
            id: "scene-running-2",
            sceneNumber: 2,
            sceneName: "回头确认",
            description: "她急停回头，确认追兵距离。",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "手持推近",
            duration: 5,
            videoTaskId: "task-running-2",
            videoStatus: "queued",
          },
          {
            id: "scene-running-3",
            sceneNumber: 3,
            sceneName: "追兵逼近",
            description: "远景里追兵穿过雨幕。",
            characters: ["追兵"],
            dialogue: "",
            cameraDirection: "远景压缩",
            duration: 5,
            videoUrl: "https://example.com/video-running-3.mp4",
            videoStatus: "completed",
          },
        ],
        characters: [],
        sceneSettings: [],
        artStyle: "live-action",
        currentStep: 5,
        systemPrompt: "",
        analysisSummary: "当前已有镜头在后台生成，可继续轮询结果。",
        storyboardPlan: "镜头分镜已整理",
        videoPromptBatch: "镜头提示词已准备",
        sourceProjectId: "drama-running-1",
        createdAt: "2026-04-03T00:00:00.000Z",
        updatedAt: "2026-04-03T00:40:00.000Z",
        styleLock: null,
        worldModel: null,
        assetManifest: null,
        shotPackets: [],
        reviewQueue: [],
      },
    ]),
  );
}

function seedRepairVideoProject(projectId = "video-project-repair") {
  localStorage.setItem(
    VIDEO_PROJECTS_KEY,
    JSON.stringify([
      {
        id: projectId,
        title: "雨夜追击修复批次",
        script: "女主雨夜逃亡，追兵逼近。",
        targetPlatform: "抖音",
        shotStyle: "电影感预告片",
        outputGoal: "修复失败镜头",
        productionNotes: "保持红衣、冷色雨夜和追击氛围。",
        scenes: [
          {
            id: "scene-repair-1",
            sceneNumber: 1,
            sceneName: "雨巷回头",
            description: "女主在巷口回头确认追兵。",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "手持推近",
            duration: 5,
            videoUrl: "https://example.com/video-repair-1.mp4",
            videoStatus: "completed",
          },
        ],
        characters: [],
        sceneSettings: [],
        artStyle: "live-action",
        currentStep: 5,
        systemPrompt: "",
        analysisSummary: "已有镜头被判定需要重做，可直接继续修复。",
        storyboardPlan: "修复前分镜已存在",
        videoPromptBatch: "修复提示词已准备",
        sourceProjectId: "drama-repair-1",
        createdAt: "2026-04-03T00:00:00.000Z",
        updatedAt: "2026-04-03T00:45:00.000Z",
        styleLock: null,
        worldModel: null,
        assetManifest: null,
        shotPackets: [
          {
            id: "packet:video-project-repair:scene-repair-1",
            sceneId: "scene-repair-1",
            sceneNumber: 1,
            title: "雨巷回头",
            durationSec: 5,
            camera: {
              shotSize: "中景",
              movement: "手持推近",
            },
            characterRefs: [],
            sourceAssetIds: [],
            promptSeed: "女主在巷口回头确认追兵。",
            forbiddenChanges: ["不要改变人物服装与雨夜氛围"],
            renderMode: "img2video",
            reviewStatus: "redo",
          },
        ],
        reviewQueue: [
          {
            id: "review:packet:video-project-repair:scene-repair-1",
            title: "审阅镜头 1 · 雨巷回头",
            summary: "人物回头幅度不足，情绪拉扯不够。",
            targetIds: ["packet:video-project-repair:scene-repair-1"],
            status: "redo",
            reason: "需要强化回头瞬间的压迫感和追击临场感。",
            createdAt: "2026-04-03T00:45:00.000Z",
            updatedAt: "2026-04-03T00:45:00.000Z",
          },
        ],
      },
    ]),
  );
}

describe("HomeAgentStudio", () => {
  beforeEach(() => {
    vi.useRealTimers();
    assistantReply = "好的，我们开始。";
    lastQueryEngineConfig = null;
    lastSubmittedPrompt = "";
    lastEngineInterrupt = vi.fn();
    mockSubmitMessageImpl = null;
    onMockEngineInterrupt = null;
    mockApiConfig = {
      claudeKey: "test-key",
      claudeEndpoint: "https://example.test",
      geminiKey: "",
      geminiEndpoint: "",
      gptKey: "",
      gptEndpoint: "",
      jimengKey: "seedance-key",
      jimengEndpoint: "https://video.example.test",
      jimengExecutionMode: "api",
    };
    localStorage.clear();
    sessionStorage.clear();
    clearTaskRegistry();
    resolveAskUserQuestion.mockClear();
    rejectAskUserQuestion.mockClear();
    resolveAskUserQuestion.mockReturnValue(true);
    rejectAskUserQuestion.mockReturnValue(true);
    runWorkflowAction.mockClear();
    refineCompactedConversationSummary.mockClear();
    dreaminaCliGetStatus.mockClear();
    consumeAgentHandoff.mockReset();
    consumeAgentHandoff.mockReturnValue(null);
    dreaminaCliGetStatus.mockResolvedValue({
      ok: false,
      installed: false,
      loggedIn: false,
      message: "未检测到 Dreamina CLI",
    });
    vi.clearAllMocks();
    window.history.pushState({}, "", "/");
    window.open = vi.fn();
    window.electronAPI = undefined;
  });

  it("moves from the centered idle composer into the active homepage chat on first send", async () => {
    await renderStudio();

    const textarea = (await screen.findByPlaceholderText(/和 Agent 说出你的目标/)) as HTMLTextAreaElement;
    expect(textarea).toHaveAttribute("rows", "3");

    await fillComposer("我想做一个新项目");
    await waitFor(() => {
      expect(findSendButton()).toBeTruthy();
      expect(findSendButton()).not.toBeDisabled();
    });

    const sendButton = findSendButton();
    await act(async () => {
      fireEvent.click(sendButton!);
      await Promise.resolve();
    });

    await waitForVisibleText("我想做一个新项目");
    expect(window.location.pathname).toBe("/");
  });

  it("shows pending and completed video attachments from workflow events", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(createSession({ qState: null, selectedValues: [], draft: "" })),
    );

    await renderStudio();

    expect(screen.queryByText(/妯″瀷 doubao-seedance-1-5-pro_1080p/)).not.toBeInTheDocument();
    expect(screen.queryByText(/鍒嗚鲸鐜?1080/i)).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("agent:video-generating-start", {
          detail: {
            action: "generate_video_assets",
            model: "doubao-seedance-1-5-pro_1080p",
            resolution: "1080p",
            provider: "jimeng",
            sceneCount: 1,
            mode: "image-to-video",
            contentSummary: "角色 林夏 · 视图 特写 · 变体 雨夜",
          },
        }),
      );
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("正在生成角色 林夏，请稍等…");
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("内容 角色 林夏 · 视图 特写 · 变体 雨夜");
      expect(document.body.textContent).toContain("模式 图生视频");
      expect(document.body.textContent).toContain("通道 即梦");
    });
    expect(screen.getByText("正在生成视频")).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("agent:video-generated", {
          detail: {
            videoUrls: ["https://example.com/generated-video.mp4"],
            model: "doubao-seedance-1-5-pro_1080p",
            resolution: "1080p",
            provider: "jimeng",
            mode: "image-to-video",
            count: 1,
            contentSummary: "角色 林夏 · 视图 特写 · 变体 雨夜",
          },
        }),
      );
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("已生成角色 林夏");
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("已生成角色 林夏");
      expect(document.body.textContent).toContain("内容 角色 林夏 · 视图 特写 · 变体 雨夜");
      expect(document.body.textContent).toContain("模式 图生视频");
      expect(document.body.textContent).toContain("通道 即梦");
    });
    expect(screen.getByLabelText("播放视频：generated-video.mp4")).toBeInTheDocument();
    expect(screen.queryByText(/妯″瀷 doubao-seedance-1-5-pro_1080p/)).not.toBeInTheDocument();
    expect(screen.queryByText(/鍒嗚鲸鐜?1080/i)).not.toBeInTheDocument();
    expect(document.querySelector('video[src="https://example.com/generated-video.mp4"]')).toBeTruthy();
  });

  it("regenerates segment video attachments through the segment video workflow action", async () => {
    const videoProject = createRecoveryVideoProject({
      id: "video-segment-inline-project",
      currentStep: 4,
      scenes: [
        {
          id: "scene-segment-1",
          sceneNumber: 1,
          sceneName: "Segment shot",
          description: "A segment shot",
          characters: [],
          dialogue: "",
          cameraDirection: "medium shot",
          duration: 5,
          segmentLabel: "1-1",
        },
      ],
      segmentVideoPrompts: {
        "1-1": {
          segmentLabel: "1-1",
          prompt: "merged segment prompt",
          duration: 8,
          targetDuration: 8,
          modelKey: "doubao-seedance-1-5-pro",
          maxDurationForModel: 10,
          sceneIds: ["scene-segment-1"],
          generatedAt: "2026-04-03T00:00:00.000Z",
        },
      },
      segmentVideos: {
        "1-1": "https://example.com/segment-old.mp4",
      },
    });
    const nextVideoProject = {
      ...videoProject,
      segmentVideos: {
        ...videoProject.segmentVideos,
        "1-1": "https://example.com/segment-new.mp4",
      },
    };

    localStorage.setItem(VIDEO_PROJECTS_KEY, JSON.stringify([videoProject]));
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(
        createSession({
          qState: null,
          selectedValues: [],
          draft: "",
          projectId: videoProject.id,
          currentProjectSnapshot: createVideoSnapshot(videoProject),
          messages: [
            {
              id: "assistant-segment-video",
              role: "assistant",
              content: "Segment video generated.",
              createdAt: "2026-04-03T00:00:00.000Z",
              attachments: [
                {
                  id: "segment-video-attachment",
                  fileName: "segment-1-1.mp4",
                  mimeType: "video/mp4",
                  size: 123,
                  kind: "video",
                  previewUrl: "https://example.com/segment-old.mp4",
                  generationContext: {
                    action: "replace_segment_video",
                    projectId: videoProject.id,
                    targetId: "1-1",
                    regenerateMode: "redo-and-generate",
                  },
                },
              ],
            },
          ],
        }),
      ),
    );
    runWorkflowAction.mockResolvedValueOnce({
      summary: "segment regenerated",
      projectSnapshot: createVideoSnapshot(nextVideoProject),
      data: {
        projectSnapshot: createVideoSnapshot(nextVideoProject),
        videoProject: nextVideoProject,
      } as any,
      videoUrls: ["https://example.com/segment-new.mp4"],
    } as any);

    await renderStudio();

    const attachmentLabel = await screen.findByText("segment-1-1");
    const regenerateButton = attachmentLabel.parentElement?.parentElement?.querySelector("button");
    expect(regenerateButton).toBeTruthy();

    await act(async () => {
      fireEvent.click(regenerateButton!);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(runWorkflowAction).toHaveBeenCalledWith(
        "generate_segment_video",
        expect.objectContaining({
          projectId: videoProject.id,
          segmentLabel: "1-1",
        }),
        expect.anything(),
      );
    });
    await waitFor(() => {
      expect(document.querySelector('video[src="https://example.com/segment-new.mp4"]')).toBeTruthy();
    });
  });

  it("preserves pending video detail copy when the completion event is sparse", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(createSession({ qState: null, selectedValues: [], draft: "" })),
    );

    await renderStudio();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("agent:video-generating-start", {
          detail: {
            action: "generate_video_assets",
            model: "doubao-seedance-1-5-pro_480p",
            resolution: "480p",
            provider: "jimeng",
            sceneCount: 1,
            mode: "image-to-video",
            contentSummary: "镜头 9 / 1-4 · 幽屋陷地牢",
          },
        }),
      );
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("内容 镜头 9 / 1-4 · 幽屋陷地牢");
      expect(document.body.textContent).toContain("模式 图生视频");
      expect(document.body.textContent).toContain("通道 即梦");
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent("agent:video-generated", {
          detail: {
            videoUrls: ["https://example.com/generated-video-sparse.mp4"],
          },
        }),
      );
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("内容 镜头 9 / 1-4 · 幽屋陷地牢");
      expect(document.body.textContent).toContain("模式 图生视频");
      expect(document.body.textContent).toContain("通道 即梦");
    });
  });

  it("keeps restored pending video placeholders visible", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(
        createSession({
          qState: null,
          selectedValues: [],
          draft: "",
          messages: [
            {
              id: "assistant-video-pending-session",
              role: "assistant",
              content: "正在生成视频，请稍等…",
              createdAt: "2026-04-03T00:00:00.000Z",
              status: "pending",
              streamLabel: "正在生成视频",
              attachments: [
                {
                  id: "pending-video-1",
                  fileName: "生成中视频 1.mp4",
                  mimeType: "video/mp4",
                  size: 0,
                  kind: "video",
                  pending: true,
                  aspectRatio: "16:9",
                },
              ],
            },
          ],
        }),
      ),
    );

    await renderStudio();

    expect(screen.getAllByText("正在生成视频").length).toBeGreaterThan(0);
    expect(screen.getByText("生成中视频 1")).toBeInTheDocument();
    expect(screen.queryByText("媒体生成已取消，可继续选择下一步。")).not.toBeInTheDocument();
  });

  it("keeps the video placeholder window but stops its pending state when generation is cancelled", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(createSession({ qState: null, selectedValues: [], draft: "" })),
    );

    await renderStudio();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("agent:video-generating-start", {
          detail: {
            action: "generate_video_assets",
            sceneCount: 1,
          },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getAllByText("正在生成视频").length).toBeGreaterThan(0);
    });

    act(() => {
      window.dispatchEvent(new CustomEvent("agent:video-generating-cancelled"));
    });

    await waitForVisibleText("媒体生成已取消，可继续选择下一步。");
    expect(screen.queryByText("生成中视频.mp4")).not.toBeInTheDocument();
    expect(screen.queryByText("视频生成已取消")).not.toBeInTheDocument();
    expect(screen.queryByText("正在生成视频")).not.toBeInTheDocument();
    expect(screen.queryByText("正在生成视频，请稍等…")).not.toBeInTheDocument();
  });

  it("uses a compact content title for pending video reference asset messages", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(createSession({ qState: null, selectedValues: [], draft: "" })),
    );

    await renderStudio();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("agent:image-generating-start", {
          detail: {
            action: "generate_video_reference_assets",
            count: 1,
            modelFamily: "nano-banana-2",
            resolution: "default",
            aspectRatio: "16:9",
            contentSummary: "角色 林夏 · 视图 特写 · 变体 雨夜",
          },
        }),
      );
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("正在生成角色 林夏，请稍等…");
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("1 张视频参考素材 · 内容 角色 林夏 · 视图 特写 · 变体 雨夜");
    });
    expect(document.body.textContent).not.toContain("正在生成视频参考素材");
  });

  it("uses a compact content title for pending image messages", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(createSession({ qState: null, selectedValues: [], draft: "" })),
    );

    await renderStudio();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("agent:image-generating-start", {
          detail: {
            action: "generate_project_image",
            count: 1,
            modelFamily: "gpt-image-1",
            resolution: "1536x1024",
            aspectRatio: "3:2",
            contentSummary: "场景 雨夜街口 · 视图 全景 · 变体 电影感",
          },
        }),
      );
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("正在生成场景 雨夜街口，请稍等…");
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "1 张图片 · 内容 场景 雨夜街口 · 视图 全景 · 变体 电影感",
      );
    });
    expect(document.body.textContent).not.toContain("正在生成图片");
  });

  it("uses per-card target labels for pending image attachments", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(createSession({ qState: null, selectedValues: [], draft: "" })),
    );

    await renderStudio();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("agent:image-generating-start", {
          detail: {
            action: "generate_video_reference_assets",
            count: 2,
            aspectRatio: "16:9",
            contentSummary: "角色 苏浅浅",
            targetLabels: ["角色 苏浅浅-1", "角色 苏浅浅-2"],
          },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText("角色 苏浅浅-1")).toBeInTheDocument();
      expect(screen.getByText("角色 苏浅浅-2")).toBeInTheDocument();
    });
  });

  it("uses per-card target labels for pending video attachments", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(createSession({ qState: null, selectedValues: [], draft: "" })),
    );

    await renderStudio();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("agent:video-generating-start", {
          detail: {
            action: "generate_video_assets",
            count: 2,
            sceneCount: 2,
            mode: "image-to-video",
            contentSummary: "镜头批次",
            targetLabels: ["镜头 1 · 雨夜街口", "镜头 2 · 巷尾追逐"],
          },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText("镜头 1 · 雨夜街口")).toBeInTheDocument();
      expect(screen.getByText("镜头 2 · 巷尾追逐")).toBeInTheDocument();
    });
  });

  it("preserves pending image detail copy when the completion event is sparse", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(createSession({ qState: null, selectedValues: [], draft: "" })),
    );

    await renderStudio();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("agent:image-generating-start", {
          detail: {
            action: "generate_project_image",
            count: 1,
            modelFamily: "gpt-image-1",
            resolution: "1536x1024",
            aspectRatio: "3:2",
            contentSummary: "场景 雨夜街口 · 视图 全景 · 变体 电影感",
          },
        }),
      );
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "1 张图片 · 内容 场景 雨夜街口 · 视图 全景 · 变体 电影感",
      );
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent("agent:image-generated", {
          detail: {
            imageUrls: ["https://example.com/generated-image-sparse.jpg"],
          },
        }),
      );
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "1 张图片 · 内容 场景 雨夜街口 · 视图 全景 · 变体 电影感",
      );
    });
  });

  it("keeps the image placeholder window but stops its pending state when generation is cancelled", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(createSession({ qState: null, selectedValues: [], draft: "" })),
    );

    await renderStudio();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("agent:image-generating-start", {
          detail: {
            action: "generate_storyboard_frames",
            count: 1,
          },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText("正在生成分镜图")).toBeInTheDocument();
    });

    act(() => {
      window.dispatchEvent(new CustomEvent("agent:image-generating-cancelled"));
    });

    await waitForVisibleText("媒体生成已取消，可继续选择下一步。");
    expect(screen.queryByText("生成中图片.jpg")).not.toBeInTheDocument();
    expect(screen.queryByText("图片生成已取消")).not.toBeInTheDocument();
    expect(screen.queryByText("正在生成图片")).not.toBeInTheDocument();
    expect(screen.queryByText("正在生成分镜图")).not.toBeInTheDocument();
  });

  it("re-opens the next workflow popup after an image generation result arrives", async () => {
    seedVideoProject();
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(
        createSession({
          qState: null,
          selectedValues: [],
          draft: "",
          projectId: "video-project-1",
          currentProjectSnapshot: {
            projectId: "video-project-1",
            projectKind: "video",
            title: "澶滈洦杩藉嚮棰勫憡鐗?",
            currentObjective: "鍏堝闃呭凡鏈夌礌鏉愩€?",
            derivedStage: "瀹￠槄涓庝慨澶?",
            agentSummary: "褰撳墠鏈夊緟瀹￠槄椤广€?",
            recommendedActions: ["缁х画瀹￠槄"],
            artifacts: [],
          },
          recentMessageSummary: "",
        }),
      ),
    );

    await renderStudio();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("agent:image-generated", {
          detail: {
            imageUrls: ["https://example.com/generated-frame.jpg"],
            action: "generate_storyboard_frames",
            count: 1,
            contentSummary: "闆ㄥ杩藉嚮",
          },
        }),
      );
    });

    await waitFor(() => {
      const persisted = JSON.parse(localStorage.getItem(STUDIO_SESSION_KEY) || "{}");
      expect(typeof persisted.pendingChoiceQuestion?.answerKey).toBe("string");
      expect(persisted.pendingChoiceQuestion?.answerKey).toBeTruthy();
    });
  });

  it("re-opens the next workflow popup after a video generation result arrives", async () => {
    seedVideoProject();
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(
        createSession({
          qState: null,
          selectedValues: [],
          draft: "",
          projectId: "video-project-1",
          currentProjectSnapshot: {
            projectId: "video-project-1",
            projectKind: "video",
            title: "澶滈洦杩藉嚮棰勫憡鐗?",
            currentObjective: "鍏堝闃呭凡鏈夌礌鏉愩€?",
            derivedStage: "瀹￠槄涓庝慨澶?",
            agentSummary: "褰撳墠鏈夊緟瀹￠槄椤广€?",
            recommendedActions: ["缁х画瀹￠槄"],
            artifacts: [],
          },
          recentMessageSummary: "",
        }),
      ),
    );

    await renderStudio();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("agent:video-generated", {
          detail: {
            videoUrls: ["https://example.com/generated-video.mp4"],
            count: 1,
            mode: "image-to-video",
            contentSummary: "闆ㄥ杩藉嚮",
          },
        }),
      );
    });

    await waitFor(() => {
      const persisted = JSON.parse(localStorage.getItem(STUDIO_SESSION_KEY) || "{}");
      expect(typeof persisted.pendingChoiceQuestion?.answerKey).toBe("string");
      expect(persisted.pendingChoiceQuestion?.answerKey).toBeTruthy();
    });
  });

  it("does not re-open the next workflow popup while video generation is still running", async () => {
    seedVideoProject("video-project-1", {
      scenes: [
        {
          id: "scene-1",
          sceneNumber: 1,
          sceneName: "Rain Chase",
          description: "Lead runs through a rainy alley while being pursued.",
          characters: ["Lead"],
          dialogue: "",
          cameraDirection: "medium tracking shot",
          duration: 5,
          storyboardUrl: "https://example.com/storyboard-1.jpg",
          videoTaskId: "task-1",
          videoStatus: "processing",
        },
      ],
    });
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(
        createSession({
          qState: null,
          selectedValues: [],
          draft: "",
          projectId: "video-project-1",
          currentProjectSnapshot: {
            projectId: "video-project-1",
            projectKind: "video",
            title: "Video Popup Guard",
            currentObjective: "Continue the video workflow",
            derivedStage: "storyboard",
            agentSummary: "Keep the workflow focused on the media bubble.",
            recommendedActions: ["continue"],
            artifacts: [],
          },
          recentMessageSummary: "",
        }),
      ),
    );

    await renderStudio();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("agent:video-generated", {
          detail: {
            videoUrls: ["https://example.com/generated-video-processing.mp4"],
            count: 1,
            mode: "image-to-video",
            contentSummary: "鏉冨疄楠岃瘉",
          },
        }),
      );
    });

    await waitFor(() => {
      const persisted = JSON.parse(localStorage.getItem(STUDIO_SESSION_KEY) || "{}");
      expect(persisted.pendingChoiceQuestion ?? null).toBeNull();
    });
  });

  it("directly generates and renders a video for descriptive natural-language prompts", async () => {
    mockApiConfig = {
      ...mockApiConfig,
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengExecutionMode: "api",
    };
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(createSession({ qState: null, selectedValues: [], draft: "" })),
    );

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "ark-task-direct-1",
            status: "queued",
            progress: 0,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "completed",
            content: {
              video_url: "https://example.com/direct-natural-video.mp4",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

    await renderStudio();
    await fillComposer("生成一个雨夜巷口追逐视频，真实电影感");

    await waitFor(() => {
      expect(findSendButton()).toBeTruthy();
      expect(findSendButton()).not.toBeDisabled();
    });

    await act(async () => {
      fireEvent.click(findSendButton()!);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText("direct-natural-video.mp4")).toBeInTheDocument();
    });
    expect(document.querySelector('video source[src="https://example.com/direct-natural-video.mp4"]')).toBeTruthy();
    expect(lastSubmittedPrompt).toBe("");

    fetchSpy.mockRestore();
  });

  it("shows the role-development next step before character generation starts", async () => {
    const snapshot = createCharactersStageSnapshot();
    seedCharactersStageDramaProject(snapshot.projectId);

    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(
        createSession({
          currentProjectSnapshot: snapshot,
          projectId: snapshot.projectId,
          qState: null,
          selectedValues: [],
          draft: "",
          messages: [
            {
              id: "assistant-script-characters",
              role: "assistant",
              content: "创作方案已完成。",
              createdAt: "2026-04-03T00:09:00.000Z",
            },
          ],
          recentMessageSummary: "",
        }),
      ),
    );

    await renderStudio();

    await waitForVisibleText("下一步：进入角色开发");
    expect(screen.getByRole("button", { name: "进入角色开发" })).toBeInTheDocument();
    expect(runWorkflowAction).not.toHaveBeenCalled();
  });

  it("shows a launch-readiness notice instead of a raw error when no text model is configured", async () => {
    mockApiConfig = {
      claudeKey: "",
      claudeEndpoint: "",
      geminiKey: "",
      geminiEndpoint: "",
      gptKey: "",
      gptEndpoint: "",
      jimengKey: "",
      jimengEndpoint: "",
      jimengExecutionMode: "api",
    };

    await renderStudio();

    await waitFor(() => {
      expect(screen.getByText("主对话模型尚未就绪")).toBeInTheDocument();
    });
    expect(screen.getByText(/当前首页还没有可用的文本模型 Key/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "去设置补齐" }));
      await Promise.resolve();
    });
    expect(window.location.pathname).toBe("/");
  });

  it("lets the homepage switch a broken CLI default back to API from the launch notice", async () => {
    mockApiConfig = {
      claudeKey: "test-key",
      claudeEndpoint: "https://example.test",
      geminiKey: "",
      geminiEndpoint: "",
      gptKey: "",
      gptEndpoint: "",
      jimengKey: "seedance-key",
      jimengEndpoint: "https://video.example.test",
      jimengExecutionMode: "cli",
    };

    await renderStudio();

    await waitFor(() => {
      expect(screen.getByText("视频默认走 CLI，但当前还不能直接出片")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "切到 API" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByText("视频默认走 CLI，但当前还不能直接出片")).not.toBeInTheDocument();
    });
  });

  it("auto-compacts long homepage conversations before continuing with the next turn", async () => {
    localStorage.setItem(STUDIO_SESSION_KEY, JSON.stringify(createLongSession()));

    await renderStudio();

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "继续往下推进" } });

    await act(async () => {
      fireEvent.click(findSendButton()!);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(Array.isArray(lastQueryEngineConfig?.initialMessages)).toBe(true);
    });
    expect((lastQueryEngineConfig?.initialMessages as unknown[]).length).toBeLessThan(24);
    expect(refineCompactedConversationSummary).toHaveBeenCalledTimes(1);
    expect(screen.getByText("较早对话已静默整理")).toBeInTheDocument();
    await waitFor(() => {
      const reports = JSON.parse(localStorage.getItem(MAINTENANCE_REPORTS_KEY) || "[]");
      expect(reports[0]?.summary).toContain("已静默压缩首页长会话");
      expect(reports[0]?.compressedConversationCount).toBe(1);
    });
  });

  it("surfaces maintenance review shortcuts on the idle homepage when drafts and reports are available", async () => {
    localStorage.setItem(
      SKILL_DRAFTS_KEY,
      JSON.stringify([
        {
          id: "skill-draft-1",
          sourceConversationIds: ["session-a", "session-b"],
          proposedSkillName: "镜头修复策略",
          proposedContent: "当镜头进入 redo 队列时，优先按角色一致性、镜头运动、情绪强度三轴复核。",
          reason: "多次视频修复会话都重复了同一套判断标准。",
          status: "pending",
          createdAt: "2026-04-03T00:00:00.000Z",
        },
      ]),
    );
    localStorage.setItem(
      MAINTENANCE_REPORTS_KEY,
      JSON.stringify([
        {
          id: "report-1",
          createdAt: "2026-04-03T00:30:00.000Z",
          summary: "已完成一次首页维护整理。",
          compressedConversationCount: 1,
          archivedProjectCount: 2,
          clearedCacheKeys: [],
          mergedDraftCount: 0,
          notes: ["最近视频链路已有可复用经验。"],
        },
      ]),
    );

    await renderStudio();

    await waitFor(() => {
      expect(screen.getByText("我已整理出 1 份待审核技能草案，并带着最近维护结论。")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "查看最近维护结论" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看 1 份待审核技能草案" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "执行一次维护检查" })).toBeInTheDocument();
  });

  it("keeps maintenance interactions out of the main session and auto-dismisses the detached notice", async () => {
    localStorage.setItem(
      SKILL_DRAFTS_KEY,
      JSON.stringify([
        {
          id: "skill-draft-1",
          sourceConversationIds: ["session-a"],
          proposedSkillName: "镜头修复策略",
          proposedContent: "优先按角色一致性、镜头运动、情绪强度三轴复核。",
          reason: "重复出现的修复模式。",
          status: "pending",
          createdAt: "2026-04-03T00:00:00.000Z",
        },
      ]),
    );

    await renderStudio();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "查看 1 份待审核技能草案" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "查看 1 份待审核技能草案" }));
      await Promise.resolve();
    });

    await waitForVisibleText(/当前共有 1 份待审核技能草案/);

    expect(localStorage.getItem(STUDIO_SESSION_KEY)).toBeNull();

    await waitFor(() => {
      expect(screen.queryByText(/当前共有 1 份待审核技能草案/)).not.toBeInTheDocument();
    }, { timeout: 6500 });
  }, 9000);

  it("can inspect a pending skill draft from the homepage maintenance suggestion", async () => {
    localStorage.setItem(
      SKILL_DRAFTS_KEY,
      JSON.stringify([
        {
          id: "skill-draft-1",
          sourceConversationIds: ["session-a", "session-b"],
          proposedSkillName: "镜头修复策略",
          proposedContent: "当镜头进入 redo 队列时，优先按角色一致性、镜头运动、情绪强度三轴复核。",
          reason: "多次视频修复会话都重复了同一套判断标准。",
          status: "pending",
          createdAt: "2026-04-03T00:00:00.000Z",
        },
      ]),
    );
    localStorage.setItem(
      MAINTENANCE_REPORTS_KEY,
      JSON.stringify([
        {
          id: "report-1",
          createdAt: "2026-04-03T00:30:00.000Z",
          summary: "已完成一次首页维护整理。",
          compressedConversationCount: 1,
          archivedProjectCount: 2,
          clearedCacheKeys: [],
          mergedDraftCount: 0,
          notes: ["最近视频链路已有可复用经验。"],
        },
      ]),
    );

    await renderStudio();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "查看 1 份待审核技能草案" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "查看 1 份待审核技能草案" }));
      await Promise.resolve();
    });

    await waitForVisibleText(/先看哪一份待审核技能草案/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "镜头修复策略" }));
      await Promise.resolve();
    });

    await waitForVisibleText(/待审核技能草案《镜头修复策略》/);
    expect(screen.getByRole("button", { name: "批准这份草案" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "驳回这份草案" })).toBeInTheDocument();
  });

  it("can approve a pending skill draft from the homepage maintenance suggestion", async () => {
    localStorage.setItem(
      SKILL_DRAFTS_KEY,
      JSON.stringify([
        {
          id: "skill-draft-1",
          sourceConversationIds: ["session-a", "session-b"],
          proposedSkillName: "镜头修复策略",
          proposedContent: "当镜头进入 redo 队列时，优先按角色一致性、镜头运动、情绪强度三轴复核。",
          reason: "多次视频修复会话都重复了同一套判断标准。",
          status: "pending",
          createdAt: "2026-04-03T00:00:00.000Z",
        },
      ]),
    );

    await renderStudio();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "查看 1 份待审核技能草案" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "查看 1 份待审核技能草案" }));
      await Promise.resolve();
    });

    await waitForVisibleText(/先看哪一份待审核技能草案/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "镜头修复策略" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "批准这份草案" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "批准这份草案" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      const drafts = JSON.parse(localStorage.getItem(SKILL_DRAFTS_KEY) || "[]");
      expect(drafts[0]?.status).toBe("approved");
    });
    const reports = JSON.parse(localStorage.getItem(MAINTENANCE_REPORTS_KEY) || "[]");
    expect(reports[0]?.summary).toContain("已批准技能候选");
  });

  it("can reject a pending skill draft from the homepage maintenance suggestion", async () => {
    localStorage.setItem(
      SKILL_DRAFTS_KEY,
      JSON.stringify([
        {
          id: "skill-draft-1",
          sourceConversationIds: ["session-a", "session-b"],
          proposedSkillName: "镜头修复策略",
          proposedContent: "当镜头进入 redo 队列时，优先按角色一致性、镜头运动、情绪强度三轴复核。",
          reason: "多次视频修复会话都重复了同一套判断标准。",
          status: "pending",
          createdAt: "2026-04-03T00:00:00.000Z",
        },
      ]),
    );

    await renderStudio();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "查看 1 份待审核技能草案" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "查看 1 份待审核技能草案" }));
      await Promise.resolve();
    });

    await waitForVisibleText(/先看哪一份待审核技能草案/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "镜头修复策略" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "驳回这份草案" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "驳回这份草案" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      const drafts = JSON.parse(localStorage.getItem(SKILL_DRAFTS_KEY) || "[]");
      expect(drafts[0]?.status).toBe("rejected");
    });
    const reports = JSON.parse(localStorage.getItem(MAINTENANCE_REPORTS_KEY) || "[]");
    expect(reports[0]?.summary).toContain("驳回");
  });

  it("can inspect approved skill drafts from the homepage maintenance suggestion", async () => {
    localStorage.setItem(
      SKILL_DRAFTS_KEY,
      JSON.stringify([
        {
          id: "skill-draft-1",
          sourceConversationIds: ["session-a", "session-b"],
          proposedSkillName: "镜头修复策略",
          proposedContent: "当镜头进入 redo 队列时，优先按角色一致性、镜头运动、情绪强度三轴复核。",
          reason: "多次视频修复会话都重复了同一套判断标准。",
          status: "approved",
          createdAt: "2026-04-03T00:00:00.000Z",
        },
      ]),
    );
    localStorage.setItem(
      MAINTENANCE_REPORTS_KEY,
      JSON.stringify([
        {
          id: "report-1",
          createdAt: "2026-04-03T00:30:00.000Z",
          summary: "已完成一次首页维护整理。",
          compressedConversationCount: 1,
          archivedProjectCount: 2,
          clearedCacheKeys: [],
          mergedDraftCount: 0,
          notes: ["最近视频链路已有可复用经验。"],
        },
      ]),
    );

    await renderStudio();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "查看 1 份已批准技能草案" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "查看 1 份已批准技能草案" }));
      await Promise.resolve();
    });

    await waitForVisibleText(/先看哪一份已批准技能草案/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "镜头修复策略" }));
      await Promise.resolve();
    });

    await waitForVisibleText(/已批准技能草案《镜头修复策略》/);
    expect(screen.getByRole("button", { name: "查看最近维护结论" })).toBeInTheDocument();
  });

  it("can export approved skill drafts from the homepage maintenance suggestion", async () => {
    localStorage.setItem(
      SKILL_DRAFTS_KEY,
      JSON.stringify([
        {
          id: "skill-draft-1",
          sourceConversationIds: ["session-a", "session-b"],
          proposedSkillName: "镜头修复策略",
          proposedContent: "当镜头进入 redo 队列时，优先按角色一致性、镜头运动、情绪强度三轴复核。",
          reason: "多次视频修复会话都重复了同一套判断标准。",
          status: "approved",
          createdAt: "2026-04-03T00:00:00.000Z",
        },
      ]),
    );

    await renderStudio();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "导出已批准技能候选" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "导出已批准技能候选" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      const reports = JSON.parse(localStorage.getItem(MAINTENANCE_REPORTS_KEY) || "[]");
      expect(reports[0]?.notes?.[0]).toContain("skills-drafts/approved");
    });
    const reports = JSON.parse(localStorage.getItem(MAINTENANCE_REPORTS_KEY) || "[]");
    expect(reports[0]?.notes?.[0]).toContain("导出目录");
  });

  it("can preview the approved skill bundle summary from the homepage maintenance suggestion", async () => {
    localStorage.setItem(
      SKILL_DRAFTS_KEY,
      JSON.stringify([
        {
          id: "skill-draft-1",
          sourceConversationIds: ["session-a", "session-b"],
          proposedSkillName: "镜头修复策略",
          proposedContent: "当镜头进入 redo 队列时，优先按角色一致性、镜头运动、情绪强度三轴复核。",
          reason: "多次视频修复会话都重复了同一套判断标准。",
          status: "approved",
          createdAt: "2026-04-03T00:00:00.000Z",
        },
      ]),
    );

    await renderStudio();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "预览已批准 Bundle 摘要" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "预览已批准 Bundle 摘要" }));
      await Promise.resolve();
    });

    await waitForVisibleText(/当前共有 1 份已批准技能草案/);
    expect(screen.getByText(/镜头修复策略/)).toBeInTheDocument();
    expect(screen.getByText(/如果需要，我也可以继续把这些已批准草案导出到本地候选目录或生成 bundle 文件/)).toBeInTheDocument();
  });

  it("can open the approved skill export directory from the homepage maintenance suggestion", async () => {
    const openFolder = vi.fn(async () => undefined);
    window.electronAPI = {
      storage: {
        getDefaultPath: vi.fn(async () => ({ files: "D:/StoryForgeFiles", db: "D:/StoryForgeDb" })),
        openFolder,
      },
    } as unknown as Window["electronAPI"];

    localStorage.setItem(
      SKILL_DRAFTS_KEY,
      JSON.stringify([
        {
          id: "skill-draft-1",
          sourceConversationIds: ["session-a", "session-b"],
          proposedSkillName: "镜头修复策略",
          proposedContent: "当镜头进入 redo 队列时，优先按角色一致性、镜头运动、情绪强度三轴复核。",
          reason: "多次视频修复会话都重复了同一套判断标准。",
          status: "approved",
          createdAt: "2026-04-03T00:00:00.000Z",
        },
      ]),
    );

    await renderStudio();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "打开技能候选目录" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "打开技能候选目录" }));
      await Promise.resolve();
    });

    await waitForVisibleText(/已为你打开技能候选目录/);
    expect(openFolder).toHaveBeenCalledWith("D:/StoryForgeFiles/home-agent/skills-drafts/approved");
  });

  it("can generate an approved skill bundle file from the homepage maintenance suggestion", async () => {
    localStorage.setItem(
      SKILL_DRAFTS_KEY,
      JSON.stringify([
        {
          id: "skill-draft-1",
          sourceConversationIds: ["session-a", "session-b"],
          proposedSkillName: "镜头修复策略",
          proposedContent: "当镜头进入 redo 队列时，优先按角色一致性、镜头运动、情绪强度三轴复核。",
          reason: "多次视频修复会话都重复了同一套判断标准。",
          status: "approved",
          createdAt: "2026-04-03T00:00:00.000Z",
        },
      ]),
    );

    await renderStudio();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "导出 Bundle 文件" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "导出 Bundle 文件" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      const reports = JSON.parse(localStorage.getItem(MAINTENANCE_REPORTS_KEY) || "[]");
      expect(reports[0]?.notes?.[0]).toContain("bundle-preview.md");
    });
    const reports = JSON.parse(localStorage.getItem(MAINTENANCE_REPORTS_KEY) || "[]");
    expect(reports[0]?.notes?.[0]).toContain("bundle-preview.md");
  });

  it("can package approved skill drafts into controlled install candidates from the homepage maintenance suggestion", async () => {
    localStorage.setItem(
      SKILL_DRAFTS_KEY,
      JSON.stringify([
        {
          id: "skill-draft-1",
          sourceConversationIds: ["session-a", "session-b"],
          proposedSkillName: "镜头修复策略",
          proposedContent: "当镜头进入 redo 队列时，优先按角色一致性、镜头运动、情绪强度三轴复核。",
          reason: "多次视频修复会话都重复了同一套判断标准。",
          status: "approved",
          createdAt: "2026-04-03T00:00:00.000Z",
        },
      ]),
    );

    await renderStudio();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "生成正式 Skill 安装候选" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "生成正式 Skill 安装候选" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      const reports = JSON.parse(localStorage.getItem(MAINTENANCE_REPORTS_KEY) || "[]");
      expect(reports[0]?.notes?.[0]).toContain("skills-candidates/pending-install");
    });
    const reports = JSON.parse(localStorage.getItem(MAINTENANCE_REPORTS_KEY) || "[]");
    expect(reports[0]?.notes?.[0]).toContain("skills-candidates/pending-install");
    expect(reports[0]?.notes?.[2]).toContain("不会自动进入 .claude/skills");
  });

  it("can preview the controlled install candidate summary from the homepage maintenance suggestion", async () => {
    localStorage.setItem(
      SKILL_DRAFTS_KEY,
      JSON.stringify([
        {
          id: "skill-draft-1",
          sourceConversationIds: ["session-a", "session-b"],
          proposedSkillName: "镜头修复策略",
          proposedContent: "当镜头进入 redo 队列时，优先按角色一致性、镜头运动、情绪强度三轴复核。",
          reason: "多次视频修复会话都重复了同一套判断标准。",
          status: "approved",
          createdAt: "2026-04-03T00:00:00.000Z",
        },
      ]),
    );

    await renderStudio();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "预览安装候选摘要" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "预览安装候选摘要" }));
      await Promise.resolve();
    });

    await waitForVisibleText(/整理成待审核的正式 Skill 候选文件/);
    expect(screen.getByText(/不会自动写入 \.claude\/skills/)).toBeInTheDocument();
    expect(screen.getByText(/INSTALL-REVIEW\.md/)).toBeInTheDocument();
  });

  it("can open the controlled install candidate directory from the homepage maintenance suggestion", async () => {
    const openFolder = vi.fn(async () => undefined);
    window.electronAPI = {
      storage: {
        getDefaultPath: vi.fn(async () => ({ files: "D:/StoryForgeFiles", db: "D:/StoryForgeDb" })),
        openFolder,
      },
    } as unknown as Window["electronAPI"];

    localStorage.setItem(
      SKILL_DRAFTS_KEY,
      JSON.stringify([
        {
          id: "skill-draft-1",
          sourceConversationIds: ["session-a", "session-b"],
          proposedSkillName: "镜头修复策略",
          proposedContent: "当镜头进入 redo 队列时，优先按角色一致性、镜头运动、情绪强度三轴复核。",
          reason: "多次视频修复会话都重复了同一套判断标准。",
          status: "approved",
          createdAt: "2026-04-03T00:00:00.000Z",
        },
      ]),
    );

    await renderStudio();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "打开安装候选目录" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "打开安装候选目录" }));
      await Promise.resolve();
    });

    await waitForVisibleText(/已为你打开正式 Skill 候选目录/);
    expect(openFolder).toHaveBeenCalledWith("D:/StoryForgeFiles/home-agent/skills-candidates/pending-install");
  });

  it("shows sequential quick research choice modals before launch", async () => {
    await renderStudio();

    await screen.findByPlaceholderText(/和 Agent 说出你的目标/);
    await fillComposer("请帮我分析这个女频都市短剧项目的市场、风格方向和人物卖点");
    await waitFor(() => {
      expect(findSendButton()).toBeTruthy();
      expect(findSendButton()).not.toBeDisabled();
    });

    await act(async () => {
      fireEvent.click(findSendButton()!);
      await Promise.resolve();
    });

    await waitForVisibleText(/我已整理出 3 个快捷研究任务/);
    await screen.findByRole("button", { name: "中国（中文）" });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "中国（中文）" }));
      await Promise.resolve();
    });
    await screen.findByRole("button", { name: "短平快强钩子" });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "短平快强钩子" }));
      await Promise.resolve();
    });
    await screen.findByRole("button", { name: "连续反转卖点优先" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "连续反转卖点优先" }));
      await Promise.resolve();
    });

    await waitForVisibleText(/已按顺序启动：目标市场、风格路线、卖点结构/);
  });

  it("injects relevant historical memory into the current turn prompt", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(
        createSession({
          qState: null,
          draft: "",
          currentProjectSnapshot: {
            ...createSession().currentProjectSnapshot!,
            projectId: "project-current",
            title: "当前项目",
          },
        }),
      ),
    );

    seedDramaProject("project-old-script");
    localStorage.setItem(
      STUDIO_PROJECT_SESSIONS_KEY,
      JSON.stringify({
        "project-old-script": {
          mode: "active",
          messages: [
            {
              id: "project-old-script-user-1",
              role: "user",
              content: "男主要先装冷淡，再在第一个反转点护住女主。",
              createdAt: "2026-04-02T00:05:00.000Z",
            },
            {
              id: "project-old-script-assistant-1",
              role: "assistant",
              content: "已确认：男主表面克制，关键节点反向护妻，作为前 3 集的稳定人物策略。",
              createdAt: "2026-04-02T00:06:00.000Z",
            },
          ],
          currentProjectSnapshot: null,
          recentMessageSummary: "已确认：男主表面克制，关键节点反向护妻，作为前 3 集的稳定人物策略。",
          projectId: "project-old-script",
          draft: "",
          qState: null,
          selectedValues: [],
        },
      }),
    );

    await renderStudio();

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: "我想继续做女频都市悬疑的人物关系和反转" },
    });

    await act(async () => {
      fireEvent.click(findSendButton()!);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastSubmittedPrompt).toContain("以下是与当前输入相关的历史记忆");
    });
    expect(lastSubmittedPrompt).toContain("反向护妻");

    await waitFor(() => {
      expect(screen.getByText(/已参考 \d+ 条(?:项目经验|素材记录|维护记录|技能草案|历史经验)/)).toBeInTheDocument();
    });
  });

  it("injects current-project runtime memory for failed and pending video retrieval requests", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(
        createSession({
          currentProjectSnapshot: {
            projectId: "video-project-runtime-memory",
            projectKind: "video",
            title: "雨夜追击预告片",
            currentObjective: "先把失败镜头补发，再处理待审项。",
            derivedStage: "审阅与修复",
            agentSummary: "当前有失败镜头和待审素材。",
            recommendedActions: ["补发失败镜头", "处理待审项"],
            artifacts: [],
            memory: {
              styleLock: null,
              worldModel: null,
              assetManifest: null,
              videoScenes: [
                {
                  id: "scene-failed-1",
                  sceneNumber: 3,
                  sceneName: "雨夜追车",
                  videoStatus: "failed",
                  videoFailureMessage: "当前镜头生成失败，需要重新补发。",
                },
              ],
              shotPackets: [],
              reviewQueue: [
                {
                  id: "review-1",
                  title: "审阅镜头 5",
                  summary: "需要决定是否通过。",
                  targetIds: ["scene-review-1"],
                  status: "pending",
                  createdAt: "2026-04-03T00:00:00.000Z",
                  updatedAt: "2026-04-03T00:00:00.000Z",
                },
              ],
            },
          },
          recentMessageSummary: "assistant: 当前有失败镜头和待审素材。",
          projectId: "video-project-runtime-memory",
          qState: null,
          selectedValues: [],
          draft: "",
        }),
      ),
    );

    await renderStudio();

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: "把上次失败的镜头和待审项找出来" },
    });

    await act(async () => {
      fireEvent.click(findSendButton()!);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastSubmittedPrompt).toContain("雨夜追击预告片 · 失败镜头");
    });
    expect(lastSubmittedPrompt).toContain("雨夜追击预告片 · 待审镜头");
  });

  it("injects local Dreamina capability context into video-related turns", async () => {
    dreaminaCliGetStatus.mockResolvedValue({
      ok: true,
      installed: true,
      loggedIn: true,
      message: "已登录 Dreamina CLI",
    });
    window.electronAPI = {
      dreaminaCli: {
        exec: vi.fn(),
      },
    } as unknown as Window["electronAPI"];

    await renderStudio();

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: "我要继续视频工作流，直接准备分镜和出片。" },
    });

    await act(async () => {
      fireEvent.click(findSendButton()!);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastSubmittedPrompt).toContain("当前运行环境附加能力");
    });
    expect(lastSubmittedPrompt).toContain("Seedance 2.0 / Seedance 2.0 Fast");
    expect(screen.getByText("已接入 Dreamina CLI，可直接使用 Seedance 2.0")).toBeInTheDocument();
  });

  it("does not render the transport hint chip in active video conversations", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(
        createSession({
          currentProjectSnapshot: {
            projectId: "video-project-status",
            projectKind: "video",
            title: "雨夜追击预告片",
            currentObjective: "继续提交当前镜头出片。",
            derivedStage: "生成中",
            agentSummary: "当前镜头已进入出片阶段。",
            recommendedActions: ["轮询当前出片结果"],
            artifacts: [],
          },
          projectId: "video-project-status",
          qState: null,
          selectedValues: [],
          draft: "",
        }),
      ),
    );

    await renderStudio();

    expect(screen.queryByText("当前实际走 API")).not.toBeInTheDocument();
    expect(screen.queryByText("Seedance API")).not.toBeInTheDocument();
  });

  it("maps video recovery recommendations to homepage workflow shortcuts", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify({
        sessionId: "video-session-1",
        compactedMessageCount: 0,
        mode: "active",
        messages: [
          {
            id: "assistant-video-1",
            role: "assistant",
            content: "视频提示词批次已经整理好了。",
            createdAt: "2026-04-03T00:00:00.000Z",
          },
        ],
        currentProjectSnapshot: {
          projectId: "video-project-recovery",
          projectKind: "video",
          title: "夜雨追击预告片",
          currentObjective: "把已整理好的提示词批次接入视频生成。",
          derivedStage: "视频提示词",
          agentSummary: "当前已经整理出镜头提示词，适合直接发起第一轮出片。",
          recommendedActions: ["开始第一轮出片", "轮询当前出片结果", "整理待审阅项"],
          artifacts: [],
        },
        recentMessageSummary: "assistant: 视频提示词批次已经整理好了。",
        projectId: "video-project-recovery",
        draft: "",
        qState: null,
        selectedValues: [],
      }),
    );

    await renderStudio();

    await waitForVisibleText(/开始第一轮出片/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "开始第一轮出片" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(runWorkflowAction).toHaveBeenCalledWith(
        "generate_video_assets",
        expect.objectContaining({
          projectId: "video-project-recovery",
        }),
        expect.anything(),
      );
    });
    expect(screen.getByText("workflow:generate_video_assets")).toBeInTheDocument();
  });

  it("maps the production bundle recommendation to a homepage workflow shortcut", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify({
        sessionId: "video-session-export",
        compactedMessageCount: 0,
        mode: "active",
        messages: [
          {
            id: "assistant-video-export-1",
            role: "assistant",
            content: "当前已经具备资产清单、镜头指令包和待审阅状态，可以先导出生产状态包。",
            createdAt: "2026-04-03T00:00:00.000Z",
          },
        ],
        currentProjectSnapshot: {
          projectId: "video-project-export",
          projectKind: "video",
          title: "雨夜追击预告片",
          currentObjective: "继续复核镜头指令包，并衔接提示词与生成。",
          derivedStage: "镜头指令包",
          agentSummary: "当前已经具备资产清单、镜头指令包和待审阅状态。",
          recommendedActions: ["复核 2 个镜头指令包", "准备视频提示词批次", "导出生产状态包"],
          artifacts: [],
        },
        recentMessageSummary: "assistant: 当前已经具备资产清单、镜头指令包和待审阅状态，可以先导出生产状态包。",
        projectId: "video-project-export",
        draft: "",
        qState: null,
        selectedValues: [],
      }),
    );

    await renderStudio();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "导出生产状态包" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "导出生产状态包" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(runWorkflowAction).toHaveBeenCalledWith(
        "export_video_production_bundle",
        expect.objectContaining({
          projectId: "video-project-export",
        }),
        expect.anything(),
      );
    });
    expect(screen.getByText(/已导出《雨夜追击预告片》的生产状态包/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "预览生产状态摘要" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开生产状态目录" })).toBeInTheDocument();
  });

  it("supports previewing and opening the exported production bundle from the homepage follow-up actions", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify({
        sessionId: "video-session-export-followup",
        compactedMessageCount: 0,
        mode: "active",
        messages: [
          {
            id: "assistant-video-export-followup-1",
            role: "assistant",
            content: "生产状态包已经导出完成。",
            createdAt: "2026-04-03T00:00:00.000Z",
          },
        ],
        currentProjectSnapshot: {
          projectId: "video-project-export",
          projectKind: "video",
          title: "雨夜追击预告片",
          currentObjective: "继续复核镜头指令包，并衔接提示词与生成。",
          derivedStage: "镜头指令包",
          agentSummary: "当前已经具备资产清单、镜头指令包和待审阅状态。",
          recommendedActions: ["预览生产状态摘要", "打开生产状态目录", "导出生产状态包"],
          artifacts: [],
        },
        recentMessageSummary: "assistant: 生产状态包已经导出完成。",
        projectId: "video-project-export",
        draft: "",
        qState: null,
        selectedValues: [],
      }),
    );

    await renderStudio();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "预览生产状态摘要" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "预览生产状态摘要" }));
      await Promise.resolve();
    });

    await waitForVisibleText(/当前《雨夜追击预告片》的生产状态包摘要如下/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "打开生产状态目录" }));
      await Promise.resolve();
    });

    await waitForVisibleText(/已为你打开生产状态目录/);
    expect(runWorkflowAction).toHaveBeenCalledWith(
      "preview_video_production_bundle",
      expect.objectContaining({
        projectId: "video-project-export",
      }),
      expect.anything(),
    );
    expect(runWorkflowAction).toHaveBeenCalledWith(
      "open_video_production_bundle_directory",
      expect.objectContaining({
        projectId: "video-project-export",
      }),
      expect.anything(),
    );
  });

  it("surfaces the persisted production bundle inside the sidebar asset library and opens its local directory", async () => {
    const openFolder = vi.fn(async () => undefined);
    window.electronAPI = {
      storage: {
        getDefaultPath: vi.fn(async () => ({ files: "D:/StoryForgeFiles", db: "D:/StoryForgeDb" })),
        openFolder,
      },
    } as unknown as Window["electronAPI"];

    seedGeneratingVideoProject("video-project-bundle-sidebar");
    localStorage.setItem(
      VIDEO_PROJECTS_KEY,
      JSON.stringify([
        {
          ...JSON.parse(localStorage.getItem(VIDEO_PROJECTS_KEY) || "[]")[0],
          productionStateBundle: {
            directoryPath: "D:/StoryForgeFiles/home-agent/production-state/雨夜追击生成中-video-project-export",
            overviewPath: "D:/StoryForgeFiles/home-agent/production-state/雨夜追击生成中-video-project-export/README.md",
            filePaths: [
              "D:/StoryForgeFiles/home-agent/production-state/雨夜追击生成中-video-project-export/README.md",
              "D:/StoryForgeFiles/home-agent/production-state/雨夜追击生成中-video-project-export/project.json",
            ],
            exportedCount: 2,
            exportedAt: "2026-04-03T01:00:00.000Z",
          },
        },
      ]),
    );

    await renderStudio();

    const historySection = (await screen.findAllByText("对话历史"))[0]?.closest("section") ?? document.body;
    let historyButton: HTMLElement | null = null;
    await waitFor(() => {
      historyButton = within(historySection).getByRole("button", {
        name: /雨夜追击生成中/,
      });
    });

    await act(async () => {
      fireEvent.click(historyButton!);
      await Promise.resolve();
    });

    const assetSection = (await screen.findAllByText("素材库"))[0]?.closest("section") ?? document.body;

    await waitFor(() => {
      expect(within(assetSection).getByRole("button", { name: "生产状态包" })).toBeInTheDocument();
    });
    expect(within(assetSection).getByText(/2 个文件/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(within(assetSection).getByRole("button", { name: "生产状态包" }));
      await Promise.resolve();
    });

    expect(openFolder).toHaveBeenCalledWith(
      "D:/StoryForgeFiles/home-agent/production-state/雨夜追击生成中-video-project-export",
    );
  });

  it("surfaces stage-aware video generation choices before submitting the first batch", async () => {
    seedPromptBatchVideoProject();

    await renderStudio();

    const historySection = (await screen.findAllByText("对话历史"))[0]?.closest("section") ?? document.body;
    let historyButton: HTMLElement | null = null;
    await waitFor(
      () => {
        historyButton = within(historySection).getByRole("button", {
          name: /雨夜追击首轮出片/,
        });
      },
      { timeout: 3000 },
    );

    await act(async () => {
      fireEvent.click(historyButton!);
      await Promise.resolve();
    });

    await waitForVisibleText(/视频提示词已就绪/);
    expect(screen.getByRole("button", { name: "先生成前 3 条镜头" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "指定镜头出片" })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "指定镜头出片" }));
      await Promise.resolve();
    });

    await waitForVisibleText(/先发《雨夜追击首轮出片》里的哪条镜头/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "镜头 1 · 雨夜起跑" }));
      await Promise.resolve();
    });

    await waitFor(
      () => {
        expect(runWorkflowAction).toHaveBeenCalledWith(
          "generate_video_assets",
          expect.objectContaining({
            projectId: "video-project-prompt",
            targetIds: ["scene-generate-1"],
          }),
          expect.anything(),
        );
      },
      { timeout: 3000 },
    );
  });

  it("surfaces stage-aware refresh choices for running video tasks", async () => {
    seedGeneratingVideoProject();

    await renderStudio();

    const historySection = (await screen.findAllByText("对话历史"))[0]?.closest("section") ?? document.body;
    let historyButton: HTMLElement | null = null;
    await waitFor(
      () => {
        historyButton = within(historySection).getByRole("button", {
          name: /雨夜追击生成中/,
        });
      },
      { timeout: 3000 },
    );

    await act(async () => {
      fireEvent.click(historyButton!);
      await Promise.resolve();
    });

    await waitForVisibleText(/已有镜头在生成中/);
    expect(screen.getByRole("button", { name: "刷新全部进行中镜头" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "指定镜头查看结果" })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "指定镜头查看结果" }));
      await Promise.resolve();
    });

    await waitForVisibleText(/先看《雨夜追击生成中》里的哪条镜头结果/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "镜头 2 · 回头确认" }));
      await Promise.resolve();
    });

    await waitFor(
      () => {
        expect(runWorkflowAction).toHaveBeenCalledWith(
          "refresh_video_assets",
          expect.objectContaining({
            projectId: "video-project-running",
            targetIds: ["scene-running-2"],
          }),
          expect.anything(),
        );
      },
      { timeout: 3000 },
    );
  });

  it("surfaces repair-focused choices for redo-only video review queues", async () => {
    seedRepairVideoProject();

    await renderStudio();

    const historySection = (await screen.findAllByText("对话历史"))[0]?.closest("section") ?? document.body;
    let historyButton: HTMLElement | null = null;
    await waitFor(
      () => {
        historyButton = within(historySection).getByRole("button", {
          name: /雨夜追击修复批次/,
        });
      },
      { timeout: 3000 },
    );

    await act(async () => {
      fireEvent.click(historyButton!);
      await Promise.resolve();
    });

    await waitForVisibleText(/已有 1 条镜头被退回重做/);
    expect(screen.getByRole("button", { name: "直接重做这条镜头" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "指定镜头重做" })).toBeInTheDocument();
  });

  it("can trigger redo workflow from the homepage repair popover", async () => {
    seedRepairVideoProject("video-project-repair-direct");

    await renderStudio();

    const historySection = (await screen.findAllByText("对话历史"))[0]?.closest("section") ?? document.body;
    let historyButton: HTMLElement | null = null;
    await waitFor(
      () => {
        historyButton = within(historySection).getByRole("button", {
          name: /雨夜追击修复批次/,
        });
      },
      { timeout: 3000 },
    );

    await act(async () => {
      fireEvent.click(historyButton!);
      await Promise.resolve();
    });

    await waitForVisibleText(/已有 1 条镜头被退回重做/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "指定镜头重做" }));
      await Promise.resolve();
    });

    await waitForVisibleText(/先重做《雨夜追击修复批次》里的哪条镜头/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "审阅镜头 1 · 雨巷回头" }));
      await Promise.resolve();
    });

    await waitFor(
      () => {
        expect(runWorkflowAction).toHaveBeenCalledWith(
          "redo_video_assets",
          expect.objectContaining({
            projectId: "video-project-repair-direct",
            targetIds: ["packet:video-project-repair:scene-repair-1"],
          }),
          expect.anything(),
        );
        expect(runWorkflowAction).toHaveBeenCalledWith(
          "generate_video_assets",
          expect.objectContaining({
            projectId: "video-project-repair-direct",
            targetIds: ["packet:video-project-repair:scene-repair-1"],
            forceRegenerate: true,
          }),
          expect.anything(),
        );
      },
      { timeout: 3000 },
    );
  });

  it("auto-surfaces the next refresh suggestion after a repair chain starts regeneration", async () => {
    seedRepairVideoProject("video-project-repair-followup");

    runWorkflowAction
      .mockImplementationOnce(async () => ({
        summary: "已将 1 条审阅项标记为重做。",
        projectSnapshot: {
          projectId: "video-project-repair-followup",
          projectKind: "video",
          title: "雨夜追击修复批次",
          currentObjective: "先审阅已有素材，并把需要重做的镜头回流给 Agent。",
          derivedStage: "审阅与修复",
          agentSummary: "当前有镜头需要重做。",
          recommendedActions: ["对需要重做的镜头发起修复"],
          artifacts: [],
        },
        data: {
          projectSnapshot: {
            projectId: "video-project-repair-followup",
            projectKind: "video",
            title: "雨夜追击修复批次",
            currentObjective: "先审阅已有素材，并把需要重做的镜头回流给 Agent。",
            derivedStage: "审阅与修复",
            agentSummary: "当前有镜头需要重做。",
            recommendedActions: ["对需要重做的镜头发起修复"],
            artifacts: [],
          },
        },
      }))
      .mockImplementationOnce(async () => ({
        summary: "已提交 1 条镜头出片任务，当前优先走 Dreamina CLI / Seedance 2.0。",
        projectSnapshot: {
          projectId: "video-project-repair-followup",
          projectKind: "video",
          title: "雨夜追击修复批次",
          currentObjective: "先轮询当前出片结果，再决定进入审阅还是继续补发镜头。",
          derivedStage: "生成中",
          agentSummary: "已有镜头在后台生成中。",
          recommendedActions: ["轮询当前出片结果"],
          artifacts: [],
        },
        data: {
          projectSnapshot: {
            projectId: "video-project-repair-followup",
            projectKind: "video",
            title: "雨夜追击修复批次",
            currentObjective: "先轮询当前出片结果，再决定进入审阅还是继续补发镜头。",
            derivedStage: "生成中",
            agentSummary: "已有镜头在后台生成中。",
            recommendedActions: ["轮询当前出片结果"],
            artifacts: [],
          },
          videoProject: {
            id: "video-project-repair-followup",
            title: "雨夜追击修复批次",
            script: "女主雨夜逃亡，追兵逼近。",
            targetPlatform: "抖音",
            shotStyle: "电影感预告片",
            outputGoal: "修复失败镜头",
            productionNotes: "保持红衣、冷色雨夜和追击氛围。",
            scenes: [
              {
                id: "scene-repair-1",
                sceneNumber: 1,
                sceneName: "雨巷回头",
                description: "女主在巷口回头确认追兵。",
                characters: ["沈昭"],
                dialogue: "",
                cameraDirection: "手持推近",
                duration: 5,
                videoTaskId: "task-repair-1",
                videoStatus: "processing",
              },
            ],
            characters: [],
            sceneSettings: [],
            artStyle: "live-action",
            currentStep: 5,
            systemPrompt: "",
            analysisSummary: "修复任务已重新发起。",
            storyboardPlan: "修复前分镜已存在",
            videoPromptBatch: "修复提示词已准备",
            sourceProjectId: "drama-repair-1",
            createdAt: "2026-04-03T00:00:00.000Z",
            updatedAt: "2026-04-03T00:45:00.000Z",
            styleLock: null,
            worldModel: null,
            assetManifest: null,
            shotPackets: [],
            reviewQueue: [],
          },
        },
      }));

    await renderStudio();

    const historySection = (await screen.findAllByText("对话历史"))[0]?.closest("section") ?? document.body;
    let historyButton: HTMLElement | null = null;
    await waitFor(
      () => {
        historyButton = within(historySection).getByRole("button", {
          name: /雨夜追击修复批次/,
        });
      },
      { timeout: 3000 },
    );

    await act(async () => {
      fireEvent.click(historyButton!);
      await Promise.resolve();
    });

    await waitForVisibleText(/已有 1 条镜头被退回重做/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "直接重做这条镜头" }));
      await Promise.resolve();
    });

    await waitForVisibleText(/已有镜头在生成中/);
    expect(screen.getByRole("button", { name: "刷新 镜头 1 · 雨巷回头" })).toBeInTheDocument();
  });

  it("auto-surfaces review choices after a refresh returns completed video results", async () => {
    seedGeneratingVideoProject("video-project-refresh-review");

    runWorkflowAction.mockImplementationOnce(async () => ({
      summary: "已完成 1 条镜头出片。",
      projectSnapshot: {
        projectId: "video-project-refresh-review",
        projectKind: "video",
        title: "雨夜追击生成中",
        currentObjective: "先审阅已有素材，并把需要重做的镜头回流给 Agent。",
        derivedStage: "审阅与修复",
        agentSummary: "当前已有可审阅镜头。",
        recommendedActions: ["处理 1 条待审阅项"],
        artifacts: [],
        memory: {
          styleLock: null,
          worldModel: null,
          assetManifest: null,
          shotPackets: [],
          reviewQueue: [
            {
              id: "review:packet:video-project-refresh-review:scene-running-1",
              title: "审阅镜头 1 · 巷口冲刺",
              summary: "镜头已生成，确认是否通过或需要重做。",
              targetIds: ["packet:video-project-refresh-review:scene-running-1"],
              status: "pending",
              createdAt: "2026-04-03T00:50:00.000Z",
              updatedAt: "2026-04-03T00:50:00.000Z",
            },
          ],
        },
      },
      data: {
        projectSnapshot: {
          projectId: "video-project-refresh-review",
          projectKind: "video",
          title: "雨夜追击生成中",
          currentObjective: "先审阅已有素材，并把需要重做的镜头回流给 Agent。",
          derivedStage: "审阅与修复",
          agentSummary: "当前已有可审阅镜头。",
          recommendedActions: ["处理 1 条待审阅项"],
          artifacts: [],
          memory: {
            styleLock: null,
            worldModel: null,
            assetManifest: null,
            shotPackets: [],
            reviewQueue: [
              {
                id: "review:packet:video-project-refresh-review:scene-running-1",
                title: "审阅镜头 1 · 巷口冲刺",
                summary: "镜头已生成，确认是否通过或需要重做。",
                targetIds: ["packet:video-project-refresh-review:scene-running-1"],
                status: "pending",
                createdAt: "2026-04-03T00:50:00.000Z",
                updatedAt: "2026-04-03T00:50:00.000Z",
              },
            ],
          },
        },
        videoProject: {
          id: "video-project-refresh-review",
          title: "雨夜追击生成中",
          script: "女主在雨夜奔跑，追兵逐渐逼近。",
          targetPlatform: "抖音",
          shotStyle: "电影感预告片",
          outputGoal: "生成中批次回收",
          productionNotes: "维持夜雨、霓虹、追击氛围。",
          scenes: [
            {
              id: "scene-running-1",
              sceneNumber: 1,
              sceneName: "巷口冲刺",
              description: "女主冲进窄巷，雨水四溅。",
              characters: ["沈昭"],
              dialogue: "",
              cameraDirection: "跟拍推进",
              duration: 5,
              videoUrl: "https://example.com/video-running-1.mp4",
              videoStatus: "completed",
            },
          ],
          characters: [],
          sceneSettings: [],
          artStyle: "live-action",
          currentStep: 5,
          systemPrompt: "",
          analysisSummary: "已有镜头可继续审阅。",
          storyboardPlan: "镜头分镜已整理",
          videoPromptBatch: "镜头提示词已准备",
          sourceProjectId: "drama-running-1",
          createdAt: "2026-04-03T00:00:00.000Z",
          updatedAt: "2026-04-03T00:50:00.000Z",
          styleLock: null,
          worldModel: null,
          assetManifest: null,
          shotPackets: [],
          reviewQueue: [
            {
              id: "review:packet:video-project-refresh-review:scene-running-1",
              title: "审阅镜头 1 · 巷口冲刺",
              summary: "镜头已生成，确认是否通过或需要重做。",
              targetIds: ["packet:video-project-refresh-review:scene-running-1"],
              status: "pending",
              createdAt: "2026-04-03T00:50:00.000Z",
              updatedAt: "2026-04-03T00:50:00.000Z",
            },
          ],
        },
      },
    }));

    await renderStudio();

    const historySection = (await screen.findAllByText("对话历史"))[0]?.closest("section") ?? document.body;
    let historyButton: HTMLElement | null = null;
    await waitFor(
      () => {
        historyButton = within(historySection).getByRole("button", {
          name: /雨夜追击生成中/,
        });
      },
      { timeout: 3000 },
    );

    await act(async () => {
      fireEvent.click(historyButton!);
      await Promise.resolve();
    });

    const refreshButton = await screen.findByRole("button", { name: "刷新全部进行中镜头" }).catch(() => null);
    if (refreshButton) {
      await act(async () => {
        fireEvent.click(refreshButton);
        await Promise.resolve();
      });
    }

    await waitForVisibleText(/待审阅素材/);
    expect(screen.getByRole("button", { name: "整理待审阅项" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "通过稳定项" })).toBeInTheDocument();
  });

  it("supports a Gemini-style collapsible desktop sidebar and persists its state", async () => {
    await renderStudio();

    const collapseButton = screen.getByRole("button", { name: "收起侧栏" });
    await act(async () => {
      fireEvent.click(collapseButton);
      await Promise.resolve();
    });

    expect(localStorage.getItem(DESKTOP_SIDEBAR_COLLAPSE_KEY)).toBe("true");
    expect(screen.getByRole("button", { name: "展开侧栏" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始新项目" })).toBeInTheDocument();

    cleanup();
    await renderStudio();
    expect(screen.getByRole("button", { name: "展开侧栏" })).toBeInTheDocument();
  });

  it("renders background agent tasks inside the homepage conversation surface", async () => {
    writeTask({
      id: "task-1",
      prompt: "并行研究: 女性短剧市场趋势",
      status: "running",
      sessionId: "session-current",
      projectId: "drama-project-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    localStorage.setItem(STUDIO_SESSION_KEY, JSON.stringify(createSession({ qState: null, draft: "" })));

    await renderStudio();

    await waitForVisibleText("Agent 任务");
    expect(screen.getByText(/女性短剧市场趋势/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();
  });

  it("restores persisted background tasks when the homepage remounts", async () => {
    localStorage.setItem(STUDIO_SESSION_KEY, JSON.stringify(createSession({ qState: null, draft: "" })));
    localStorage.setItem(
      TASK_STORAGE_KEY,
      JSON.stringify([
        {
          id: "task-restored-1",
          prompt: "并行研究: 刷新后恢复的任务",
          status: "completed",
          output: "已恢复旧任务结果",
          sessionId: "session-current",
          projectId: "drama-project-1",
          createdAt: Date.now() - 1000,
          updatedAt: Date.now() - 1000,
        },
      ]),
    );

    await renderStudio();

    await waitForVisibleText("Agent 任务");
    expect(screen.getAllByText(/刷新后恢复的任务/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/已恢复旧任务结果/).length).toBeGreaterThan(0);
  });

  it("does not re-inject completed task results that were already surfaced before a refresh", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(
        createSession({
          messages: [],
          qState: null,
          draft: "",
          selectedValues: [],
          surfacedTaskIds: ["task-restored-2"],
          surfacedTaskFollowupKeys: ["task-restored-2"],
          recentMessageSummary: "",
        }),
      ),
    );
    localStorage.setItem(
      TASK_STORAGE_KEY,
      JSON.stringify([
        {
          id: "task-restored-2",
          prompt: "并行研究: 不要重复回流的任务",
          status: "completed",
          output: "这条结果已经在上一次会话里展示过。",
          sessionId: "session-current",
          projectId: "drama-project-1",
          createdAt: Date.now() - 1000,
          updatedAt: Date.now() - 1000,
        },
      ]),
    );

    await renderStudio();

    await waitForVisibleText("Agent 任务");
    expect(screen.getAllByText(/不要重复回流的任务/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/后台研究已完成：并行研究 不要重复回流的任务/)).not.toBeInTheDocument();
  });

  it("does not auto-surface the same project recovery suggestion again after refresh", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(
        createSession({
          qState: null,
          draft: "",
          selectedValues: [],
          surfacedProjectSuggestionKeys: ["drama-project-1:创意方案:r-drama-project-1"],
        }),
      ),
    );

    await renderStudio();

    await waitForVisibleText("继续保留第 2 集的张力。");
    expect(screen.queryByText(/我已分析《契约婚姻反转录》的当前状态/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "继续推进角色设定" })).not.toBeInTheDocument();
  });

  it("collapses older completed tasks into a compact summary row", async () => {
    localStorage.setItem(STUDIO_SESSION_KEY, JSON.stringify(createSession({ qState: null, draft: "" })));

    writeTask({
      id: "task-running-current",
      prompt: "并行研究: 当前市场风向",
      status: "running",
      sessionId: "session-current",
      projectId: "drama-project-1",
      createdAt: Date.now() - 1000,
      updatedAt: Date.now() - 1000,
    });

    for (let index = 0; index < 5; index += 1) {
      writeTask({
        id: `task-completed-${index}`,
        prompt: `并行研究: 已完成方向 ${index + 1}`,
        status: "completed",
        output: `结论 ${index + 1}`,
        sessionId: "session-current",
        projectId: "drama-project-1",
        createdAt: Date.now() - 800 + index,
        updatedAt: Date.now() - 800 + index,
      });
    }

    await renderStudio();

    await waitForVisibleText("Agent 任务");
    expect(screen.getByText("已整理 2 条较早任务记录")).toBeInTheDocument();
    expect(screen.getByText(/当前市场风向/)).toBeInTheDocument();
  });

  it("can stop a running background task from the homepage surface", async () => {
    writeTask({
      id: "task-stop-1",
      prompt: "并行研究: 改编方向比较",
      status: "running",
      sessionId: "session-current",
      projectId: "drama-project-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    localStorage.setItem(STUDIO_SESSION_KEY, JSON.stringify(createSession({ qState: null, draft: "" })));

    await renderStudio();

    await waitForVisibleText("Agent 任务");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "停止" }));
      await Promise.resolve();
    });

    expect(getTask("task-stop-1")?.status).toBe("cancelled");
  });

  it("uses the composer stop button as a global interrupt and restores the current popup", async () => {
    writeTask({
      id: "task-stop-global-1",
      prompt: "并行研究: 当前暂停中的后台任务",
      status: "running",
      sessionId: "session-current",
      projectId: "drama-project-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    localStorage.setItem(STUDIO_SESSION_KEY, JSON.stringify(createSession()));

    let releaseInterrupt: (() => void) | null = null;
    mockSubmitMessageImpl = async function* (prompt?: string) {
      lastSubmittedPrompt = String(prompt ?? "");
      await new Promise<void>((resolve) => {
        releaseInterrupt = resolve;
      });
    };
    onMockEngineInterrupt = () => {
      releaseInterrupt?.();
    };

    await renderStudio();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "都市" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      const composerStopButton = document.body.querySelector(
        "button .lucide-square.h-4.w-4.fill-current",
      )?.closest("button");
      expect(composerStopButton).toBeTruthy();
    });

    await act(async () => {
      const composerStopButton = document.body.querySelector(
        "button .lucide-square.h-4.w-4.fill-current",
      )?.closest("button");
      fireEvent.click(composerStopButton!);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText("已停止当前执行，刚才的弹窗已恢复，你可以重新选择。")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "都市" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "悬疑" })).toBeInTheDocument();
    mockSubmitMessageImpl = async function* () {
      await new Promise<void>(() => undefined);
    };

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "都市" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "都市" })).not.toBeInTheDocument();
    });

    expect(getTask("task-stop-global-1")?.status).toBe("cancelled");
  });

  it("re-opens the popup after a timeout and closes it again once the user retries", async () => {
    localStorage.setItem(STUDIO_SESSION_KEY, JSON.stringify(createSession()));

    mockSubmitMessageImpl = async function* (prompt?: string) {
      lastSubmittedPrompt = String(prompt ?? "");
      throw new Error("请求超时（>60秒），请检查网络后重试");
    };

    await renderStudio();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "都市" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText(/超时|timeout/i)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "都市" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "悬疑" })).toBeInTheDocument();

    mockSubmitMessageImpl = async function* () {
      await new Promise<void>(() => undefined);
    };

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "都市" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "都市" })).not.toBeInTheDocument();
    });
  });

  it("auto-injects completed background research back into the homepage conversation", async () => {
    writeTask({
      id: "task-complete-1",
      prompt: "并行研究: 女频都市反转短剧市场",
      status: "running",
      sessionId: "session-current",
      projectId: "drama-project-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    localStorage.setItem(STUDIO_SESSION_KEY, JSON.stringify(createSession({ qState: null, draft: "" })));

    await renderStudio();
    await waitForVisibleText("Agent 任务");

    act(() => {
      updateTask("task-complete-1", {
        status: "completed",
        output: "结论：抖音更适合强钩子、快反转、女性情绪拉扯。",
      });
    });

    await waitForVisibleText(/后台研究已完成/);
    expect(screen.getAllByText(/抖音更适合强钩子/).length).toBeGreaterThan(0);
  });

  /* legacy follow-up popover removal test temporarily disabled
    writeTask({
      id: "task-followup-1",
      prompt: "骞惰鐮旂┒ 鐩爣甯傚満: 濂抽閮藉競鐭墽骞冲彴閫傞厤",
      status: "running",
      sessionId: "session-current",
      projectId: "drama-project-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    localStorage.setItem(STUDIO_SESSION_KEY, JSON.stringify(createSession({ qState: null, draft: "" })));

    await renderStudio();
    await waitForVisibleText("Agent 浠诲姟");

    act(() => {
      updateTask("task-followup-1", {
        status: "completed",
        output: "缁撹锛氭姈闊充紭鍏堬紝灏忕孩涔﹂€傚悎浣滀负瑙掕壊绉嶈崏琛ュ厖銆?,
      });
    });

    await waitForVisibleText(/鍚庡彴鐮旂┒宸插畬鎴?/);
    await waitFor(() => {
      expect(screen.queryByText("鍚庡彴鐮旂┒宸茶繑鍥烇紝涓嬩竴姝ユ€庝箞鎺ㄨ繘锛?)).not.toBeInTheDocument();
    });
  });

  */
  it("hides background tasks from other homepage sessions", async () => {
    writeTask({
      id: "task-other-session",
      prompt: "并行研究: 不应出现在当前会话",
      status: "running",
      sessionId: "session-other",
      projectId: "drama-project-2",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    localStorage.setItem(STUDIO_SESSION_KEY, JSON.stringify(createSession({ qState: null, draft: "" })));

    await renderStudio();

    expect(screen.queryByText("Agent 任务")).not.toBeInTheDocument();
    expect(screen.queryByText(/不应出现在当前会话/)).not.toBeInTheDocument();
  });

  it("resolves multi-step ask-user-question only on the final step", async () => {
    await renderStudio();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("agent:ask-user-question", {
          detail: createQuestionRequest({
            id: "ask-multi",
            questions: [
              {
                header: "平台",
                question: "选择目标平台",
                multiSelect: false,
                options: [{ label: "抖音" }, { label: "小红书" }],
              },
              {
                header: "风格",
                question: "选择镜头风格",
                multiSelect: false,
                options: [{ label: "纪录片感" }, { label: "高级广告感" }],
              },
            ],
          }),
        }),
      );
    });

    await screen.findByText("选择目标平台");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "抖音" }));
      await Promise.resolve();
    });

    expect(resolveAskUserQuestion).not.toHaveBeenCalled();
    await screen.findByText("选择镜头风格");

    const textarea = screen.getByPlaceholderText(/也可以跳过上方建议/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "电影感" } });
    const sendButton = findSendButton();
    expect(sendButton).toBeTruthy();
    await act(async () => {
      fireEvent.click(sendButton!);
      await Promise.resolve();
    });

    await waitFor(
      () => {
        expect(resolveAskUserQuestion).toHaveBeenCalledTimes(1);
      },
      { timeout: 3000 },
    );
    expect(resolveAskUserQuestion).toHaveBeenCalledWith("ask-multi", "平台: 抖音\n风格: 电影感");
  });

  it("falls back to a fresh homepage send when a restored ask-user-question request is no longer live", async () => {
    assistantReply = "已根据恢复的问题继续推进。";
    localStorage.setItem(STUDIO_SESSION_KEY, JSON.stringify(createSession()));

    await renderStudio();

    await waitForVisibleText("继续选择题材");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "都市" }));
      await Promise.resolve();
    });

    await waitForVisibleText("已根据恢复的问题继续推进。");
    expect(lastSubmittedPrompt).toBe("都市");
    expect(resolveAskUserQuestion).not.toHaveBeenCalled();
    expect(screen.getAllByText("题材：都市")).toHaveLength(1);
  });

  it("aggregates multi-select answers with custom input in confirm mode", async () => {
    await renderStudio();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("agent:ask-user-question", {
          detail: createQuestionRequest({
            id: "ask-confirm",
            submissionMode: "confirm",
            questions: [
              {
                header: "元素",
                question: "保留哪些元素？",
                multiSelect: true,
                options: [{ label: "反转" }, { label: "情绪" }, { label: "悬念" }],
              },
            ],
          }),
        }),
      );
    });

    await screen.findByText("保留哪些元素？");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "反转" }));
      fireEvent.click(screen.getByRole("button", { name: "情绪" }));
      await Promise.resolve();
    });

    const textarea = screen.getByPlaceholderText(/也可以跳过上方建议/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "结尾要更克制" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "继续" }));
      await Promise.resolve();
    });

    await waitFor(
      () => {
        expect(resolveAskUserQuestion).toHaveBeenCalledTimes(1);
      },
      { timeout: 3000 },
    );
    expect(resolveAskUserQuestion).toHaveBeenCalledWith("ask-confirm", "反转 / 情绪\n补充：结尾要更克制");
  });

  it("falls back to a fresh homepage send for restored confirm questions when the live request is gone", async () => {
    assistantReply = "已接住恢复后的组合回答并继续分析。";
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(
        createSession({
          draft: "结尾要更克制",
          qState: {
            request: createQuestionRequest({
              id: "ask-confirm-restored",
              submissionMode: "confirm",
              questions: [
                {
                  header: "元素",
                  question: "保留哪些元素？",
                  multiSelect: true,
                  options: [{ label: "反转" }, { label: "情绪" }, { label: "悬念" }],
                },
              ],
            }),
            currentIndex: 0,
            answers: {},
            displayAnswers: {},
          },
          selectedValues: ["反转", "情绪"],
        }),
      ),
    );

    await renderStudio();

    await waitForVisibleText("保留哪些元素？");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "继续" }));
      await Promise.resolve();
    });

    await waitForVisibleText("已接住恢复后的组合回答并继续分析。");
    expect(lastSubmittedPrompt).toBe("反转 / 情绪\n补充：结尾要更克制");
    expect(resolveAskUserQuestion).not.toHaveBeenCalled();
    expect(screen.getAllByText(/元素：反转 \/ 情绪/).length).toBeGreaterThan(0);
  });

  it("restores a saved project conversation from history without leaving the homepage", async () => {
    seedDramaProject();
    localStorage.setItem(
      STUDIO_PROJECT_SESSIONS_KEY,
      JSON.stringify({
        "drama-project-1": createSession(),
      }),
    );

    await renderStudio();

    const historySection = (await screen.findAllByText("对话历史"))[0]?.closest("section") ?? document.body;
    let historyButton: HTMLElement | null = null;
    await waitFor(
      () => {
        historyButton = within(historySection).getByRole("button", {
          name: /契约婚姻反转录/,
        });
      },
      { timeout: 3000 },
    );
    await act(async () => {
      fireEvent.click(historyButton!);
      await Promise.resolve();
    });

    expect(window.location.pathname).toBe("/");
    await waitForVisibleText("继续保留第 2 集的张力。");
    expect(screen.getByDisplayValue("补充反派动机")).toBeInTheDocument();
    expect(screen.getByText("继续选择题材")).toBeInTheDocument();
  });

  it("restores a saved project conversation from agent handoff without leaving the homepage", async () => {
    seedDramaProject();
    localStorage.setItem(
      STUDIO_PROJECT_SESSIONS_KEY,
      JSON.stringify({
        "drama-project-1": createSession(),
      }),
    );
    consumeAgentHandoff.mockReturnValueOnce({
      prompt: "",
      route: "script-creator",
      title: "恢复项目",
      subtitle: "继续推进",
      resumeProjectId: "drama-project-1",
      source: "home",
      createdAt: "2026-04-03T00:00:00.000Z",
    });

    await renderStudio();

    await waitForVisibleText("继续保留第 2 集的张力。");
    expect(screen.getByDisplayValue("补充反派动机")).toBeInTheDocument();
    expect(screen.getByText("继续选择题材")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
  });

  it("re-shows a pending ask-user-question after switching away and back", async () => {
    localStorage.setItem(
      DRAMA_PROJECTS_KEY,
      JSON.stringify([
        {
          id: "drama-project-1",
          dramaTitle: "契约婚姻反转录",
          currentStep: "creative-plan",
          updatedAt: "2026-04-02T00:00:00.000Z",
          createdAt: "2026-04-01T00:00:00.000Z",
          setup: {
            genres: ["都市言情"],
            audience: "女频",
            tone: "甜虐",
            ending: "HE",
            totalEpisodes: 40,
            targetMarket: "cn",
            creativeInput: "替父还债的女主和冷面继承人签下契约婚姻。",
          },
        },
        {
          id: "drama-project-2",
          dramaTitle: "夜色回廊",
          currentStep: "directory",
          updatedAt: "2026-04-03T00:00:00.000Z",
          createdAt: "2026-04-02T00:00:00.000Z",
          creativePlan: "已完成大纲。",
        },
      ]),
    );
    localStorage.setItem(STUDIO_SESSION_KEY, JSON.stringify(createSession()));

    await renderStudio();

    const historySection = (await screen.findAllByText("对话历史"))[0]?.closest("section") ?? document.body;
    let historyButton: HTMLElement | null = null;
    await waitFor(() => {
      historyButton = within(historySection).getByRole("button", {
        name: /夜色回廊/,
      });
    });

    await act(async () => {
      fireEvent.click(historyButton!);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByText("继续选择题材")).not.toBeInTheDocument();
    });

    expect(rejectAskUserQuestion).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(
        within(historySection).getByRole("button", {
          name: /契约婚姻反转/,
        }),
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText("继续选择题材")).toBeInTheDocument();
    });
  });
  it("re-shows a dismissed ask-user-question after reopening the homepage", async () => {
    localStorage.setItem(STUDIO_SESSION_KEY, JSON.stringify(createSession()));
    const questionOptionLabel = createSession().qState?.request.questions[0]?.options[0]?.label ?? "";

    await renderStudio();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: questionOptionLabel })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mock-choice-dismiss"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: questionOptionLabel })).not.toBeInTheDocument();
    });

    cleanup();

    await renderStudio();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: questionOptionLabel })).toBeInTheDocument();
    });
  });

  it("re-shows a pending suggested choice after switching away and back without dismissing it", async () => {
    localStorage.setItem(
      DRAMA_PROJECTS_KEY,
      JSON.stringify([
        {
          id: "drama-project-1",
          dramaTitle: "契约婚姻反转篇",
          currentStep: "creative-plan",
          updatedAt: "2026-04-02T00:00:00.000Z",
          createdAt: "2026-04-01T00:00:00.000Z",
          setup: {
            genres: ["都市言情"],
            audience: "女频",
            tone: "甜虐",
            ending: "HE",
            totalEpisodes: 40,
            targetMarket: "cn",
            creativeInput: "替父还债的女主和冷面继承人签下契约婚姻。",
          },
        },
        {
          id: "drama-project-2",
          dramaTitle: "夜色回廊",
          currentStep: "directory",
          updatedAt: "2026-04-03T00:00:00.000Z",
          createdAt: "2026-04-02T00:00:00.000Z",
          creativePlan: "已完成大纲。",
        },
      ]),
    );

    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(
        createSession({
          qState: null,
          draft: "",
          selectedValues: [],
          pendingChoiceQuestion: {
            id: "script-creative-plan-drama-project-1",
            title: "下一步：继续推进角色设定",
            description: "创作方案已就绪，直接开始生成主要角色设定。",
            options: [
              {
                id: "drama-project-1-enter-characters",
                label: "继续推进角色设定",
                value: "继续推进角色设定",
              },
              {
                id: "drama-project-1-rewrite-plan",
                label: "重写创意方案",
                value: "重写创意方案",
              },
            ],
            allowCustomInput: true,
            submissionMode: "immediate",
            multiSelect: false,
            stepIndex: 0,
            totalSteps: 1,
            answerKey: "script-creative-plan",
          },
          surfacedProjectSuggestionKeys: [],
        }),
      ),
    );

    await renderStudio();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "继续推进角色设定" })).toBeInTheDocument();
    });

    const historySection = (await screen.findAllByText("对话历史"))[0]?.closest("section") ?? document.body;

    await act(async () => {
      fireEvent.click(
        within(historySection).getByRole("button", {
          name: /夜色回廊/,
        }),
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "继续推进角色设定" })).not.toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(
        within(historySection).getByRole("button", {
          name: /契约婚姻反转篇/,
        }),
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "继续推进角色设定" })).toBeInTheDocument();
    });
  });

  it("re-shows a dismissed pending choice after reopening the homepage", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(
        createSession({
          qState: null,
          draft: "",
          selectedValues: [],
          pendingChoiceQuestion: {
            id: "script-creative-plan-drama-project-1",
            title: "涓嬩竴姝ワ細缁х画鎺ㄨ繘瑙掕壊璁惧畾",
            description: "鍒涗綔鏂规宸插氨缁紝鐩存帴寮€濮嬬敓鎴愪富瑕佽鑹茶瀹氥€?",
            options: [
              {
                id: "drama-project-1-enter-characters",
                label: "缁х画鎺ㄨ繘瑙掕壊璁惧畾",
                value: "缁х画鎺ㄨ繘瑙掕壊璁惧畾",
              },
            ],
            allowCustomInput: true,
            submissionMode: "immediate",
            multiSelect: false,
            stepIndex: 0,
            totalSteps: 1,
            answerKey: "script-creative-plan",
          },
          surfacedProjectSuggestionKeys: [],
        }),
      ),
    );

    await renderStudio();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "缁х画鎺ㄨ繘瑙掕壊璁惧畾" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mock-choice-dismiss"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "缁х画鎺ㄨ繘瑙掕壊璁惧畾" })).not.toBeInTheDocument();
    });

    cleanup();

    await renderStudio();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "缁х画鎺ㄨ繘瑙掕壊璁惧畾" })).toBeInTheDocument();
    });
  });

  it("re-shows a restored video workflow suggestion after reopening the homepage in creative mode", async () => {
    const videoProject = createRecoveryVideoProject();
    const snapshot = createVideoSnapshot(videoProject);
    const question = recQuestion(snapshot, videoProject);
    expect(question).not.toBeNull();
    const suggestionKey = buildProjectSuggestionKey(snapshot, question);
    expect(suggestionKey).toBeTruthy();
    localStorage.setItem(VIDEO_PROJECTS_KEY, JSON.stringify([videoProject]));
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(
        createSession({
          creationMode: "creative",
          qState: null,
          draft: "",
          selectedValues: [],
          pendingChoiceQuestion: null,
          currentProjectSnapshot: snapshot,
          recentMessageSummary: "assistant: 视频桥接已建立。",
          projectId: videoProject.id,
          messages: [
            {
              id: "assistant-video-recovery-1",
              role: "assistant",
              content: "视频桥接已建立。",
              createdAt: "2026-04-03T00:00:00.000Z",
            },
          ],
          surfacedProjectSuggestionKeys: suggestionKey ? [suggestionKey] : [],
        }),
      ),
    );

    await renderStudio();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: question!.options[0]!.label })).toBeInTheDocument();
    });
  });

  it("re-shows a restored video workflow suggestion after switching back to the project in fast mode", async () => {
    const videoProject = createRecoveryVideoProject({
      id: "video-recovery-project-switch",
      title: "雨夜追击视频桥接",
    });
    const snapshot = createVideoSnapshot(videoProject);
    const question = recQuestion(snapshot, videoProject);
    expect(question).not.toBeNull();
    const suggestionKey = buildProjectSuggestionKey(snapshot, question);
    expect(suggestionKey).toBeTruthy();
    seedDramaProject();
    localStorage.setItem(VIDEO_PROJECTS_KEY, JSON.stringify([videoProject]));
    localStorage.setItem(STUDIO_SESSION_KEY, JSON.stringify(createSession({ qState: null, draft: "", selectedValues: [] })));
    localStorage.setItem(
      STUDIO_PROJECT_SESSIONS_KEY,
      JSON.stringify({
        [videoProject.id]: createSession({
          creationMode: "fast",
          qState: null,
          draft: "",
          selectedValues: [],
          pendingChoiceQuestion: null,
          currentProjectSnapshot: snapshot,
          recentMessageSummary: "assistant: 视频桥接已建立。",
          projectId: videoProject.id,
          messages: [
            {
              id: "assistant-video-recovery-switch-1",
              role: "assistant",
              content: "视频桥接已建立。",
              createdAt: "2026-04-03T00:00:00.000Z",
            },
          ],
          surfacedProjectSuggestionKeys: suggestionKey ? [suggestionKey] : [],
        }),
      }),
    );

    await renderStudio();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /雨夜追击视频桥接/ }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: question!.options[0]!.label })).toBeInTheDocument();
    });
  });

  it("interrupts the active engine before restoring another project into the homepage", async () => {
    localStorage.setItem(
      DRAMA_PROJECTS_KEY,
      JSON.stringify([
        {
          id: "drama-project-2",
          dramaTitle: "夜色回廊",
          currentStep: "directory",
          updatedAt: "2026-04-03T00:00:00.000Z",
          createdAt: "2026-04-02T00:00:00.000Z",
          creativePlan: "已完成大纲。",
        },
      ]),
    );

    await renderStudio();

    await fillComposer("先帮我分析这个项目");
    await act(async () => {
      fireEvent.click(findSendButton()!);
      await Promise.resolve();
    });
    await waitForVisibleText("好的，我们开始。");

    const historySection = (await screen.findAllByText("对话历史"))[0]?.closest("section") ?? document.body;
    let historyButton: HTMLElement | null = null;
    await waitFor(() => {
      historyButton = within(historySection).getByRole("button", {
        name: /夜色回廊/,
      });
    });

    await act(async () => {
      fireEvent.click(historyButton!);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastEngineInterrupt).toHaveBeenCalledTimes(1);
    });
  });

  it("routes prompt handoff through the homepage send flow", async () => {
    consumeAgentHandoff.mockReturnValueOnce({
      prompt: "请接着推进这个原创剧本项目",
      route: "script-creator",
      title: "继续创作",
      subtitle: "保持在首页会话中",
      source: "home",
      createdAt: "2026-04-03T00:00:00.000Z",
    });

    await renderStudio();

    await waitFor(() => {
      expect(lastSubmittedPrompt).toContain("请接着推进这个原创剧本项目");
    });
    expect(screen.getAllByText(/继续创作/).length).toBeGreaterThan(0);
  });

  it("launches original script quick task with a topic-or-creative split before the market question", async () => {
    await renderStudio();

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /原创剧本/ })[0]!);
      await Promise.resolve();
    });

    await waitForVisibleText("这次想从哪种方式开始原创剧本？");
    expect(screen.getByRole("button", { name: "选题创作" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创意创作" })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "选题创作" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "国内（中文）" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "国内（中文）" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "日本（日文）" })).toBeInTheDocument();
  });

  it("bootstraps an adaptation project and shows the adaptation kickoff choices without auto-starting LLM", async () => {
    lastSubmittedPrompt = "";
    runWorkflowAction.mockImplementationOnce(async (_action, input) => ({
      summary: "adaptation setup saved",
      projectSnapshot: {
        projectId: "adaptation-template-project",
        projectKind: "adaptation",
        title: "Adaptation Project",
        currentObjective: "Confirm market and adaptation direction",
        derivedStage: "Reference Script",
        agentSummary: "Adaptation setup is ready for the next turn.",
        recommendedActions: ["Analyze reference script"],
        artifacts: [],
      },
      data: {
        dramaProject: {
          id: "adaptation-template-project",
          mode: "adaptation",
          setup: {
            genres: [],
            audience: "all",
            tone: "dramatic",
            ending: "OE",
            totalEpisodes: 60,
            targetMarket: "cn",
            customTopic: "",
            creativeInput: "",
          },
          creativePlan: "",
          characters: "",
          directory: [],
          directoryRaw: "",
          episodes: [],
          complianceReport: "",
          currentStep: "reference-script",
          dramaTitle: "",
          createdAt: "2026-04-06T00:00:00.000Z",
          updatedAt: "2026-04-06T00:00:00.000Z",
          referenceScript: "",
          referenceStructure: "",
          frameworkStyle: "",
          structureTransform: "",
          characterTransform: "",
          exportDocument: "",
          styleLock: null,
          worldModel: null,
          characterStateCards: [],
          storyBeatPackets: [],
          complianceRevisionPackets: [],
        },
        projectSnapshot: {
          projectId: "adaptation-template-project",
          projectKind: "adaptation",
          title: "Adaptation Project",
          currentObjective: "Confirm market and adaptation direction",
          derivedStage: "Reference Script",
          agentSummary: "Adaptation setup is ready for the next turn.",
          recommendedActions: ["Analyze reference script"],
          artifacts: [],
        },
      },
    }));

    await renderStudio();

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /参考改编/ })[0]!);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(runWorkflowAction).toHaveBeenCalledWith(
        "save_setup",
        expect.objectContaining({
          projectKind: "adaptation",
          forceNewProject: true,
        }),
        expect.anything(),
      );
    });

    await waitFor(() => {
      const persistedSessions = JSON.parse(localStorage.getItem(STUDIO_PROJECT_SESSIONS_KEY) || "{}") as Record<
        string,
        { projectId?: string }
      >;
      expect(persistedSessions["adaptation-template-project"]?.projectId).toBe("adaptation-template-project");
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "上传参考文档" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "直接开始对话" })).toBeInTheDocument();
    expect(lastSubmittedPrompt).toBe("");
  });

  it("rewinds original script kickoff selections by replacing the previous answer instead of appending a duplicate bubble", async () => {
    await renderStudio();

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /原创剧本/ })[0]!);
      await Promise.resolve();
    });

    await waitForVisibleText("这次想从哪种方式开始原创剧本？");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "选题创作" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "国内（中文）" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "国内（中文）" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText("目标市场：国内（中文）")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "返回上一步" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "欧美（英文）" })).toBeInTheDocument();
    });
    expect(screen.queryByText("目标市场：国内（中文）")).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "欧美（英文）" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText("目标市场：欧美（英文）")).toBeInTheDocument();
    });
    expect(screen.queryByText("目标市场：国内（中文）")).not.toBeInTheDocument();
    expect(screen.getAllByText(/目标市场：/).length).toBe(1);
  });

  it("rewinds later kickoff steps by replacing the prior word-count bubble instead of appending another one", async () => {
    await renderStudio();

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /原创剧本/ })[0]!);
      await Promise.resolve();
    });

    await waitForVisibleText("这次想从哪种方式开始原创剧本？");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "选题创作" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "国内（中文）" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "国内（中文）" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "都市言情" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "都市言情" }));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "继续" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "女频" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "女频" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "甜虐" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "甜虐" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "HE（好结局）" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "HE（好结局）" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "40集（紧凑）" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "40集（紧凑）" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText("集数规模：40集（紧凑）")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "返回上一步" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "60集（标准）" })).toBeInTheDocument();
    });
    expect(screen.queryByText("集数规模：40集（紧凑）")).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "60集（标准）" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText("集数规模：60集（标准）")).toBeInTheDocument();
    });
    expect(screen.queryByText("集数规模：40集（紧凑）")).not.toBeInTheDocument();
    expect(screen.getAllByText(/集数规模：/).length).toBe(1);
  });

  it("saves topic-mode original script kickoff as structured setup with market filtering and a two-persona cap", async () => {
    lastSubmittedPrompt = "";
    runWorkflowAction.mockImplementationOnce(async (_action, input) => ({
      summary: "已写入原创剧本立项，并切到角色设定阶段。",
      projectSnapshot: {
        projectId: "script-kickoff-topic-project",
        projectKind: "script",
        title: "未命名项目",
        currentObjective: "继续完善角色弧光、关系冲突与人物口吻。",
        derivedStage: "角色设定",
        agentSummary: "已按首页原创立项写入结构化 setup，下一步继续人设开发。",
        recommendedActions: ["继续角色设定", "补充人物冲突"],
        artifacts: [],
      },
      data: {
        dramaProject: {
          id: "script-kickoff-topic-project",
          mode: "traditional",
          setup: input,
          creativePlan: "",
          characters: "",
          directory: [],
          directoryRaw: "",
          episodes: [],
          complianceReport: "",
          currentStep: "characters",
          dramaTitle: "",
          createdAt: "2026-04-06T00:00:00.000Z",
          updatedAt: "2026-04-06T00:00:00.000Z",
          referenceScript: "",
          referenceStructure: "",
          frameworkStyle: "",
          structureTransform: "",
          characterTransform: "",
          exportDocument: "",
          styleLock: null,
          worldModel: null,
          characterStateCards: [],
          storyBeatPackets: [],
          complianceRevisionPackets: [],
        },
        projectSnapshot: {
          projectId: "script-kickoff-topic-project",
          projectKind: "script",
          title: "未命名项目",
          currentObjective: "继续完善角色弧光、关系冲突与人物口吻。",
          derivedStage: "角色设定",
          agentSummary: "已按首页原创立项写入结构化 setup，下一步继续人设开发。",
          recommendedActions: ["继续角色设定", "补充人物冲突"],
          artifacts: [],
        },
      },
    }));

    await renderStudio();

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /原创剧本/ })[0]!);
      await Promise.resolve();
    });

    await screen.findByText("这次想从哪种方式开始原创剧本？");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "选题创作" }));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "欧美（英文）" }));
      await Promise.resolve();
    });

    await screen.findByText("先选 1 到 2 个更接近你这次方向的题材。");
    expect(screen.getByRole("button", { name: "犯罪惊悚" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "古风权谋" })).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "犯罪惊悚" }));
      fireEvent.click(screen.getByRole("button", { name: "浪漫喜剧" }));
      fireEvent.click(screen.getByRole("button", { name: "超级英雄" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "继续" }));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "按默认配置进入人设开发" }));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "暂不补充" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(runWorkflowAction).toHaveBeenCalledWith(
        "save_setup",
        expect.objectContaining({
          projectKind: "script",
          setupMode: "topic",
          targetMarket: "west",
          genres: ["犯罪惊悚", "浪漫喜剧"],
          audience: "女频",
          tone: "甜虐",
          ending: "HE",
          totalEpisodes: 500,
        }),
        expect.anything(),
      );
    });
    expect(lastSubmittedPrompt).toBe("");
    expect(screen.getAllByText(/角色设定/).length).toBeGreaterThan(0);
  });

  it("saves creative-mode original script kickoff as structured setup without falling back to a prompt send", async () => {
    lastSubmittedPrompt = "";
    runWorkflowAction.mockImplementationOnce(async (_action, input) => ({
      summary: "已收下你的创意并写入原创剧本立项，下一步继续人设开发。",
      projectSnapshot: {
        projectId: "script-kickoff-creative-project",
        projectKind: "script",
        title: "未命名项目",
        currentObjective: "继续完善角色弧光、关系冲突与人物口吻。",
        derivedStage: "角色设定",
        agentSummary: "创意内容已经落成结构化 setup，继续做人设开发。",
        recommendedActions: ["继续角色设定", "补充人物冲突"],
        artifacts: [],
      },
      data: {
        dramaProject: {
          id: "script-kickoff-creative-project",
          mode: "traditional",
          setup: input,
          creativePlan: "",
          characters: "",
          directory: [],
          directoryRaw: "",
          episodes: [],
          complianceReport: "",
          currentStep: "characters",
          dramaTitle: "",
          createdAt: "2026-04-06T00:00:00.000Z",
          updatedAt: "2026-04-06T00:00:00.000Z",
          referenceScript: "",
          referenceStructure: "",
          frameworkStyle: "",
          structureTransform: "",
          characterTransform: "",
          exportDocument: "",
          styleLock: null,
          worldModel: null,
          characterStateCards: [],
          storyBeatPackets: [],
          complianceRevisionPackets: [],
        },
        projectSnapshot: {
          projectId: "script-kickoff-creative-project",
          projectKind: "script",
          title: "未命名项目",
          currentObjective: "继续完善角色弧光、关系冲突与人物口吻。",
          derivedStage: "角色设定",
          agentSummary: "创意内容已经落成结构化 setup，继续做人设开发。",
          recommendedActions: ["继续角色设定", "补充人物冲突"],
          artifacts: [],
        },
      },
    }));

    await renderStudio();

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /原创剧本/ })[0]!);
      await Promise.resolve();
    });

    await screen.findByText("这次想从哪种方式开始原创剧本？");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "创意创作" }));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "国内（中文）" }));
      await Promise.resolve();
    });

    await screen.findByText("把你的创意想法、故事灵感或文档摘要直接发给我。");
    await fillComposer("替父还债的女孩被迫签下豪门契约婚姻，却在婚后发现对方也在借她布局一场身份反转。");

    await act(async () => {
      fireEvent.click(findSendButton()!);
      await Promise.resolve();
    });

    await screen.findByText("这轮立项先沿用默认配置，还是逐项细调？");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "按默认配置进入人设开发" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(runWorkflowAction).toHaveBeenCalledWith(
        "save_setup",
        expect.objectContaining({
          projectKind: "script",
          setupMode: "creative",
          targetMarket: "cn",
          genres: [],
          audience: "女频",
          tone: "甜虐",
          ending: "HE",
          totalEpisodes: 500,
          creativeInput: "替父还债的女孩被迫签下豪门契约婚姻，却在婚后发现对方也在借她布局一场身份反转。",
        }),
        expect.anything(),
      );
    });
    expect(lastSubmittedPrompt).toBe("");
  });

  it("hides the role-development choice panel until character generation returns", async () => {
    let resolveWorkflow:
      | ((value: {
          summary: string;
          projectSnapshot: StudioSessionState["currentProjectSnapshot"];
          data: { projectSnapshot: StudioSessionState["currentProjectSnapshot"] };
        }) => void)
      | null = null;
    seedCharactersStageDramaProject("drama-project-1");

    runWorkflowAction.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveWorkflow = resolve;
        }),
    );

    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(
        createSession({
          qState: null,
          draft: "",
          selectedValues: [],
          messages: [
            {
              id: "assistant-role-step",
              role: "assistant",
              content: "创作方案已完成，可继续进入角色开发。",
              createdAt: "2026-04-08T00:00:00.000Z",
            },
          ],
          currentProjectSnapshot: {
            projectId: "drama-project-1",
            projectKind: "script",
            title: "限定治愈：陆总的深夜私厨",
            currentObjective: "继续完善角色弧光、关系冲突与人物口吻。",
            derivedStage: "角色开发",
            agentSummary: "创作方案已完成，可继续开始角色开发。",
            recommendedActions: ["进入角色开发"],
            artifacts: [],
          },
        }),
      ),
    );

    await renderStudio();

    await waitForVisibleText("下一步：进入角色开发");
    const enterCharactersButton = screen.getByRole("button", { name: "进入角色开发" });
    expect(runWorkflowAction).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(enterCharactersButton);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(runWorkflowAction).toHaveBeenCalledWith(
        "generate_characters",
        expect.objectContaining({ projectId: "drama-project-1" }),
        expect.anything(),
      );
    });

    await waitFor(() => {
      expect(screen.queryByText("下一步：进入角色开发")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "进入角色开发" })).not.toBeInTheDocument();
    });

    resolveWorkflow?.({
      summary: "已生成主要角色设定。",
      projectSnapshot: {
        projectId: "drama-project-1",
        projectKind: "script",
        title: "限定治愈：陆总的深夜私厨",
        currentObjective: "生成分集目录，安排节奏、钩子和高潮。",
        derivedStage: "分集目录",
        agentSummary: "角色设定已完成，可继续推进分集目录。",
        recommendedActions: ["生成分集目录"],
        artifacts: [
          {
            id: "characters-1",
            kind: "characters",
            label: "角色设定",
            summary: "陆沉 / 苏晚的人设与关系张力已生成。",
            updatedAt: "2026-04-08T00:01:00.000Z",
          },
        ],
      },
      data: {
        projectSnapshot: {
          projectId: "drama-project-1",
          projectKind: "script",
          title: "限定治愈：陆总的深夜私厨",
          currentObjective: "生成分集目录，安排节奏、钩子和高潮。",
          derivedStage: "分集目录",
          agentSummary: "角色设定已完成，可继续推进分集目录。",
          recommendedActions: ["生成分集目录"],
          artifacts: [
            {
              id: "characters-1",
              kind: "characters",
              label: "角色设定",
              summary: "陆沉 / 苏晚的人设与关系张力已生成。",
              updatedAt: "2026-04-08T00:01:00.000Z",
            },
          ],
        },
      },
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "生成分集目录" })).toBeInTheDocument();
    });
  });

  it("ignores duplicate role-development clicks and advances to the directory step once", async () => {
    let resolveWorkflow:
      | ((value: {
          summary: string;
          projectSnapshot: StudioSessionState["currentProjectSnapshot"];
          data: { projectSnapshot: StudioSessionState["currentProjectSnapshot"] };
        }) => void)
      | null = null;

    runWorkflowAction.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveWorkflow = resolve;
        }),
    );

    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(
        createSession({
          qState: null,
          draft: "",
          selectedValues: [],
          messages: [
            {
              id: "assistant-role-step-repeat",
              role: "assistant",
              content: "创作方案已完成，可继续进入角色开发。",
              createdAt: "2026-04-08T00:00:00.000Z",
            },
          ],
          currentProjectSnapshot: {
            projectId: "drama-project-1",
            projectKind: "script",
            title: "限定治愈：陆总的深夜私厨",
            currentObjective: "继续完善角色弧光、关系冲突与人物口吻。",
            derivedStage: "角色开发",
            agentSummary: "创作方案已完成，可继续开始角色开发。",
            recommendedActions: ["进入角色开发"],
            artifacts: [],
          },
        }),
      ),
    );

    await renderStudio();

    await waitForVisibleText("下一步：进入角色开发");
    const enterCharactersButton = screen.getByRole("button", { name: "进入角色开发" });

    await act(async () => {
      fireEvent.click(enterCharactersButton);
      fireEvent.click(enterCharactersButton);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(runWorkflowAction).toHaveBeenCalledTimes(1);
      expect(runWorkflowAction).toHaveBeenCalledWith(
        "generate_characters",
        expect.objectContaining({ projectId: "drama-project-1" }),
        expect.anything(),
      );
    });

    resolveWorkflow?.({
      summary: "已更新项目《限定治愈：陆总的深夜私厨》。",
      projectSnapshot: {
        projectId: "drama-project-1",
        projectKind: "script",
        title: "限定治愈：陆总的深夜私厨",
        currentObjective: "生成分集目录，安排节奏、钩子和高潮。",
        derivedStage: "分集目录",
        agentSummary: "角色设定已完成，可继续推进分集目录。",
        recommendedActions: ["生成分集目录"],
        artifacts: [
          {
            id: "characters-1",
            kind: "characters",
            label: "角色设定",
            summary: "陆沉 / 苏晚的人设与关系张力已生成。",
            updatedAt: "2026-04-08T00:01:00.000Z",
          },
        ],
      },
      data: {
        projectSnapshot: {
          projectId: "drama-project-1",
          projectKind: "script",
          title: "限定治愈：陆总的深夜私厨",
          currentObjective: "生成分集目录，安排节奏、钩子和高潮。",
          derivedStage: "分集目录",
          agentSummary: "角色设定已完成，可继续推进分集目录。",
          recommendedActions: ["生成分集目录"],
          artifacts: [
            {
              id: "characters-1",
              kind: "characters",
              label: "角色设定",
              summary: "陆沉 / 苏晚的人设与关系张力已生成。",
              updatedAt: "2026-04-08T00:01:00.000Z",
            },
          ],
        },
      },
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "生成分集目录" })).toBeInTheDocument();
    });
  });

  it("uses project artifacts and stage analysis when opening history without a saved homepage session", async () => {
    seedDramaProject("drama-project-2");

    await renderStudio();

    const historySection = (await screen.findAllByText("对话历史"))[0]?.closest("section") ?? document.body;
    let historyButton: HTMLElement | null = null;
    await waitFor(
      () => {
        historyButton = within(historySection).getByRole("button", {
          name: /契约婚姻反转录/,
        });
      },
      { timeout: 3000 },
    );

    await act(async () => {
      fireEvent.click(historyButton!);
      await Promise.resolve();
    });

    await waitForVisibleText(/我已对照当前项目产物做了恢复分析/);
    expect(screen.getByText(/我已分析《契约婚姻反转录》的当前状态/)).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
  });

  it("restores the current homepage session on refresh and keeps it stable while opening settings", async () => {
    seedDramaProject();
    localStorage.setItem(STUDIO_SESSION_KEY, JSON.stringify(createSession()));

    await renderStudio();

    await waitForVisibleText("继续保留第 2 集的张力。");
    expect(screen.getByDisplayValue("补充反派动机")).toBeInTheDocument();
    expect(screen.getByText("继续选择题材")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /设置/ })[0]!);

    await waitFor(
      () => {
        expect(screen.getAllByText("settings-panel").length).toBeGreaterThan(0);
      },
      { timeout: 3000 },
    );
    expect(screen.getByDisplayValue("补充反派动机")).toBeInTheDocument();
    expect(screen.getByText("继续选择题材")).toBeInTheDocument();
  });

  it("shows review-focused recovery suggestions for video projects with pending review items", async () => {
    seedVideoProject();

    await renderStudio();

    const historySection = (await screen.findAllByText("对话历史"))[0]?.closest("section") ?? document.body;
    let historyButton: HTMLElement | null = null;
    await waitFor(
      () => {
        historyButton = within(historySection).getByRole("button", {
          name: /夜雨追击预告片/,
        });
      },
      { timeout: 3000 },
    );

    await act(async () => {
      fireEvent.click(historyButton!);
      await Promise.resolve();
    });

    await waitForVisibleText(/待审阅素材/);
    expect(screen.getByText("整理待审阅项")).toBeInTheDocument();
    expect(screen.getByText("通过稳定项")).toBeInTheDocument();
    expect(screen.getByText("逐条审阅")).toBeInTheDocument();
  });

  it("silently refreshes running video tasks after restoring a project on the homepage", async () => {
    seedGeneratingVideoProject("video-project-auto-refresh");

    runWorkflowAction.mockResolvedValueOnce({
      summary: "已刷新当前出片任务状态。",
      projectSnapshot: {
        projectId: "video-project-auto-refresh",
        projectKind: "video",
        title: "雨夜追击生成中",
        currentObjective: "继续轮询当前镜头出片结果。",
        derivedStage: "生成中",
        agentSummary: "仍有镜头在后台处理中。",
        recommendedActions: ["刷新全部进行中镜头"],
        artifacts: [],
      },
      data: {
        projectSnapshot: {
          projectId: "video-project-auto-refresh",
          projectKind: "video",
          title: "雨夜追击生成中",
          currentObjective: "继续轮询当前镜头出片结果。",
          derivedStage: "生成中",
          agentSummary: "仍有镜头在后台处理中。",
          recommendedActions: ["刷新全部进行中镜头"],
          artifacts: [],
        },
        videoProject: {
          ...JSON.parse(localStorage.getItem(VIDEO_PROJECTS_KEY) || "[]")[0],
          scenes: [
            {
              id: "scene-running-1",
              sceneNumber: 1,
              sceneName: "巷口冲刺",
              description: "女主冲进窄巷，雨水四溅。",
              characters: ["沈昭"],
              dialogue: "",
              cameraDirection: "跟拍推进",
              duration: 5,
              videoTaskId: "task-running-1",
              videoStatus: "completed",
              videoUrl: "https://example.com/video-running-1.mp4",
            },
            {
              id: "scene-running-2",
              sceneNumber: 2,
              sceneName: "回头确认",
              description: "她急停回头，确认追兵距离。",
              characters: ["沈昭"],
              dialogue: "",
              cameraDirection: "手持推近",
              duration: 5,
              videoTaskId: "task-running-2",
              videoStatus: "completed",
              videoUrl: "https://example.com/video-running-2.mp4",
            },
            {
              id: "scene-running-3",
              sceneNumber: 3,
              sceneName: "追兵逼近",
              description: "远景里追兵穿过雨幕。",
              characters: ["追兵"],
              dialogue: "",
              cameraDirection: "远景压缩",
              duration: 5,
              videoStatus: "completed",
              videoUrl: "https://example.com/video-running-3.mp4",
            },
          ],
        },
      },
    } as any);

    await renderStudio();

    const historySection = (await screen.findAllByText("对话历史"))[0]?.closest("section") ?? document.body;
    let historyButton: HTMLElement | null = null;
    await waitFor(() => {
      historyButton = within(historySection).getByRole("button", {
        name: /雨夜追击生成中/,
      });
    });

    await act(async () => {
      fireEvent.click(historyButton!);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(runWorkflowAction).toHaveBeenCalledWith(
        "refresh_video_assets",
        expect.objectContaining({
          projectId: "video-project-auto-refresh",
        }),
        expect.anything(),
      );
    });
  });

  it("auto-surfaces review guidance for the current homepage session when the restored project has pending review items", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify({
        mode: "active",
        messages: [
          {
            id: "assistant-review-1",
            role: "assistant",
            content: "我已经把镜头指令包整理好了。",
            createdAt: "2026-04-03T00:00:00.000Z",
          },
        ],
        currentProjectSnapshot: {
          projectId: "video-project-current",
          projectKind: "video",
          title: "雨夜追击预告片",
          currentObjective: "先审阅已有素材。",
          derivedStage: "审阅与修复",
          agentSummary: "当前有待审阅项。",
          recommendedActions: ["继续审阅"],
          artifacts: [],
          memory: {
            styleLock: null,
            worldModel: null,
            assetManifest: null,
            shotPackets: [],
            reviewQueue: [
              {
                id: "review:packet:video-project-current:scene-1",
                title: "审阅镜头 1 · 雨夜追击",
                summary: "镜头已有可审阅素材，确认是否通过或需要重做。",
                targetIds: ["packet:video-project-current:scene-1"],
                status: "pending",
                createdAt: "2026-04-03T00:00:00.000Z",
                updatedAt: "2026-04-03T00:00:00.000Z",
              },
            ],
          },
        },
        recentMessageSummary: "assistant: 我已经把镜头指令包整理好了。",
        projectId: "video-project-current",
        draft: "",
        qState: null,
        selectedValues: [],
      }),
    );

    await renderStudio();

    await waitForVisibleText(/待审阅素材/);
    expect(screen.getByText("整理待审阅项")).toBeInTheDocument();
    expect(screen.getByText("通过稳定项")).toBeInTheDocument();
  });

  it("maps review shortcut options to direct workflow actions on the homepage", async () => {
    seedVideoProject("video-project-direct");

    await renderStudio();

    const historySection = (await screen.findAllByText("对话历史"))[0]?.closest("section") ?? document.body;
    let historyButton: HTMLElement | null = null;
    await waitFor(
      () => {
        historyButton = within(historySection).getByRole("button", {
          name: /夜雨追击预告片/,
        });
      },
      { timeout: 3000 },
    );

    await act(async () => {
      fireEvent.click(historyButton!);
      await Promise.resolve();
    });

    await waitForVisibleText(/待审阅素材/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "通过稳定项" }));
      await Promise.resolve();
    });

    await waitFor(
      () => {
        expect(runWorkflowAction).toHaveBeenCalledWith(
          "approve_video_assets",
          expect.objectContaining({
            projectId: "video-project-direct",
            targetIds: ["packet:video-project-1:scene-1"],
          }),
          expect.anything(),
        );
      },
      { timeout: 3000 },
    );
    expect(screen.getByText("workflow:approve_video_assets")).toBeInTheDocument();
  });

  it("can run a one-click review cleanup chain from the homepage", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify({
        sessionId: "video-review-cleanup-session",
        compactedMessageCount: 0,
        mode: "active",
        messages: [
          {
            id: "assistant-video-review-cleanup-1",
            role: "assistant",
            content: "当前既有稳定项，也有需要退回重做的风险项。",
            createdAt: "2026-04-03T00:00:00.000Z",
          },
        ],
        currentProjectSnapshot: {
          projectId: "video-project-review-cleanup",
          projectKind: "video",
          title: "夜雨追击预告片",
          currentObjective: "先清理这一轮审阅结论。",
          derivedStage: "审阅与修复",
          agentSummary: "当前既有待通过的稳定项，也有待重做的风险项。",
          recommendedActions: ["继续审阅"],
          artifacts: [],
          memory: {
            styleLock: null,
            worldModel: null,
            assetManifest: null,
            shotPackets: [],
            reviewQueue: [
              {
                id: "review:packet:video-project-review-cleanup:scene-1",
                title: "审阅镜头 1 · 雨夜追击",
                summary: "镜头 1 已经稳定，可以直接通过。",
                targetIds: ["packet:video-project-review-cleanup:scene-1"],
                status: "pending",
                createdAt: "2026-04-03T00:00:00.000Z",
                updatedAt: "2026-04-03T00:00:00.000Z",
              },
              {
                id: "review:packet:video-project-review-cleanup:scene-2",
                title: "审阅镜头 2 · 巷口回头",
                summary: "镜头 2 的动作连贯性需要修复。",
                targetIds: ["packet:video-project-review-cleanup:scene-2"],
                status: "redo",
                reason: "动作连贯性不足，需要返工。",
                createdAt: "2026-04-03T00:00:00.000Z",
                updatedAt: "2026-04-03T00:00:00.000Z",
              },
            ],
          },
        },
        recentMessageSummary: "assistant: 当前既有稳定项，也有需要退回重做的风险项。",
        projectId: "video-project-review-cleanup",
        draft: "",
        qState: null,
        selectedValues: [],
      }),
    );

    await renderStudio();

    await waitForVisibleText(/待审阅素材/);
    expect(screen.getByRole("button", { name: "一键清理本轮审阅" })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "一键清理本轮审阅" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(runWorkflowAction).toHaveBeenNthCalledWith(
        1,
        "approve_video_assets",
        expect.objectContaining({
          projectId: "video-project-review-cleanup",
          targetIds: ["packet:video-project-review-cleanup:scene-1"],
        }),
        expect.anything(),
      );
      expect(runWorkflowAction).toHaveBeenNthCalledWith(
        2,
        "redo_video_assets",
        expect.objectContaining({
          projectId: "video-project-review-cleanup",
          targetIds: ["packet:video-project-review-cleanup:scene-2"],
        }),
        expect.anything(),
      );
      expect(runWorkflowAction).toHaveBeenNthCalledWith(
        3,
        "generate_video_assets",
        expect.objectContaining({
          projectId: "video-project-review-cleanup",
          targetIds: ["packet:video-project-review-cleanup:scene-2"],
          forceRegenerate: true,
        }),
        expect.anything(),
      );
    });
  });

  it("exposes auto-advance for video workflow stages on the homepage", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify({
        sessionId: "video-auto-advance-session",
        compactedMessageCount: 0,
        mode: "active",
        messages: [
          {
            id: "assistant-video-auto-advance-1",
            role: "assistant",
            content: "当前视频桥接可以让我直接判断下一步。",
            createdAt: "2026-04-03T00:00:00.000Z",
          },
        ],
        currentProjectSnapshot: {
          projectId: "video-auto-advance-project",
          projectKind: "video",
          title: "契约婚姻反转录",
          currentObjective: "导入脚本，开始第一轮视频拆解。",
          derivedStage: "脚本拆解",
          agentSummary: "当前适合先拆镜，再继续角色与场景整理。",
          recommendedActions: ["导入脚本开始拆解", "补充镜头风格偏好", "先完成第一轮镜头拆解"],
          artifacts: [],
        },
        recentMessageSummary: "assistant: 当前视频桥接可以让我直接判断下一步。",
        projectId: "video-auto-advance-project",
        draft: "",
        qState: null,
        selectedValues: [],
      }),
    );

    await renderStudio();

    await waitForVisibleText(/已经进入视频桥接阶段/);
    expect(screen.getByRole("button", { name: "让 Agent 自动推进下一步" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "让 Agent 连续推进一轮" })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "让 Agent 自动推进下一步" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(runWorkflowAction).toHaveBeenCalledWith(
        "advance_video_workflow",
        expect.objectContaining({
          projectId: "video-auto-advance-project",
        }),
        expect.anything(),
      );
    });
  });

  it("routes round-based auto-advance from the homepage into the dedicated workflow action", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify({
        sessionId: "video-auto-advance-round-session",
        compactedMessageCount: 0,
        mode: "active",
        messages: [
          {
            id: "assistant-video-auto-advance-round-1",
            role: "assistant",
            content: "当前视频桥接可以连续推进一轮。",
            createdAt: "2026-04-03T00:00:00.000Z",
          },
        ],
        currentProjectSnapshot: {
          projectId: "video-auto-advance-round-project",
          projectKind: "video",
          title: "契约婚姻反转录",
          currentObjective: "导入脚本，开始第一轮视频拆解。",
          derivedStage: "脚本拆解",
          agentSummary: "当前适合连续推进桥接链路。",
          recommendedActions: ["导入脚本开始拆解", "补充镜头风格偏好", "先完成第一轮镜头拆解"],
          artifacts: [],
        },
        recentMessageSummary: "assistant: 当前视频桥接可以连续推进一轮。",
        projectId: "video-auto-advance-round-project",
        draft: "",
        qState: null,
        selectedValues: [],
      }),
    );

    await renderStudio();

    await waitForVisibleText(/已经进入视频桥接阶段/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "让 Agent 连续推进一轮" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(runWorkflowAction).toHaveBeenCalledWith(
        "advance_video_workflow_round",
        expect.objectContaining({
          projectId: "video-auto-advance-round-project",
        }),
        expect.anything(),
      );
    });
  });

  it("auto-opens the next homepage popover after a round-based video advance completes", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify({
        sessionId: "video-auto-advance-round-followup-session",
        compactedMessageCount: 0,
        mode: "active",
        messages: [
          {
            id: "assistant-video-auto-advance-round-followup-1",
            role: "assistant",
            content: "当前视频桥接可以连续推进一轮。",
            createdAt: "2026-04-03T00:00:00.000Z",
          },
        ],
        currentProjectSnapshot: {
          projectId: "video-auto-advance-round-followup-project",
          projectKind: "video",
          title: "契约婚姻反转录",
          currentObjective: "导入脚本，开始第一轮视频拆解。",
          derivedStage: "脚本拆解",
          agentSummary: "当前适合连续推进桥接链路。",
          recommendedActions: ["导入脚本开始拆解", "补充镜头风格偏好", "先完成第一轮镜头拆解"],
          artifacts: [],
        },
        recentMessageSummary: "assistant: 当前视频桥接可以连续推进一轮。",
        projectId: "video-auto-advance-round-followup-project",
        draft: "",
        qState: null,
        selectedValues: [],
      }),
    );

    runWorkflowAction.mockImplementationOnce(async () => ({
      summary: "本轮连续推进了 5 步，并把项目推进到视频提示词阶段。",
      projectSnapshot: {
        projectId: "video-auto-advance-round-followup-project",
        projectKind: "video",
        title: "契约婚姻反转录",
        currentObjective: "把已整理好的提示词批次接入视频生成。",
        derivedStage: "视频提示词",
        agentSummary: "视频提示词已经就绪，适合直接开始第一轮出片。",
        recommendedActions: ["开始第一轮出片", "轮询当前出片结果", "整理待审阅项"],
        artifacts: [],
      },
      data: {
        videoProject: {
          id: "video-auto-advance-round-followup-project",
          title: "契约婚姻反转录",
          script: "第1集内容……",
          targetPlatform: "抖音",
          shotStyle: "电影感短剧",
          outputGoal: "预告片",
          productionNotes: "",
          scenes: [
            {
              id: "scene-ready-1",
              sceneNumber: 1,
              sceneName: "雨夜起跑",
              description: "女主冲出长街。",
              characters: ["沈昭"],
              dialogue: "",
              cameraDirection: "跟拍",
              duration: 5,
            },
            {
              id: "scene-ready-2",
              sceneNumber: 2,
              sceneName: "巷口回头",
              description: "她急停回头。",
              characters: ["沈昭"],
              dialogue: "",
              cameraDirection: "推近",
              duration: 5,
            },
          ],
          characters: [],
          sceneSettings: [],
          artStyle: "live-action",
          currentStep: 4,
          systemPrompt: "",
          analysisSummary: "视频提示词已经就绪。",
          storyboardPlan: "分镜批次已整理",
          videoPromptBatch: "批次 1：雨夜起跑；批次 2：巷口回头",
          sourceProjectId: "script-project-current",
          createdAt: "2026-04-03T00:00:00.000Z",
          updatedAt: "2026-04-03T01:00:00.000Z",
          styleLock: null,
          worldModel: null,
          assetManifest: null,
          shotPackets: [],
          reviewQueue: [],
        },
        projectSnapshot: {
          projectId: "video-auto-advance-round-followup-project",
          projectKind: "video",
          title: "契约婚姻反转录",
          currentObjective: "把已整理好的提示词批次接入视频生成。",
          derivedStage: "视频提示词",
          agentSummary: "视频提示词已经就绪，适合直接开始第一轮出片。",
          recommendedActions: ["开始第一轮出片", "轮询当前出片结果", "整理待审阅项"],
          artifacts: [],
        },
      },
    }));

    await renderStudio();

    await waitForVisibleText(/已经进入视频桥接阶段/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "让 Agent 连续推进一轮" }));
      await Promise.resolve();
    });

    await waitForVisibleText(/视频提示词已就绪，先怎么开始出片/);
    expect(screen.getByRole("button", { name: "先生成前 2 条镜头" })).toBeInTheDocument();
  });

  it("supports nested per-item review decisions without leaving the homepage", async () => {
    seedVideoProject("video-project-item");

    await renderStudio();

    const historySection = (await screen.findAllByText("对话历史"))[0]?.closest("section") ?? document.body;
    let historyButton: HTMLElement | null = null;
    await waitFor(
      () => {
        historyButton = within(historySection).getByRole("button", {
          name: /夜雨追击预告片/,
        });
      },
      { timeout: 3000 },
    );

    await act(async () => {
      fireEvent.click(historyButton!);
      await Promise.resolve();
    });

    await waitForVisibleText(/待审阅素材/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "逐条审阅" }));
      await Promise.resolve();
    });

    await waitForVisibleText(/先处理《夜雨追击预告片》里的哪条待审阅项/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "审阅镜头 1 · 雨夜追击" }));
      await Promise.resolve();
    });

    await waitForVisibleText(/这条素材怎么处理/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "通过这条素材" }));
      await Promise.resolve();
    });

    await waitFor(
      () => {
        expect(runWorkflowAction).toHaveBeenCalledWith(
          "approve_video_assets",
          expect.objectContaining({
            projectId: "video-project-item",
            targetIds: ["packet:video-project-1:scene-1"],
          }),
          expect.anything(),
        );
      },
      { timeout: 3000 },
    );
  });

  it("surfaces script compliance packet shortcuts and resolves them via workflow actions", async () => {
    localStorage.setItem(STUDIO_SESSION_KEY, JSON.stringify(createScriptMemorySession()));

    await renderStudio();

    await waitForVisibleText(/合规修订包待处理/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "先处理高风险项" }));
      await Promise.resolve();
    });

    await waitFor(
      () => {
        expect(runWorkflowAction).toHaveBeenCalledWith(
          "resolve_compliance_revisions",
          expect.objectContaining({
            projectId: "script-project-current",
            targetIds: ["script-project-current-compliance-1"],
          }),
          expect.anything(),
        );
      },
      { timeout: 3000 },
    );
  });

  it("keeps compliance follow-up focused on the current outline-stage card", async () => {
    localStorage.setItem(STUDIO_SESSION_KEY, JSON.stringify(createScriptMemorySession()));

    runWorkflowAction.mockImplementationOnce(async () => ({
      summary: "已处理 1 条高风险合规修订。",
      projectSnapshot: {
        projectId: "script-project-current",
        projectKind: "script",
        title: "契约婚姻反转录",
        currentObjective: "继续撰写第 1 集正文。",
        derivedStage: "单集细纲",
        agentSummary: "高风险修订已处理，当前继续推进第 1 集正文。",
        recommendedActions: ["继续生成第 1 集正文"],
        artifacts: [
          {
            id: "outline-1",
            kind: "outline",
            label: "第 1 集细纲",
            summary: "第 1 集细纲已完成",
            updatedAt: "2026-04-03T00:10:00.000Z",
          },
        ],
        memory: {
          styleLock: null,
          worldModel: null,
          assetManifest: null,
          shotPackets: [],
          reviewQueue: [],
          characterStateCards: [
            {
              id: "script-project-current-character-card-0",
              name: "沈昭",
              role: "女主",
              coreConflict: "在自保与信任之间摇摆。",
              desire: "查清旧案。",
              riskNote: "一旦失手会失去全部筹码。",
              relationshipAxis: ["顾承砚：先婚后爱"],
              stageFocus: "继续强化人物拉扯",
              status: "locked",
            },
          ],
          storyBeatPackets: [
            {
              id: "script-project-current-beat-1",
              episodeNumber: 1,
              title: "签下契约",
              beatSummary: "女主被迫签下婚姻契约。",
              hook: "契约签订",
              payoff: "男主暴露隐藏目的。",
              status: "drafted",
            },
          ],
          complianceRevisionPackets: [],
        },
      },
      data: {
        projectSnapshot: {
          projectId: "script-project-current",
          projectKind: "script",
          title: "契约婚姻反转录",
          currentObjective: "继续撰写第 1 集正文。",
          derivedStage: "单集细纲",
          agentSummary: "高风险修订已处理，当前继续推进第 1 集正文。",
          recommendedActions: ["继续生成第 1 集正文"],
          artifacts: [
            {
              id: "outline-1",
              kind: "outline",
              label: "第 1 集细纲",
              summary: "第 1 集细纲已完成",
              updatedAt: "2026-04-03T00:10:00.000Z",
            },
          ],
          memory: {
            styleLock: null,
            worldModel: null,
            assetManifest: null,
            shotPackets: [],
            reviewQueue: [],
            characterStateCards: [
              {
                id: "script-project-current-character-card-0",
                name: "沈昭",
                role: "女主",
                coreConflict: "在自保与信任之间摇摆。",
                desire: "查清旧案。",
                riskNote: "一旦失手会失去全部筹码。",
                relationshipAxis: ["顾承砚：先婚后爱"],
                stageFocus: "继续强化人物拉扯",
                status: "locked",
              },
            ],
            storyBeatPackets: [
              {
                id: "script-project-current-beat-1",
                episodeNumber: 1,
                title: "签下契约",
                beatSummary: "女主被迫签下婚姻契约。",
                hook: "契约签订",
                payoff: "男主暴露隐藏目的。",
                status: "drafted",
              },
            ],
            complianceRevisionPackets: [],
          },
        },
      },
    }));

    await renderStudio();

    await waitForVisibleText(/合规修订包待处理/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "先处理高风险项" }));
      await Promise.resolve();
    });

    await waitForVisibleText(/细纲已完成，开始撰写正文/);
    expect(screen.getByRole("button", { name: "继续生成第 1 集正文" })).toBeInTheDocument();
    expect(screen.queryByText(/剧情 beat 可以继续收口/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "锁定第 1 集 beat" })).not.toBeInTheDocument();
  });

  it("keeps the outline stage focused on the outline workflow card", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(
        createScriptMemorySession({
          currentProjectSnapshot: {
            ...createScriptMemorySession().currentProjectSnapshot!,
            derivedStage: "单集细纲",
            currentObjective: "继续撰写第 1 集正文。",
            recommendedActions: ["继续生成第 1 集正文"],
            artifacts: [
              {
                id: "outline-1",
                kind: "outline",
                label: "第 1 集细纲",
                summary: "第 1 集细纲已完成",
                updatedAt: "2026-04-03T00:10:00.000Z",
              },
            ],
            memory: {
              ...createScriptMemorySession().currentProjectSnapshot!.memory!,
              complianceRevisionPackets: [],
            },
          },
        }),
      ),
    );

    await renderStudio();

    await waitForVisibleText(/细纲已完成，开始撰写正文/);
    expect(screen.getByRole("button", { name: "继续生成第 1 集正文" })).toBeInTheDocument();
    expect(screen.queryByText(/剧情 beat 可以继续收口/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "逐条检查剧情 beat" })).not.toBeInTheDocument();
  });

  it("keeps the character stage focused on the character workflow card", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(
        createScriptMemorySession({
          currentProjectSnapshot: {
            ...createScriptMemorySession().currentProjectSnapshot!,
            derivedStage: "角色设定",
            currentObjective: "生成分集目录，安排节奏、钩子和高潮。",
            recommendedActions: ["生成分集目录"],
            artifacts: [
              {
                id: "characters-1",
                kind: "characters",
                label: "角色设定",
                summary: "主角设定已完成",
                updatedAt: "2026-04-03T00:10:00.000Z",
              },
            ],
            memory: {
              ...createScriptMemorySession().currentProjectSnapshot!.memory!,
              complianceRevisionPackets: [],
              storyBeatPackets: [],
              characterStateCards: [
                {
                  id: "script-project-current-character-card-0",
                  name: "沈昭",
                  role: "女主",
                  coreConflict: "在自保与信任之间摇摆。",
                  desire: "查清旧案。",
                  riskNote: "一旦失手会失去全部筹码。",
                  relationshipAxis: ["顾承砚：先婚后爱"],
                  stageFocus: "继续强化人物拉扯",
                  status: "pending",
                },
              ],
            },
          },
        }),
      ),
    );

    await renderStudio();

    await waitForVisibleText(/角色设定已完成，下一步生成分集目录/);
    expect(screen.getByRole("button", { name: "生成分集目录" })).toBeInTheDocument();
    expect(screen.queryByText(/角色状态卡待收口/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "锁定 沈昭" })).not.toBeInTheDocument();
  });

  it("does not auto-surface beat follow-up after leaving the character stage", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(
        createScriptMemorySession({
          currentProjectSnapshot: {
            ...createScriptMemorySession().currentProjectSnapshot!,
            derivedStage: "单集细纲",
            currentObjective: "继续撰写第 1 集正文。",
            recommendedActions: ["继续生成第 1 集正文"],
            artifacts: [
              {
                id: "outline-1",
                kind: "outline",
                label: "第 1 集细纲",
                summary: "第 1 集细纲已完成",
                updatedAt: "2026-04-03T00:10:00.000Z",
              },
            ],
            memory: {
              ...createScriptMemorySession().currentProjectSnapshot!.memory!,
              complianceRevisionPackets: [],
              characterStateCards: [
                {
                  id: "script-project-current-character-card-0",
                  name: "沈昭",
                  role: "女主",
                  coreConflict: "在自保与信任之间摇摆。",
                  desire: "查清旧案。",
                  riskNote: "一旦失手会失去全部筹码。",
                  relationshipAxis: ["顾承砚：先婚后爱"],
                  stageFocus: "继续强化人物拉扯",
                  status: "pending",
                },
              ],
              storyBeatPackets: [
                {
                  id: "script-project-current-beat-1",
                  episodeNumber: 1,
                  title: "签下契约",
                  beatSummary: "女主被迫签下婚姻契约。",
                  hook: "契约签订",
                  payoff: "男主暴露隐藏目的。",
                  status: "drafted",
                },
              ],
            },
          },
        }),
      ),
    );

    await renderStudio();

    await waitForVisibleText(/细纲已完成，开始撰写正文/);
    expect(screen.getByRole("button", { name: "继续生成第 1 集正文" })).toBeInTheDocument();
    expect(screen.queryByText(/剧情 beat 可以继续收口/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "锁定第 1 集 beat" })).not.toBeInTheDocument();
  });

  it("surfaces dedicated episode-stage shortcuts and continues generating the next episode from the homepage", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(
        createScriptMemorySession({
          currentProjectSnapshot: {
            ...createScriptMemorySession().currentProjectSnapshot!,
            currentObjective: "继续撰写分集正文，推进可导出的剧本稿。",
            derivedStage: "剧本撰写",
            agentSummary: "细纲已经收口，当前可以直接推进下一集正文。",
            recommendedActions: ["继续生成第 2 集", "批量质量审查", "准备合规审查"],
            memory: {
              ...createScriptMemorySession().currentProjectSnapshot!.memory!,
              complianceRevisionPackets: [],
              storyBeatPackets: [],
            },
          },
        }),
      ),
    );

    await renderStudio();

    await waitForVisibleText(/已经进入正文推进阶段/);
    expect(screen.getByRole("button", { name: "继续生成第 2 集" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "批量质量审查" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "准备合规审查" })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "继续生成第 2 集" }));
      await Promise.resolve();
    });

    await waitFor(
      () => {
        expect(runWorkflowAction).toHaveBeenCalledWith(
          "generate_episode",
          expect.objectContaining({
            projectId: "script-project-current",
            episodeNumber: 2,
          }),
          expect.anything(),
        );
      },
      { timeout: 3000 },
    );
  });

  it("auto-surfaces export follow-up choices after an episode finishes on the homepage", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(
        createScriptMemorySession({
          currentProjectSnapshot: {
            ...createScriptMemorySession().currentProjectSnapshot!,
            currentObjective: "继续撰写分集正文，推进可导出的剧本稿。",
            derivedStage: "剧本撰写",
            agentSummary: "细纲已经收口，当前可以直接推进下一集正文。",
            recommendedActions: ["继续生成第 2 集", "批量质量审查", "准备合规审查"],
            memory: {
              ...createScriptMemorySession().currentProjectSnapshot!.memory!,
              complianceRevisionPackets: [],
              storyBeatPackets: [],
            },
          },
        }),
      ),
    );

    runWorkflowAction.mockImplementationOnce(async () => ({
      summary: "已生成第 2 集正文，并整理到导出阶段。",
      projectSnapshot: {
        projectId: "script-project-current",
        projectKind: "script",
        title: "契约婚姻反转录",
        currentObjective: "整理导出文档，并衔接后续视频工作流。",
        derivedStage: "导出与出片",
        agentSummary: "正文主链路已完成，可以继续整理导出稿或接入视频工作流。",
        recommendedActions: ["导出整合文档", "接入视频工作流", "回头补写缺失章节或集数"],
        artifacts: [],
        memory: {
          styleLock: null,
          worldModel: null,
          assetManifest: null,
          shotPackets: [],
          reviewQueue: [],
          characterStateCards: createScriptMemorySession().currentProjectSnapshot!.memory!.characterStateCards,
          storyBeatPackets: [],
          complianceRevisionPackets: [],
        },
      },
      data: {
        projectSnapshot: {
          projectId: "script-project-current",
          projectKind: "script",
          title: "契约婚姻反转录",
          currentObjective: "整理导出文档，并衔接后续视频工作流。",
          derivedStage: "导出与出片",
          agentSummary: "正文主链路已完成，可以继续整理导出稿或接入视频工作流。",
          recommendedActions: ["导出整合文档", "接入视频工作流", "回头补写缺失章节或集数"],
          artifacts: [],
          memory: {
            styleLock: null,
            worldModel: null,
            assetManifest: null,
            shotPackets: [],
            reviewQueue: [],
            characterStateCards: createScriptMemorySession().currentProjectSnapshot!.memory!.characterStateCards,
            storyBeatPackets: [],
            complianceRevisionPackets: [],
          },
        },
      },
    }));

    await renderStudio();

    await waitForVisibleText(/已经进入正文推进阶段/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "继续生成第 2 集" }));
      await Promise.resolve();
    });

    await waitForVisibleText(/已经进入导出与出片阶段/);
    expect(screen.getByRole("button", { name: "导出整合文档" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "接入视频工作流" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "回头补写缺失章节或集数" })).toBeInTheDocument();
  });

  it("routes export-stage shortcuts into the homepage video bridge workflow", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(
        createScriptMemorySession({
          currentProjectSnapshot: {
            ...createScriptMemorySession().currentProjectSnapshot!,
            currentObjective: "整理导出文档，并衔接后续视频工作流。",
            derivedStage: "导出与出片",
            agentSummary: "正文主链路已完成，可以继续整理导出稿或接入视频工作流。",
            recommendedActions: ["导出整合文档", "接入视频工作流", "回头补写缺失章节或集数"],
            memory: {
              ...createScriptMemorySession().currentProjectSnapshot!.memory!,
              complianceRevisionPackets: [],
              storyBeatPackets: [],
            },
          },
        }),
      ),
    );

    runWorkflowAction.mockImplementationOnce(async () => ({
      summary: "已接管视频项目《契约婚姻反转录》，准备开始镜头拆解。",
      projectSnapshot: {
        projectId: "video-bridge-from-script",
        projectKind: "video",
        title: "契约婚姻反转录",
        currentObjective: "导入脚本，开始第一轮视频拆解。",
        derivedStage: "脚本拆解",
        agentSummary: "视频桥接已建立，当前适合先拆镜再继续角色与场景整理。",
        recommendedActions: ["导入脚本开始拆解", "补充镜头风格偏好", "先完成第一轮镜头拆解"],
        artifacts: [],
      },
      data: {
        videoProject: {
          id: "video-bridge-from-script",
          title: "契约婚姻反转录",
          script: "第1集内容……",
          targetPlatform: "抖音",
          shotStyle: "电影感短剧",
          outputGoal: "预告片",
          productionNotes: "",
          scenes: [],
          characters: [],
          sceneSettings: [],
          artStyle: "live-action",
          currentStep: 1,
          systemPrompt: "",
          analysisSummary: "视频桥接已建立。",
          storyboardPlan: "",
          videoPromptBatch: "",
          sourceProjectId: "script-project-current",
          createdAt: "2026-04-03T00:00:00.000Z",
          updatedAt: "2026-04-03T00:30:00.000Z",
          styleLock: null,
          worldModel: null,
          assetManifest: null,
          shotPackets: [],
          reviewQueue: [],
        },
        projectSnapshot: {
          projectId: "video-bridge-from-script",
          projectKind: "video",
          title: "契约婚姻反转录",
          currentObjective: "导入脚本，开始第一轮视频拆解。",
          derivedStage: "脚本拆解",
          agentSummary: "视频桥接已建立，当前适合先拆镜再继续角色与场景整理。",
          recommendedActions: ["导入脚本开始拆解", "补充镜头风格偏好", "先完成第一轮镜头拆解"],
          artifacts: [],
        },
      },
    }));

    await renderStudio();

    await waitForVisibleText(/已经进入导出与出片阶段/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "接入视频工作流" }));
      await Promise.resolve();
    });

    await waitFor(
      () => {
        expect(runWorkflowAction).toHaveBeenCalledWith(
          "prepare_video_generation",
          expect.objectContaining({
            projectId: "script-project-current",
          }),
          expect.anything(),
        );
      },
      { timeout: 3000 },
    );

    await waitForVisibleText(/已经进入视频桥接阶段/);
    expect(screen.getByRole("button", { name: "先完成第一轮镜头拆解" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续提取角色与场景" })).toBeInTheDocument();
  });

  it("uses the homepage agent to inspect missing chapters when export backfill is selected", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify(
        createScriptMemorySession({
          currentProjectSnapshot: {
            ...createScriptMemorySession().currentProjectSnapshot!,
            currentObjective: "整理导出文档，并衔接后续视频工作流。",
            derivedStage: "导出与出片",
            agentSummary: "正文主链路已完成，可以继续整理导出稿或接入视频工作流。",
            recommendedActions: ["导出整合文档", "接入视频工作流", "回头补写缺失章节或集数"],
            memory: {
              ...createScriptMemorySession().currentProjectSnapshot!.memory!,
              complianceRevisionPackets: [],
              storyBeatPackets: [],
            },
          },
        }),
      ),
    );

    await renderStudio();

    await waitForVisibleText(/已经进入导出与出片阶段/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "回头补写缺失章节或集数" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(lastSubmittedPrompt).toContain("缺失章节或集数");
    });
  });

  it("surfaces dedicated video bridge shortcuts for early video stages and routes them into workflow actions", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify({
        sessionId: "video-bridge-session",
        compactedMessageCount: 0,
        mode: "active",
        messages: [
          {
            id: "assistant-video-bridge-1",
            role: "assistant",
            content: "我已经接管了当前视频桥接上下文。",
            createdAt: "2026-04-03T00:00:00.000Z",
          },
        ],
        currentProjectSnapshot: {
          projectId: "video-bridge-project",
          projectKind: "video",
          title: "契约婚姻反转录",
          currentObjective: "导入脚本，开始第一轮视频拆解。",
          derivedStage: "脚本拆解",
          agentSummary: "当前适合先拆镜，再继续角色与场景整理。",
          recommendedActions: ["导入脚本开始拆解", "补充镜头风格偏好", "先完成第一轮镜头拆解"],
          artifacts: [],
        },
        recentMessageSummary: "assistant: 我已经接管了当前视频桥接上下文。",
        projectId: "video-bridge-project",
        draft: "",
        qState: null,
        selectedValues: [],
      }),
    );

    await renderStudio();

    await waitForVisibleText(/已经进入视频桥接阶段/);
    expect(screen.getByRole("button", { name: "先完成第一轮镜头拆解" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续提取角色与场景" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "补充平台和镜头偏好" })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "先完成第一轮镜头拆解" }));
      await Promise.resolve();
    });

    await waitFor(
      () => {
        expect(runWorkflowAction).toHaveBeenCalledWith(
          "analyze_script_for_video",
          expect.objectContaining({
            projectId: "video-bridge-project",
          }),
          expect.anything(),
        );
      },
      { timeout: 3000 },
    );
  });

  it("auto-surfaces the next bridge-stage popover after video script analysis completes", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify({
        sessionId: "video-bridge-analysis-session",
        compactedMessageCount: 0,
        mode: "active",
        messages: [
          {
            id: "assistant-video-bridge-analysis-1",
            role: "assistant",
            content: "当前视频桥接可以先拆镜。",
            createdAt: "2026-04-03T00:00:00.000Z",
          },
        ],
        currentProjectSnapshot: {
          projectId: "video-bridge-analysis-project",
          projectKind: "video",
          title: "契约婚姻反转录",
          currentObjective: "导入脚本，开始第一轮视频拆解。",
          derivedStage: "脚本拆解",
          agentSummary: "当前适合先拆镜，再继续角色与场景整理。",
          recommendedActions: ["导入脚本开始拆解", "补充镜头风格偏好", "先完成第一轮镜头拆解"],
          artifacts: [],
        },
        recentMessageSummary: "assistant: 当前视频桥接可以先拆镜。",
        projectId: "video-bridge-analysis-project",
        draft: "",
        qState: null,
        selectedValues: [],
      }),
    );

    runWorkflowAction.mockImplementationOnce(async () => ({
      summary: "已完成视频脚本拆解，共整理 4 个镜头。",
      projectSnapshot: {
        projectId: "video-bridge-analysis-project",
        projectKind: "video",
        title: "契约婚姻反转录",
        currentObjective: "完善角色与场景资产，为分镜生成做准备。",
        derivedStage: "角色与场景",
        agentSummary: "已拆出基础镜头，当前适合继续整理角色、场景并准备分镜。",
        recommendedActions: ["完善角色和场景资产", "开始整理分镜批次", "补充额外镜头要求"],
        artifacts: [],
      },
      data: {
        videoProject: {
          id: "video-bridge-analysis-project",
          title: "契约婚姻反转录",
          script: "第1集内容……",
          targetPlatform: "抖音",
          shotStyle: "电影感短剧",
          outputGoal: "预告片",
          productionNotes: "",
          scenes: [
            {
              id: "scene-analysis-1",
              sceneNumber: 1,
              sceneName: "雨夜起跑",
              description: "女主冲出长街。",
              characters: ["沈昭"],
              dialogue: "",
              cameraDirection: "跟拍",
              duration: 5,
            },
            {
              id: "scene-analysis-2",
              sceneNumber: 2,
              sceneName: "巷口回头",
              description: "她急停回头。",
              characters: ["沈昭"],
              dialogue: "",
              cameraDirection: "推近",
              duration: 5,
            },
          ],
          characters: [],
          sceneSettings: [],
          artStyle: "live-action",
          currentStep: 2,
          systemPrompt: "",
          analysisSummary: "已完成镜头拆解。",
          storyboardPlan: "",
          videoPromptBatch: "",
          sourceProjectId: "script-project-current",
          createdAt: "2026-04-03T00:00:00.000Z",
          updatedAt: "2026-04-03T00:40:00.000Z",
          styleLock: null,
          worldModel: null,
          assetManifest: null,
          shotPackets: [],
          reviewQueue: [],
        },
        projectSnapshot: {
          projectId: "video-bridge-analysis-project",
          projectKind: "video",
          title: "契约婚姻反转录",
          currentObjective: "完善角色与场景资产，为分镜生成做准备。",
          derivedStage: "角色与场景",
          agentSummary: "已拆出基础镜头，当前适合继续整理角色、场景并准备分镜。",
          recommendedActions: ["完善角色和场景资产", "开始整理分镜批次", "补充额外镜头要求"],
          artifacts: [],
        },
      },
    }));

    await renderStudio();

    await waitForVisibleText(/已经进入视频桥接阶段/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "先完成第一轮镜头拆解" }));
      await Promise.resolve();
    });

    await waitForVisibleText(/角色与场景资产可以继续收口/);
    expect(screen.getByRole("button", { name: "先整理角色和场景资产" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始整理分镜批次" })).toBeInTheDocument();
  });

  it("auto-surfaces prompt-batch choices after shot packets are compiled", async () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify({
        sessionId: "video-bridge-shot-session",
        compactedMessageCount: 0,
        mode: "active",
        messages: [
          {
            id: "assistant-video-bridge-shot-1",
            role: "assistant",
            content: "当前可以继续编译镜头指令包。",
            createdAt: "2026-04-03T00:00:00.000Z",
          },
        ],
        currentProjectSnapshot: {
          projectId: "video-bridge-shot-project",
          projectKind: "video",
          title: "契约婚姻反转录",
          currentObjective: "继续补齐分镜批次，并校准镜头连贯性。",
          derivedStage: "分镜批次",
          agentSummary: "分镜已经起量，当前适合继续推进 shot packet。",
          recommendedActions: ["继续补齐剩余分镜批次", "编译镜头指令包", "整理镜头说明"],
          artifacts: [],
        },
        recentMessageSummary: "assistant: 当前可以继续编译镜头指令包。",
        projectId: "video-bridge-shot-project",
        draft: "",
        qState: null,
        selectedValues: [],
      }),
    );

    runWorkflowAction.mockImplementationOnce(async () => ({
      summary: "已编译 3 个镜头指令包。",
      projectSnapshot: {
        projectId: "video-bridge-shot-project",
        projectKind: "video",
        title: "契约婚姻反转录",
        currentObjective: "继续复核镜头指令包，并衔接提示词与生成。",
        derivedStage: "镜头指令包",
        agentSummary: "shot packet 已整理完成，当前可以直接推进到提示词批次。",
        recommendedActions: ["复核 1 个镜头指令包", "准备视频提示词批次", "开始第一轮审阅准备"],
        artifacts: [],
      },
      data: {
        videoProject: {
          id: "video-bridge-shot-project",
          title: "契约婚姻反转录",
          script: "第1集内容……",
          targetPlatform: "抖音",
          shotStyle: "电影感短剧",
          outputGoal: "预告片",
          productionNotes: "",
          scenes: [
            {
              id: "scene-shot-1",
              sceneNumber: 1,
              sceneName: "雨夜起跑",
              description: "女主冲出长街。",
              characters: ["沈昭"],
              dialogue: "",
              cameraDirection: "跟拍",
              duration: 5,
              storyboardUrl: "https://example.com/storyboard-shot-1.jpg",
            },
          ],
          characters: [],
          sceneSettings: [],
          artStyle: "live-action",
          currentStep: 4,
          systemPrompt: "",
          analysisSummary: "镜头指令包已编译。",
          storyboardPlan: "分镜批次已整理",
          videoPromptBatch: "",
          sourceProjectId: "script-project-current",
          createdAt: "2026-04-03T00:00:00.000Z",
          updatedAt: "2026-04-03T00:50:00.000Z",
          styleLock: null,
          worldModel: null,
          assetManifest: null,
          shotPackets: [
            {
              id: "packet:video-bridge-shot-project:scene-shot-1",
              sceneId: "scene-shot-1",
              sceneNumber: 1,
              title: "雨夜起跑",
              durationSec: 5,
              camera: {
                shotSize: "中景",
                movement: "跟拍",
              },
              characterRefs: [],
              sourceAssetIds: [],
              promptSeed: "女主冲出长街。",
              forbiddenChanges: ["保持角色识别特征"],
              renderMode: "img2video",
              reviewStatus: "pending",
            },
          ],
          reviewQueue: [],
        },
        projectSnapshot: {
          projectId: "video-bridge-shot-project",
          projectKind: "video",
          title: "契约婚姻反转录",
          currentObjective: "继续复核镜头指令包，并衔接提示词与生成。",
          derivedStage: "镜头指令包",
          agentSummary: "shot packet 已整理完成，当前可以直接推进到提示词批次。",
          recommendedActions: ["复核 1 个镜头指令包", "准备视频提示词批次", "开始第一轮审阅准备"],
          artifacts: [],
        },
      },
    }));

    await renderStudio();

    await waitForVisibleText(/分镜批次可以继续推进/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "编译镜头指令包" }));
      await Promise.resolve();
    });

    await waitForVisibleText(/镜头指令包已经可用/);
    expect(screen.getByRole("button", { name: "复核 1 个镜头指令包" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "准备视频提示词批次" })).toBeInTheDocument();
  });

  it("shows ComposerChoiceModal when LLM response contains AskUserQuestion in text (LLM mode text parsing path)", async () => {
    assistantReply = `先确认方向。

\`\`\`json
AskUserQuestion({
  "title": "创作方向",
  "questions": [
    {
      "header": "平台",
      "question": "你想先发到哪里？",
      "multiSelect": false,
      "options": [
        { "label": "抖音" },
        { "label": "小红书" }
      ]
    }
  ]
})
\`\`\`
`;

    await renderStudio();

    await fillComposer("我想做一个新项目");
    await waitFor(() => {
      expect(findSendButton()).not.toBeDisabled();
    });

    await act(async () => {
      fireEvent.click(findSendButton()!);
      await Promise.resolve();
    });

    await waitFor(
      () => {
        expect(screen.getByText("你想先发到哪里？")).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
    expect(screen.getByRole("button", { name: "抖音" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "小红书" })).toBeInTheDocument();
  });

  it("shows ComposerChoiceModal and resolves tool call when agent:ask-user-question event fires in LLM mode", async () => {
    await renderStudio();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("agent:ask-user-question", {
          detail: createQuestionRequest({
            id: "llm-ask-single",
            title: "下一步方向",
            questions: [
              {
                header: "方向",
                question: "接下来想做什么？",
                multiSelect: false,
                options: [
                  { label: "原创剧本" },
                  { label: "改编剧本" },
                ],
              },
            ],
          }),
        }),
      );
    });

    await screen.findByText("接下来想做什么？");
    expect(screen.getByRole("button", { name: "原创剧本" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "改编剧本" })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "原创剧本" }));
      await Promise.resolve();
    });

    await waitFor(
      () => {
        expect(resolveAskUserQuestion).toHaveBeenCalledWith("llm-ask-single", "原创剧本");
      },
      { timeout: 3000 },
    );
  });
});

