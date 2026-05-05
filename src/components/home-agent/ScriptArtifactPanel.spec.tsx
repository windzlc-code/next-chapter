import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConversationArtifact, ConversationProjectSnapshot } from "@/lib/home-agent/types";
import { createEmptyComplianceWorkspace } from "@/types/drama";
import { ScriptArtifactPanel } from "./ScriptArtifactPanel";

const {
  callGeminiStreamMock,
  exportToDocxMock,
  mermaidRenderMock,
  mermaidInitializeMock,
} = vi.hoisted(() => ({
  callGeminiStreamMock: vi.fn(),
  exportToDocxMock: vi.fn(),
  mermaidRenderMock: vi.fn(),
  mermaidInitializeMock: vi.fn(),
}));

vi.mock("@/lib/gemini-client", () => ({
  callGeminiStream: callGeminiStreamMock,
}));

vi.mock("@/lib/export-docx", () => ({
  exportToDocx: exportToDocxMock,
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: mermaidInitializeMock,
    render: mermaidRenderMock,
  },
}));

function createSnapshot(artifacts: ConversationArtifact[]): ConversationProjectSnapshot {
  return {
    projectId: "script-project-1",
    projectKind: "script",
    title: "Artifact Test",
    currentObjective: "Continue",
    derivedStage: "Episodes",
    agentSummary: "Rich cards ready",
    recommendedActions: [],
    artifacts,
  };
}

function expandAllArtifacts() {
  screen.getAllByRole("button", { name: "展开" }).forEach((button) => {
    fireEvent.click(button);
  });
}

describe("ScriptArtifactPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mermaidRenderMock.mockResolvedValue({ svg: "<svg><text>diagram</text></svg>" });
  });

  it("renders rich workflow cards and keeps artifact actions routed through shared action entries", async () => {
    const onArtifactAction = vi.fn();

    render(
      <ScriptArtifactPanel
        snapshot={createSnapshot([
          {
            id: "setup",
            kind: "setup",
            label: "Setup Card",
            summary: "Project setup summary",
            updatedAt: "2026-04-02T00:00:00.000Z",
            presentation: "script-rich",
            payload: {
              type: "setup",
              mode: "traditional",
              marketLabel: "China",
              audience: "Female",
              tone: "Sweet",
              ending: "HE",
              totalEpisodes: 24,
              genres: ["Romance"],
            },
            actions: [
              {
                id: "setup-action",
                label: "Continue setup",
                value: "generate_creative_plan",
                variant: "primary",
              },
            ],
          },
          {
            id: "characters",
            kind: "characters",
            label: "Characters",
            summary: "Character summary",
            updatedAt: "2026-04-02T00:00:00.000Z",
            presentation: "script-rich",
            payload: {
              type: "characters+mermaid",
              body: "Lead A\nLead B",
              mermaidCode: "graph TD\nA[Lead A] --> B[Lead B]",
              characterCards: [],
            },
          },
          {
            id: "outline",
            kind: "outline",
            label: "Outlines",
            summary: "Outline progress",
            updatedAt: "2026-04-02T00:00:00.000Z",
            presentation: "script-rich",
            payload: {
              type: "outlines+batchProgress",
              totalEpisodes: 24,
              entries: [
                {
                  number: 1,
                  title: "Episode 1",
                  summary: "Summary",
                  outline: "Outline body",
                  hookType: "reversal",
                  isKey: false,
                  isClimax: true,
                  isPaywall: false,
                  emotionLevel: 4,
                },
              ],
              batchProgress: {
                total: 2,
                done: 1,
                failed: 0,
                processing: 0,
                percent: 50,
                batches: [
                  { index: 0, label: "1-12", startEp: 1, endEp: 12, status: "done" },
                  { index: 1, label: "13-24", startEp: 13, endEp: 24, status: "pending" },
                ],
              },
            },
          },
          {
            id: "compliance",
            kind: "compliance",
            label: "Compliance",
            summary: "Compliance summary",
            updatedAt: "2026-04-02T00:00:00.000Z",
            presentation: "script-rich",
            payload: {
              type: "complianceSummary",
              mode: "script",
              strictness: "standard",
              report: "warning",
              packets: [],
              workspace: createEmptyComplianceWorkspace(),
              counts: { redLine: 1, highRisk: 0, suggestion: 0, pendingPackets: 0 },
            },
          },
          {
            id: "export",
            kind: "export",
            label: "Export",
            summary: "Export summary",
            updatedAt: "2026-04-02T00:00:00.000Z",
            presentation: "script-rich",
            actions: [
              {
                id: "video-bridge",
                label: "Video bridge",
                value: "script:export-video",
                variant: "secondary",
              },
            ],
            payload: {
              type: "exportSummary",
              dramaTitle: "Export Test",
              completedEpisodes: 1,
              totalEpisodes: 24,
              totalWordCount: 1200,
              complianceStatus: "pending",
              skippedAt: null,
              quickExportMarkdown: "# Export Test",
              creativePlan: "Creative plan",
              characters: "Character sheet",
              episodes: [{ number: 1, title: "Episode 1", content: "Episode body", wordCount: 1200 }],
              patchPlan: {
                generatedAt: "2026-04-02T00:00:00.000Z",
                signature: "export-signature",
                readyForExport: false,
                summary: "There are still missing pieces before export.",
                counts: { high: 1, medium: 0, low: 1 },
                recommendedAction: {
                  label: "Generate export",
                  value: "script:export-document",
                },
                entries: [
                  {
                    id: "missing-episode",
                    kind: "missing-episode",
                    title: "Missing episode 2",
                    priority: "high",
                    summary: "Episode 2 still needs a full body draft.",
                    episodeNumbers: [2],
                    action: {
                      label: "Write episode 2",
                      value: "script:episode-generate:2",
                    },
                  },
                ],
              },
              setup: {
                genres: ["Romance"],
                audience: "Female",
                tone: "Sweet",
                ending: "HE",
                totalEpisodes: 24,
                targetMarket: "cn",
              },
            },
          },
        ])}
        onArtifactAction={onArtifactAction}
      />,
    );

    expandAllArtifacts();

    expect(screen.getByText("Setup Card")).toBeInTheDocument();
    expect(screen.getByText("China")).toBeInTheDocument();
    expect(screen.getByText("Compliance")).toBeInTheDocument();
    expect(screen.getByText("Export")).toBeInTheDocument();
    expect(screen.getByText("Missing episode 2")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Write episode 2" })).not.toBeInTheDocument();

    await waitFor(() => expect(mermaidRenderMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Continue setup" }));
    fireEvent.click(screen.getByRole("button", { name: "Video bridge" }));

    expect(onArtifactAction).toHaveBeenNthCalledWith(1, "generate_creative_plan", "Continue setup");
    expect(onArtifactAction).toHaveBeenNthCalledWith(2, "script:export-video", "Video bridge");
    expect(onArtifactAction).toHaveBeenCalledTimes(2);
  });

  it("shows inline edit controls and toggles the relationship diagram state", async () => {
    const onSaveArtifactText = vi.fn().mockResolvedValue(undefined);
    const onRelationshipDiagramCollapsedChange = vi.fn().mockResolvedValue(undefined);

    render(
      <ScriptArtifactPanel
        snapshot={createSnapshot([
          {
            id: "plan",
            kind: "plan",
            label: "Creative Plan",
            summary: "Plan summary",
            content: "Original plan body",
            updatedAt: "2026-04-02T00:00:00.000Z",
            editor: {
              field: "creativePlan",
              text: "Original plan body",
            },
          },
          {
            id: "characters",
            kind: "characters",
            label: "Characters",
            summary: "Character summary",
            updatedAt: "2026-04-02T00:00:00.000Z",
            presentation: "script-rich",
            payload: {
              type: "characters+mermaid",
              body: "Lead A\nLead B",
              mermaidCode: "graph TD\nA[Lead A] --> B[Lead B]",
              characterCards: [],
            },
            editor: {
              field: "characters",
              text: "Lead A\nLead B\n\n```mermaid\ngraph TD\nA[Lead A] --> B[Lead B]\n```",
            },
          },
        ])}
        onSaveArtifactText={onSaveArtifactText}
        onRelationshipDiagramCollapsedChange={onRelationshipDiagramCollapsedChange}
      />,
    );

    expandAllArtifacts();
    await waitFor(() => expect(mermaidRenderMock).toHaveBeenCalled());

    fireEvent.click(screen.getAllByRole("button", { name: "编辑文本" })[0]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Updated plan body" } });
    fireEvent.click(screen.getByRole("button", { name: "保存文本" }));

    await waitFor(() => {
      expect(onSaveArtifactText).toHaveBeenCalledWith("creativePlan", "Creative Plan", "Updated plan body");
    });

    fireEvent.click(screen.getByRole("button", { name: "人物关系图" }));
    await waitFor(() => {
      expect(onRelationshipDiagramCollapsedChange).toHaveBeenLastCalledWith(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "人物关系图" }));
    await waitFor(() => {
      expect(onRelationshipDiagramCollapsedChange).toHaveBeenLastCalledWith(false);
    });
  });

  it("routes episode batch review through the shared workflow action instead of local panel execution", () => {
    const onArtifactAction = vi.fn();

    render(
      <ScriptArtifactPanel
        snapshot={createSnapshot([
          {
            id: "episode-preview",
            kind: "episode",
            label: "分集撰写",
            summary: "Episode progress",
            updatedAt: "2026-04-02T00:00:00.000Z",
            presentation: "script-rich",
            payload: {
              type: "episodes+batchProgress",
              totalEpisodes: 1,
              durationSeconds: 60,
              entries: [
                {
                  number: 1,
                  title: "Episode 1",
                  summary: "Summary",
                  outline: "Outline",
                  content: "Episode body",
                  wordCount: 1200,
                  status: "done",
                },
                {
                  number: 2,
                  title: "Episode 2",
                  summary: "Summary",
                  outline: "Outline",
                  content: "Episode body",
                  wordCount: 1200,
                  status: "done",
                },
              ],
              batchProgress: {
                total: 2,
                done: 2,
                failed: 0,
                processing: 0,
                percent: 100,
                batches: [{ index: 0, label: "第1-2集", startEp: 1, endEp: 2, status: "done" }],
              },
            },
          },
        ])}
        onArtifactAction={onArtifactAction}
      />,
    );

    expandAllArtifacts();
    fireEvent.click(screen.getByRole("button", { name: "批量质量审查" }));

    expect(onArtifactAction).toHaveBeenCalledWith("script:episode-review", "批量质量审查");
    expect(callGeminiStreamMock).not.toHaveBeenCalled();
  });

  it("renders the full episode review packet content without trimming issues or repair instructions", () => {
    render(
      <ScriptArtifactPanel
        snapshot={createSnapshot([
          {
            id: "episode-review",
            kind: "episode-review",
            label: "本轮质检 1 集（第 1 集）",
            summary: "第 1 集完整质检结果",
            updatedAt: "2026-04-02T00:00:00.000Z",
            presentation: "script-rich",
            payload: {
              type: "episodeReview",
              batch: {
                mode: "episodes",
                episodeNumbers: [1],
                reviewedAt: "2026-04-02T00:00:00.000Z",
              },
              allPacketsCount: 1,
              episodes: [{ number: 1, title: "Episode 1", wordCount: 1200 }],
              summary: {
                reviewedCount: 1,
                averageTotal: 41,
                highestEpisodeNumber: 1,
                lowestEpisodeNumber: 1,
                riskCounts: { blocking: 0, warning: 3, suggestion: 2 },
                dimensionAverages: {
                  rhythm: 8,
                  satisfaction: 8,
                  dialogue: 8,
                  format: 9,
                  continuity: 8,
                },
              },
              packets: [
                {
                  id: "review-1",
                  episodeNumber: 1,
                  title: "Episode 1",
                  reviewedAt: "2026-04-02T00:00:00.000Z",
                  rewriteInstruction: "【质量审查发现的问题】\n警告 保留这段原始修复指令，不要被前端截断。\n【修订建议】\n1. 原样展示完整指令。",
                  result: {
                    total: 41,
                    grade: "优良",
                    scores: {
                      rhythm: { score: 8, comment: "节奏评价完整展示。" },
                      satisfaction: { score: 8, comment: "爽点评价完整展示。" },
                      dialogue: { score: 8, comment: "台词评价完整展示。" },
                      format: { score: 9, comment: "格式评价完整展示。" },
                      continuity: { score: 8, comment: "连贯性评价完整展示。" },
                    },
                    highlights: ["亮点内容也要保留。"],
                    issues: [
                      { level: "警告", description: "第一条问题。" },
                      { level: "警告", description: "第二条问题。" },
                      { level: "建议", description: "第三条问题不能再被 slice 截掉。" },
                    ],
                    suggestions: ["第一条建议。", "第二条建议必须显示。"],
                  },
                },
              ],
            },
          },
        ])}
      />,
    );

    expandAllArtifacts();

    expect(screen.getByText("节奏评价完整展示。")).toBeInTheDocument();
    expect(screen.getByText("亮点内容也要保留。")).toBeInTheDocument();
    expect(screen.getByText("第一条问题。")).toBeInTheDocument();
    expect(screen.getByText("第二条问题。")).toBeInTheDocument();
    expect(screen.getByText("第三条问题不能再被 slice 截掉。")).toBeInTheDocument();
    expect(screen.getByText("第二条建议必须显示。")).toBeInTheDocument();
    expect(screen.getByText(/保留这段原始修复指令，不要被前端截断/)).toBeInTheDocument();
  });

  it("opens the outline step panel from shared step actions instead of inline regeneration", () => {
    const onArtifactAction = vi.fn();

    render(
      <ScriptArtifactPanel
        snapshot={createSnapshot([
          {
            id: "outline",
            kind: "outline",
            label: "Outlines",
            summary: "Outline progress",
            updatedAt: "2026-04-02T00:00:00.000Z",
            presentation: "script-rich",
            payload: {
              type: "outlines+batchProgress",
              totalEpisodes: 24,
              entries: [
                {
                  number: 1,
                  title: "Episode 1",
                  summary: "Summary 1",
                  outline: "First outline body",
                  hookType: "Reversal",
                  isKey: true,
                  isClimax: false,
                  isPaywall: false,
                  emotionLevel: 4,
                },
              ],
              batchProgress: {
                total: 2,
                done: 1,
                failed: 0,
                processing: 0,
                percent: 50,
                batches: [
                  { index: 0, label: "1-12", startEp: 1, endEp: 12, status: "done" },
                  { index: 1, label: "13-24", startEp: 13, endEp: 24, status: "pending" },
                ],
              },
            },
          },
        ])}
        onArtifactAction={onArtifactAction}
      />,
    );

    expandAllArtifacts();
    fireEvent.click(screen.getByRole("button", { name: "更多细纲选项" }));

    expect(onArtifactAction).toHaveBeenCalledWith("script:step-enter-outlines", "打开细纲面板");
    expect(screen.queryByRole("button", { name: /重新生成第 1 集细纲/ })).not.toBeInTheDocument();
  });

  it("falls back to mermaid source when diagram rendering fails", async () => {
    mermaidRenderMock.mockRejectedValueOnce(new Error("boom"));

    render(
      <ScriptArtifactPanel
        snapshot={createSnapshot([
          {
            id: "characters",
            kind: "characters",
            label: "Characters",
            summary: "Character summary",
            updatedAt: "2026-04-02T00:00:00.000Z",
            presentation: "script-rich",
            payload: {
              type: "characters+mermaid",
              body: "Lead A\nLead B",
              mermaidCode: "graph TD\nA[Lead A] --> B[Lead B]",
              characterCards: [],
            },
          },
        ])}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "展开" }));

    await waitFor(() => {
      expect(screen.getByText(/Mermaid 渲染失败/)).toBeInTheDocument();
    });
    expect(screen.getByText(/graph TD/)).toBeInTheDocument();
  });

  it("keeps the directory card visible when an empty outline placeholder is appended after it", () => {
    render(
      <ScriptArtifactPanel
        snapshot={createSnapshot([
          {
            id: "directory",
            kind: "directory",
            label: "Directory",
            summary: "Directory summary",
            updatedAt: "2026-04-02T00:00:00.000Z",
            presentation: "script-rich",
            payload: {
              type: "directory+stats",
              entries: [
                {
                  number: 1,
                  title: "Episode 1",
                  summary: "Directory summary 1",
                  hookType: "Suspense",
                  isKey: true,
                  isClimax: false,
                  isPaywall: false,
                  emotionLevel: 3,
                },
              ],
              stats: {
                totalEpisodes: 24,
                outlinedEpisodes: 0,
                writtenEpisodes: 0,
                keyEpisodes: 1,
                climaxEpisodes: 0,
                paywallEpisodes: 0,
              },
            },
          },
          {
            id: "outline",
            kind: "outline",
            label: "Outlines",
            summary: "Outline progress",
            updatedAt: "2026-04-02T00:00:00.000Z",
            presentation: "script-rich",
            payload: {
              type: "outlines+batchProgress",
              totalEpisodes: 24,
              entries: [],
              batchProgress: {
                total: 2,
                done: 0,
                failed: 0,
                processing: 0,
                percent: 0,
                batches: [
                  { index: 0, label: "1-12", startEp: 1, endEp: 12, status: "pending" },
                  { index: 1, label: "13-24", startEp: 13, endEp: 24, status: "pending" },
                ],
              },
            },
          },
        ])}
      />,
    );

    expect(screen.getByText("Directory")).toBeInTheDocument();
    expect(screen.queryByText("Outlines")).not.toBeInTheDocument();
  });

  it("supports translation stop and resume for long non-Chinese text", async () => {
    const englishText = Array.from({ length: 220 }, (_, index) => `line ${index + 1}`).join("\n");

    callGeminiStreamMock
      .mockResolvedValueOnce(Array.from({ length: 200 }, (_, index) => `${index + 1}|cn-${index + 1}`).join("\n"))
      .mockImplementationOnce(
        (_model: unknown, _contents: unknown, _onChunk: unknown, _config: unknown, signal?: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              Object.assign(error, { name: "AbortError" });
              reject(error);
            });
          }),
      )
      .mockResolvedValueOnce(Array.from({ length: 20 }, (_, index) => `${index + 1}|cn-${index + 201}`).join("\n"));

    render(
      <ScriptArtifactPanel
        snapshot={createSnapshot([
          {
            id: "plain",
            kind: "plan",
            label: "Plain Text",
            summary: "Plain summary",
            content: englishText,
            updatedAt: "2026-04-02T00:00:00.000Z",
          },
        ])}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    fireEvent.click(screen.getByRole("button", { name: "译文" }));

    await waitFor(() => {
      expect(screen.getByText("1/2")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "停止" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "继续" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "继续" }));

    await waitFor(() => {
      expect(screen.getByText(/cn-201/)).toBeInTheDocument();
    });
  });

  it("falls back to plain text rendering when no payload is available", () => {
    render(
      <ScriptArtifactPanel
        snapshot={createSnapshot([
          {
            id: "plain",
            kind: "plan",
            label: "Plain Text",
            summary: "Plain summary",
            content: "This is the plain artifact body.",
            updatedAt: "2026-04-02T00:00:00.000Z",
          },
        ])}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "展开" }));

    expect(screen.getByText("Plain Text")).toBeInTheDocument();
    expect(screen.getByText("This is the plain artifact body.")).toBeInTheDocument();
  });
});
