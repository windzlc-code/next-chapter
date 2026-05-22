import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { HomeAgentMessage } from "@/lib/home-agent/types";
import { ActiveConversationShell } from "./home-agent-shell";

vi.mock("./ScriptArtifactPanel", () => ({
  ScriptArtifactPanel: () => null,
}));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

describe("ActiveConversationShell user bubble layout", () => {
  it("keeps full-auto proxy user bubbles on a single-line template", () => {
    const messages: HomeAgentMessage[] = [
      {
        id: "user-full-auto-proxy",
        role: "user",
        content: "Confirm setup",
        createdAt: "2026-04-08T00:00:00.000Z",
        status: "complete",
        automationOrigin: "full-auto",
      },
    ];

    const { container } = render(
      <ActiveConversationShell
        messages={messages}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming={false}
        trackClassName="max-w-[820px]"
      />,
    );

    const layout = container.querySelector('[data-full-auto-proxy-layout="true"]');
    const content = container.querySelector('[data-full-auto-proxy-content="true"]');
    const badge = container.querySelector('[data-full-auto-proxy-badge="true"]');
    const bubble = content?.closest('[data-home-agent-message-role="user"] .w-fit');
    const stack = badge?.parentElement;

    expect(layout).not.toBeNull();
    expect(layout).toHaveClass("whitespace-nowrap");
    expect(content).not.toBeNull();
    expect(content).toHaveClass("whitespace-nowrap");
    expect(content).toHaveClass("text-center");
    expect(badge).not.toBeNull();
    expect(badge).not.toHaveClass("absolute");
    expect(stack).toHaveClass("flex");
    expect(stack).toHaveClass("flex-col");
    expect(stack).toHaveClass("items-end");
    expect(bubble).toHaveClass("w-fit");
    expect(bubble).toHaveClass("max-w-full");
    expect(bubble).toHaveClass("inline-flex");
    expect(bubble).toHaveClass("justify-center");
    expect(bubble).toHaveClass("px-4");
    expect(bubble).toHaveClass("sm:max-w-full");
    expect(bubble).toHaveClass("sm:px-5");
  });

  it("prefers a single-line bubble template for short normal user messages", () => {
    const messages: HomeAgentMessage[] = [
      {
        id: "user-regular",
        role: "user",
        content: "Batch render",
        createdAt: "2026-04-08T00:00:00.000Z",
        status: "complete",
      },
    ];

    const { container } = render(
      <ActiveConversationShell
        messages={messages}
        tasks={[]}
        onStopTask={() => undefined}
        onEditUserMessage={() => Promise.resolve()}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming={false}
        trackClassName="max-w-[820px]"
      />,
    );

    const bubble = container.querySelector('[data-home-agent-message-role="user"] .w-fit');
    const content = screen.getByText("Batch render");

    expect(bubble).not.toBeNull();
    expect(bubble).toHaveClass("w-fit");
    expect(bubble).toHaveClass("max-w-full");
    expect(bubble).toHaveClass("inline-flex");
    expect(bubble).toHaveClass("justify-center");
    expect(bubble).toHaveClass("px-4");
    expect(bubble).toHaveClass("sm:max-w-full");
    expect(bubble).toHaveClass("sm:px-5");
    expect(content).toHaveClass("whitespace-nowrap");
    expect(content).toHaveClass("text-center");
  });

  it("keeps longer full-auto proxy user messages on the same standby bubble rule", () => {
    const messages: HomeAgentMessage[] = [
      {
        id: "user-full-auto-proxy-long",
        role: "user",
        content: "Continue auto flow from creative plan",
        createdAt: "2026-04-08T00:00:00.000Z",
        status: "complete",
        automationOrigin: "full-auto",
      },
    ];

    const { container } = render(
      <ActiveConversationShell
        messages={messages}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming={false}
        trackClassName="max-w-[820px]"
      />,
    );

    const bubble = container.querySelector('[data-home-agent-message-role="user"] .w-fit');
    const badge = container.querySelector('[data-full-auto-proxy-badge="true"]');
    const stack = badge?.parentElement;
    const content = screen.getByText("Continue auto flow from creative plan");

    expect(badge).not.toBeNull();
    expect(badge).not.toHaveClass("absolute");
    expect(stack).toHaveClass("items-end");
    expect(bubble).not.toBeNull();
    expect(bubble).toHaveClass("w-fit");
    expect(bubble).toHaveClass("max-w-full");
    expect(bubble).toHaveClass("inline-flex");
    expect(bubble).toHaveClass("justify-center");
    expect(bubble).toHaveClass("px-4");
    expect(bubble).toHaveClass("sm:max-w-full");
    expect(bubble).toHaveClass("sm:px-5");
    expect(content).toHaveClass("whitespace-nowrap");
    expect(content).toHaveClass("text-center");
  });

  it("keeps hidden user action controls out of the bubble width flow", () => {
    const messages: HomeAgentMessage[] = [
      {
        id: "user-regular-actions",
        role: "user",
        content: "Batch render",
        createdAt: "2026-04-08T00:00:00.000Z",
        status: "complete",
      },
    ];

    render(
      <ActiveConversationShell
        messages={messages}
        tasks={[]}
        onStopTask={() => undefined}
        onEditUserMessage={() => Promise.resolve()}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming={false}
        trackClassName="max-w-[820px]"
      />,
    );

    const copyButton = screen.getByTitle("复制");
    const actionRail = copyButton.parentElement;

    expect(actionRail).not.toBeNull();
    expect(actionRail).toHaveClass("absolute");
    expect(actionRail).toHaveClass("right-full");
    expect(actionRail).toHaveClass("top-1/2");
  });

  it("keeps the user action rail visible briefly after hover leaves so the controls remain clickable", () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const messages: HomeAgentMessage[] = [
      {
        id: "user-regular-actions-delay",
        role: "user",
        content: "Batch render",
        createdAt: "2026-04-08T00:00:00.000Z",
        status: "complete",
      },
    ];

    const { container } = render(
      <ActiveConversationShell
        messages={messages}
        tasks={[]}
        onStopTask={() => undefined}
        onEditUserMessage={() => Promise.resolve()}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming={false}
        trackClassName="max-w-[820px]"
      />,
    );

    const copyButton = screen.getByLabelText("复制消息");
    const actionRail = copyButton.parentElement;

    act(() => {
      fireEvent.mouseLeave(actionRail!);
    });

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 450);
    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it("pins full-auto proxy user action controls to the bubble bottom instead of centering the whole stack", () => {
    const messages: HomeAgentMessage[] = [
      {
        id: "user-full-auto-actions",
        role: "user",
        content: "生成片段视频：按片段智能分批生成",
        createdAt: "2026-04-08T00:00:00.000Z",
        status: "complete",
        automationOrigin: "full-auto",
      },
    ];

    render(
      <ActiveConversationShell
        messages={messages}
        tasks={[]}
        onStopTask={() => undefined}
        onEditUserMessage={() => Promise.resolve()}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming={false}
        trackClassName="max-w-[820px]"
      />,
    );

    const copyButton = screen.getByLabelText("复制消息");
    const actionRail = copyButton.parentElement;
    const userRow = copyButton.closest('[data-home-agent-message-role="user"]');
    const userGroup = actionRail?.parentElement;

    expect(userGroup).toHaveClass("items-end");
    expect(userRow).toHaveClass("justify-end");
    expect(actionRail).toHaveClass("absolute");
    expect(actionRail).toHaveClass("right-full");
    expect(actionRail).toHaveClass("bottom-0");
    expect(actionRail).not.toHaveClass("top-1/2");
  });

  it("keeps user document attachment bubbles pinned to the right-aligned stack", () => {
    const messages: HomeAgentMessage[] = [
      {
        id: "user-doc-attachment",
        role: "user",
        content: "上传了文档",
        createdAt: "2026-04-08T00:00:00.000Z",
        status: "complete",
        attachments: [
          {
            id: "attachment-docx",
            fileName: "创作方案.docx",
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            size: 20 * 1024,
            kind: "document",
          },
        ],
      },
    ];

    const { container } = render(
      <ActiveConversationShell
        messages={messages}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming={false}
        trackClassName="max-w-[820px]"
      />,
    );

    const row = container.querySelector('[data-home-agent-message-role="user"]');
    const stack = row?.querySelector(".items-end");
    const bubble = row?.querySelector(".rounded-\\[18px\\]");

    expect(row).toHaveClass("justify-end");
    expect(stack).not.toBeNull();
    expect(stack).toHaveClass("flex");
    expect(stack).toHaveClass("flex-col");
    expect(stack).toHaveClass("items-end");
    expect(bubble).not.toBeNull();
  });

  it("right-aligns wrapped project setup summary text in ordinary mode", () => {
    const messages: HomeAgentMessage[] = [
      {
        id: "user-project-setup-summary",
        role: "user",
        content: "原创剧本立项：选题创作 / 国内（中文） / 宫廷宅斗 / 古风仙侠 / 沿用默认配置",
        createdAt: "2026-04-08T00:00:00.000Z",
        status: "complete",
      },
    ];

    const { container } = render(
      <ActiveConversationShell
        messages={messages}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming={false}
        trackClassName="max-w-[420px]"
      />,
    );

    const row = container.querySelector('[data-home-agent-message-role="user"]');
    const stack = row?.querySelector(".items-end");
    const bubble = row?.querySelector(".rounded-\\[18px\\]");
    const content = screen.getByText("原创剧本立项：选题创作 / 国内（中文） / 宫廷宅斗 / 古风仙侠 / 沿用默认配置");

    expect(row).toHaveClass("justify-end");
    expect(stack).not.toBeNull();
    expect(stack).toHaveClass("flex");
    expect(stack).toHaveClass("flex-col");
    expect(stack).toHaveClass("items-end");
    expect(bubble).not.toBeNull();
    expect(content).toHaveClass("text-right");
    expect(content).not.toHaveClass("text-center");
  });

  it("keeps long ordinary user bubbles pinned to the right-aligned stack", () => {
    const messages: HomeAgentMessage[] = [
      {
        id: "user-long-freeform",
        role: "user",
        content:
          "先别急着让我点选，先用自然语言比较一下这两种开始方式各自适合什么情况，我想先理解差别再决定。",
        createdAt: "2026-04-08T00:00:00.000Z",
        status: "complete",
      },
    ];

    const { container } = render(
      <ActiveConversationShell
        messages={messages}
        tasks={[]}
        onStopTask={() => undefined}
        onEditUserMessage={() => Promise.resolve()}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming={false}
        trackClassName="max-w-[420px]"
      />,
    );

    const row = container.querySelector('[data-home-agent-message-role="user"]');
    const stack = row?.querySelector(".items-end");
    const bubble = row?.querySelector('[data-home-agent-user-bubble="true"]');
    const content = screen.getByText(
      "先别急着让我点选，先用自然语言比较一下这两种开始方式各自适合什么情况，我想先理解差别再决定。",
    );

    expect(row).toHaveClass("justify-end");
    expect(stack).not.toBeNull();
    expect(stack).toHaveClass("flex");
    expect(stack).toHaveClass("flex-col");
    expect(stack).toHaveClass("items-end");
    expect(bubble).not.toBeNull();
    expect(bubble).toHaveClass("w-fit");
    expect(bubble).toHaveClass("self-end");
    expect(bubble).toHaveClass("max-w-[min(84vw,700px)]");
    expect(bubble).toHaveClass("sm:max-w-[min(76vw,624px)]");
    expect(content).toHaveClass("whitespace-pre-wrap");
    expect(content).not.toHaveClass("text-center");
  });
});
