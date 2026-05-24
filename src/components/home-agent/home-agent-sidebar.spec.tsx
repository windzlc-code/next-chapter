import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Compass, PanelsTopLeft } from "lucide-react";
import type { ConversationProjectSnapshot, StudioSessionState } from "@/lib/home-agent/types";
import type { SidebarAssetItem } from "./home-agent-sidebar-utils";
import { DesktopSidebar, MobileSidebarSheet, type HomeAgentTemplate } from "./home-agent-sidebar";

function createProjectSnapshot(
  index: number,
  overrides: Partial<ConversationProjectSnapshot> = {},
): ConversationProjectSnapshot {
  return {
    projectId: `project-${index}`,
    projectKind: "script",
    title: `娴嬭瘯椤圭洰 ${index}`,
    currentObjective: "缁х画鎺ㄨ繘褰撳墠姝ラ",
    derivedStage: "鍒涙剰鏂规",
    agentSummary: "绛夊緟鐢ㄦ埛缁х画閫夋嫨",
    recommendedActions: ["缁х画瀹屽杽鍓ф湰"],
    artifacts: [],
    updatedAt: `2026-05-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`,
    ...overrides,
  };
}

function createProjectSession(
  projectId: string,
  automationMode: "manual" | "full-auto",
  snapshot?: ConversationProjectSnapshot,
): StudioSessionState {
  return {
    mode: "active",
    projectId,
    automationMode,
    messages: [],
    recentMessageSummary: "",
    currentProjectSnapshot: snapshot ?? null,
  };
}

function createImageAsset(
  index: number,
  overrides: Partial<Extract<SidebarAssetItem, { kind: "image" }>> = {},
): SidebarAssetItem {
  return {
    id: `asset-${index}`,
    kind: "image",
    label: `瑙掕壊绱犳潗 ${index}`,
    url: `https://example.com/assets/${index}.jpg`,
    meta: "瑙掕壊",
    origin: "derived",
    ...overrides,
  };
}

function createVideoAsset(index: number): SidebarAssetItem {
  return {
    id: `video-${index}`,
    kind: "video",
    label: `鐟欏棝顣剁槐鐘虫綏 ${index}`,
    url: `https://example.com/assets/${index}.mp4`,
    meta: `缁?{index}闂?`,
    origin: "derived",
  };
}

function getRenderedAssetIds(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-sidebar-asset-id]")).map(
    (node) => node.dataset.sidebarAssetId || "",
  );
}

function defineScrollMetrics(element: HTMLElement, metrics: {
  scrollHeight: number;
  clientHeight: number;
  scrollTop?: number;
}) {
  let currentScrollTop = metrics.scrollTop ?? 0;
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => metrics.scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get: () => metrics.clientHeight,
  });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => currentScrollTop,
    set: (value: number) => {
      currentScrollTop = value;
    },
  });
  return {
    setScrollTop(value: number) {
      currentScrollTop = value;
    },
  };
}

async function openAssetMenu(assetId: string) {
  const row = await waitFor(() => {
    const candidate = document.querySelector(
      `[data-sidebar-asset-id='${assetId}']`,
    ) as HTMLElement | null;
    expect(candidate).not.toBeNull();
    return candidate as HTMLElement;
  });
  const trigger = row.querySelector(
    "[data-sidebar-asset-menu-trigger='true']",
  ) as HTMLButtonElement | null;
  expect(trigger).not.toBeNull();
  fireEvent.click(trigger!);
  return row;
}

function renderSidebar({
  idle = false,
  recentProjects = [],
  recentProjectSessions = [],
  assets = [],
  templates = [],
  currentProjectId,
  currentProjectSnapshot = null,
  highlightedAssetId = null,
  automationMode = "manual",
  fullAutoRunStatus = null,
}: {
  idle?: boolean;
  recentProjects?: ConversationProjectSnapshot[];
  recentProjectSessions?: StudioSessionState[];
  assets?: SidebarAssetItem[];
  templates?: HomeAgentTemplate[];
  currentProjectId?: string;
  currentProjectSnapshot?: ConversationProjectSnapshot | null;
  highlightedAssetId?: string | null;
  automationMode?: "manual" | "full-auto";
  fullAutoRunStatus?: "idle" | "collecting" | "running" | "retrying" | "paused" | "stopped" | "completed" | "failed" | null;
}) {
  const noop = vi.fn();
  return render(
    <MobileSidebarSheet
      open
      onOpenChange={noop}
      idle={idle}
      recentProjects={recentProjects}
      recentProjectSessions={recentProjectSessions}
      recentProjectsReady
      templates={templates}
      assets={assets}
      currentProjectId={currentProjectId}
      currentProjectSnapshot={currentProjectSnapshot}
      brandLabel="StoryForge"
      sheetClassName=""
      onTemplateLaunch={noop}
      onOpenProject={noop}
      onNewProject={noop}
      onOpenSettings={noop}
      automationMode={automationMode}
      fullAutoRunStatus={fullAutoRunStatus}
      highlightedAssetId={highlightedAssetId}
      highlightedAssetMessage={highlightedAssetId ? "已高亮" : null}
    />,
  );
}

function createSidebarElement({
  idle = false,
  recentProjects = [],
  recentProjectSessions = [],
  assets = [],
  templates = [],
  currentProjectId,
  currentProjectSnapshot = null,
  highlightedAssetId = null,
  automationMode = "manual",
  fullAutoRunStatus = null,
  noop = vi.fn(),
}: {
  idle?: boolean;
  recentProjects?: ConversationProjectSnapshot[];
  recentProjectSessions?: StudioSessionState[];
  assets?: SidebarAssetItem[];
  templates?: HomeAgentTemplate[];
  currentProjectId?: string;
  currentProjectSnapshot?: ConversationProjectSnapshot | null;
  highlightedAssetId?: string | null;
  automationMode?: "manual" | "full-auto";
  fullAutoRunStatus?: "idle" | "collecting" | "running" | "retrying" | "paused" | "stopped" | "completed" | "failed" | null;
  noop?: ReturnType<typeof vi.fn>;
}) {
  return (
    <MobileSidebarSheet
      open
      onOpenChange={noop}
      idle={idle}
      recentProjects={recentProjects}
      recentProjectSessions={recentProjectSessions}
      recentProjectsReady
      templates={templates}
      assets={assets}
      currentProjectId={currentProjectId}
      currentProjectSnapshot={currentProjectSnapshot}
      brandLabel="StoryForge"
      sheetClassName=""
      onTemplateLaunch={noop}
      onOpenProject={noop}
      onNewProject={noop}
      onOpenSettings={noop}
      automationMode={automationMode}
      fullAutoRunStatus={fullAutoRunStatus}
      highlightedAssetId={highlightedAssetId}
      highlightedAssetMessage={highlightedAssetId ? "已高亮" : null}
    />
  );
}

function renderDesktopSidebar({
  idle = false,
  recentProjects = [],
  recentProjectSessions = [],
  assets = [],
  currentProjectId,
  currentProjectSnapshot = null,
  templates = [],
  automationMode = "manual",
  fullAutoRunStatus = null,
  onDuplicateProject,
  onDeleteProject,
  onUploadCharacterAudioReference,
  onRemoveCharacterAudioReference,
  onRefreshSegmentContinuity,
}: {
  idle?: boolean;
  recentProjects?: ConversationProjectSnapshot[];
  recentProjectSessions?: StudioSessionState[];
  assets?: SidebarAssetItem[];
  currentProjectId?: string;
  currentProjectSnapshot?: ConversationProjectSnapshot | null;
  templates?: HomeAgentTemplate[];
  automationMode?: "manual" | "full-auto";
  fullAutoRunStatus?: "idle" | "collecting" | "running" | "retrying" | "paused" | "stopped" | "completed" | "failed" | null;
  onDuplicateProject?: (project: ConversationProjectSnapshot) => void;
  onDeleteProject?: (project: ConversationProjectSnapshot) => void;
  onUploadCharacterAudioReference?: (characterId: string, characterName?: string) => void;
  onRemoveCharacterAudioReference?: (characterId: string, characterName?: string) => void;
  onRefreshSegmentContinuity?: (asset: SidebarAssetItem) => void;
}) {
  const noop = vi.fn();
  return render(
    <DesktopSidebar
      idle={idle}
      recentProjects={recentProjects}
      recentProjectSessions={recentProjectSessions}
      recentProjectsReady
      templates={templates}
      assets={assets}
      currentProjectId={currentProjectId}
      currentProjectSnapshot={currentProjectSnapshot}
      brandLabel="StoryForge"
      expandedWidth={320}
      collapsedWidth={72}
      onTemplateLaunch={noop}
      onOpenProject={noop}
      onNewProject={noop}
      onOpenSettings={noop}
      onToggleCollapse={noop}
      onDuplicateProject={onDuplicateProject}
      onDeleteProject={onDeleteProject}
      onUploadCharacterAudioReference={onUploadCharacterAudioReference}
      onRemoveCharacterAudioReference={onRemoveCharacterAudioReference}
      onRefreshSegmentContinuity={onRefreshSegmentContinuity}
      automationMode={automationMode}
      fullAutoRunStatus={fullAutoRunStatus}
    />,
  );
}

function createDesktopSidebarElement({
  idle = false,
  recentProjects = [],
  recentProjectSessions = [],
  assets = [],
  currentProjectId,
  currentProjectSnapshot = null,
  templates = [],
  automationMode = "manual",
  fullAutoRunStatus = null,
  onDuplicateProject,
  onDeleteProject,
  noop = vi.fn(),
}: {
  idle?: boolean;
  recentProjects?: ConversationProjectSnapshot[];
  recentProjectSessions?: StudioSessionState[];
  assets?: SidebarAssetItem[];
  currentProjectId?: string;
  currentProjectSnapshot?: ConversationProjectSnapshot | null;
  templates?: HomeAgentTemplate[];
  automationMode?: "manual" | "full-auto";
  fullAutoRunStatus?: "idle" | "collecting" | "running" | "retrying" | "paused" | "stopped" | "completed" | "failed" | null;
  onDuplicateProject?: (project: ConversationProjectSnapshot) => void;
  onDeleteProject?: (project: ConversationProjectSnapshot) => void;
  noop?: ReturnType<typeof vi.fn>;
}) {
  return (
    <DesktopSidebar
      idle={idle}
      recentProjects={recentProjects}
      recentProjectSessions={recentProjectSessions}
      recentProjectsReady
      templates={templates}
      assets={assets}
      currentProjectId={currentProjectId}
      currentProjectSnapshot={currentProjectSnapshot}
      brandLabel="StoryForge"
      expandedWidth={320}
      collapsedWidth={72}
      onTemplateLaunch={noop}
      onOpenProject={noop}
      onNewProject={noop}
      onOpenSettings={noop}
      onToggleCollapse={noop}
      onDuplicateProject={onDuplicateProject}
      onDeleteProject={onDeleteProject}
      automationMode={automationMode}
      fullAutoRunStatus={fullAutoRunStatus}
    />
  );
}

function readHistoryOrder(): string[] {
  return Array.from(document.querySelectorAll("[data-sidebar-history-id]"))
    .map((element) => element.getAttribute("data-sidebar-history-id") || "")
    .filter(Boolean);
}

describe("home-agent-sidebar incremental rendering", () => {
  it("renders history in chunks and expands after scrolling", async () => {
    const recentProjects = Array.from({ length: 120 }, (_, index) => createProjectSnapshot(index + 1));
    renderSidebar({ recentProjects });

    expect(document.querySelectorAll("[data-sidebar-history-id]").length).toBe(48);

    const historyList = document.querySelector("[data-sidebar-history-list='true']") as HTMLElement | null;
    expect(historyList).not.toBeNull();
    if (!historyList) return;

    const scrollState = defineScrollMetrics(historyList, {
      scrollHeight: 3200,
      clientHeight: 360,
    });
    scrollState.setScrollTop(2860);
    fireEvent.scroll(historyList);

    await waitFor(() => {
      expect(document.querySelectorAll("[data-sidebar-history-id]").length).toBeGreaterThan(48);
    });
  });

  it("keeps the active history card rendered even when it falls beyond the first chunk", () => {
    const recentProjects = Array.from({ length: 120 }, (_, index) => createProjectSnapshot(index + 1));
    renderSidebar({
      recentProjects,
      currentProjectId: "project-95",
    });

    expect(document.querySelector("[data-sidebar-history-id='project-95']")).not.toBeNull();
    expect(document.querySelectorAll("[data-sidebar-history-id]").length).toBeGreaterThan(48);
    expect(document.querySelectorAll("[data-sidebar-history-id]").length).toBeLessThan(120);
  });

  it("renders image assets in chunks, expands after scrolling, and keeps highlighted assets available", async () => {
    const assets = Array.from({ length: 180 }, (_, index) => createImageAsset(index + 1));
    const highlightedRender = renderSidebar({
      assets,
      highlightedAssetId: "asset-95",
    });

    expect(document.querySelector("[data-sidebar-asset-id='asset-95']")).not.toBeNull();
    expect(document.querySelectorAll("[data-sidebar-asset-id]").length).toBeGreaterThan(60);
    expect(document.querySelectorAll("[data-sidebar-asset-id]").length).toBeLessThan(180);

    highlightedRender.unmount();
    renderSidebar({ assets });
    expect(document.querySelectorAll("[data-sidebar-asset-id]").length).toBe(60);

    const assetList = document.querySelector("[data-sidebar-asset-list='image']") as HTMLElement | null;
    expect(assetList).not.toBeNull();
    if (!assetList) return;

    const scrollState = defineScrollMetrics(assetList, {
      scrollHeight: 3600,
      clientHeight: 280,
    });
    scrollState.setScrollTop(3340);
    fireEvent.scroll(assetList);

    await waitFor(() => {
      expect(document.querySelectorAll("[data-sidebar-asset-id]").length).toBeGreaterThan(60);
    });
  });

  it("shows character audio actions inside the asset menu without taking over the image title area", async () => {
    const onUploadCharacterAudioReference = vi.fn();
    const onRemoveCharacterAudioReference = vi.fn();
    const playSpy = vi
      .spyOn(window.HTMLMediaElement.prototype, "play")
      .mockImplementation(function play(this: HTMLMediaElement) {
        this.dispatchEvent(new Event("play"));
        return Promise.resolve();
      });
    const pauseSpy = vi
      .spyOn(window.HTMLMediaElement.prototype, "pause")
      .mockImplementation(function pause(this: HTMLMediaElement) {
        this.dispatchEvent(new Event("pause"));
      });

    const view = renderDesktopSidebar({
      assets: [
        createImageAsset(1, {
          label: "角色 · 林萧",
          characterAudioTargetId: "char-1",
          characterAudioTargetName: "林萧",
          characterAudioUrl: "file:///assets/linxiao-reference.wav",
          characterAudioFileName: "linxiao-reference.wav",
          characterAudioReferenceReady: true,
        }),
      ],
      onUploadCharacterAudioReference,
      onRemoveCharacterAudioReference,
    });

    const titleButton = screen.getByRole("button", { name: "角色 · 林萧" });
    expect(titleButton).toHaveTextContent("角色 · 林萧");

    await openAssetMenu("asset-1");
    const uploadItem = await screen.findByRole("menuitem", { name: /更新.*林萧/ });
    const playItem = await screen.findByRole("menuitem", { name: /播放.*linxiao-reference\.wav/ });
    const removeItem = await screen.findByRole("menuitem", { name: /删除.*林萧/ });

    expect(uploadItem).toHaveAttribute("data-sidebar-asset-upload-audio", "true");
    expect(playItem).toHaveAttribute("data-sidebar-asset-play-audio", "true");
    expect(removeItem).toHaveAttribute("data-sidebar-asset-remove-audio", "true");

    fireEvent.click(uploadItem);
    expect(onUploadCharacterAudioReference).toHaveBeenCalledWith("char-1", "林萧");

    await openAssetMenu("asset-1");
    fireEvent.click(await screen.findByRole("menuitem", { name: /删除.*林萧/ }));
    expect(onRemoveCharacterAudioReference).not.toHaveBeenCalled();
    expect(screen.getByText("确认移除当前音频参考？")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(onRemoveCharacterAudioReference).toHaveBeenCalledWith("char-1", "林萧");

    await openAssetMenu("asset-1");
    fireEvent.click(await screen.findByRole("menuitem", { name: /播放.*linxiao-reference\.wav/ }));
    await waitFor(() => {
      expect(playSpy).toHaveBeenCalled();
    });

    await openAssetMenu("asset-1");
    const pauseItem = await screen.findByRole("menuitem", { name: /暂停.*linxiao-reference\.wav/ });
    expect(pauseItem).toBeInTheDocument();
    fireEvent.click(pauseItem);
    expect(pauseSpy).toHaveBeenCalled();

    view.unmount();
    playSpy.mockRestore();
    pauseSpy.mockRestore();
  });

  it("keeps the upload hint distinct inside the asset menu when no character audio has been uploaded yet", async () => {
    const onUploadCharacterAudioReference = vi.fn();

    renderDesktopSidebar({
      assets: [
        createImageAsset(1, {
          label: "角色 · 赵峰",
          characterAudioTargetId: "char-2",
          characterAudioTargetName: "赵峰",
        }),
      ],
      onUploadCharacterAudioReference,
    });

    await openAssetMenu("asset-1");
    expect(await screen.findByRole("menuitem", { name: /上传.*赵峰/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /播放.*赵峰/ })).not.toBeInTheDocument();
  });

  it("keeps expanded history visible when new sessions are appended", async () => {
    const initialProjects = Array.from({ length: 120 }, (_, index) => createProjectSnapshot(index + 1));
    const noop = vi.fn();
    const view = render(createSidebarElement({ recentProjects: initialProjects, noop }));

    const loadMoreButton = document.querySelector(
      '[data-sidebar-load-more="history"]',
    ) as HTMLButtonElement | null;
    expect(loadMoreButton).not.toBeNull();
    if (!loadMoreButton) return;
    fireEvent.click(loadMoreButton);

    await waitFor(() => {
      expect(document.querySelectorAll("[data-sidebar-history-id]").length).toBe(96);
    });

    const appendedProjects = [...initialProjects, createProjectSnapshot(121)];
    view.rerender(createSidebarElement({ recentProjects: appendedProjects, noop }));

    await waitFor(() => {
      expect(document.querySelectorAll("[data-sidebar-history-id]").length).toBeGreaterThanOrEqual(96);
    });
  });

  it("keeps the remaining history cards in their prior relative order after delete-style set changes", () => {
    const bridgeShell = createProjectSnapshot(1, {
      projectId: "bridge-script",
      title: "Bridge Script",
      updatedAt: "2026-04-05T12:00:00.000Z",
    });
    const siblingA = createProjectSnapshot(2, {
      projectId: "sibling-a",
      title: "Sibling A",
      updatedAt: "2026-04-06T12:00:00.000Z",
    });
    const siblingB = createProjectSnapshot(3, {
      projectId: "sibling-b",
      title: "Sibling B",
      updatedAt: "2026-04-07T12:00:00.000Z",
    });
    const noop = vi.fn();

    const view = render(
      createDesktopSidebarElement({
        recentProjects: [siblingB, siblingA, bridgeShell],
        currentProjectId: bridgeShell.projectId,
        noop,
      }),
    );

    expect(readHistoryOrder()).toEqual(["sibling-b", "sibling-a", "bridge-script"]);

    view.rerender(
      createDesktopSidebarElement({
        recentProjects: [bridgeShell, siblingB],
        currentProjectId: siblingB.projectId,
        noop,
      }),
    );

    expect(readHistoryOrder()).toEqual(["sibling-b", "bridge-script"]);
  });

  it("keeps visible history order stable when a bridged linked-video identity is added behind the source script shell", () => {
    const bridgeShell = createProjectSnapshot(1, {
      projectId: "bridge-script",
      title: "Bridge Script",
      updatedAt: "2026-04-05T12:00:00.000Z",
    });
    const siblingA = createProjectSnapshot(2, {
      projectId: "sibling-a",
      title: "Sibling A",
      updatedAt: "2026-04-06T12:00:00.000Z",
    });
    const siblingB = createProjectSnapshot(3, {
      projectId: "sibling-b",
      title: "Sibling B",
      updatedAt: "2026-04-07T12:00:00.000Z",
    });
    const bridgeVideoSnapshot = createProjectSnapshot(4, {
      projectId: "bridge-video",
      projectKind: "video",
      sourceProjectId: "bridge-script",
      title: "Bridge Script",
      derivedStage: "鑴氭湰鎷嗚В",
      currentObjective: "Continue video workflow",
      updatedAt: "2026-05-18T09:30:00.000Z",
    });
    const noop = vi.fn();

    const view = render(
      createDesktopSidebarElement({
        recentProjects: [siblingB, siblingA, bridgeShell],
        currentProjectId: bridgeShell.projectId,
        noop,
      }),
    );

    expect(readHistoryOrder()).toEqual(["sibling-b", "sibling-a", "bridge-script"]);

    view.rerender(
      createDesktopSidebarElement({
        recentProjects: [bridgeShell, siblingB, siblingA, bridgeVideoSnapshot],
        recentProjectSessions: [
          createProjectSession("bridge-script", "manual", bridgeVideoSnapshot),
        ],
        currentProjectId: "bridge-script",
        currentProjectSnapshot: bridgeVideoSnapshot,
        noop,
      }),
    );

    expect(readHistoryOrder()).toEqual(["sibling-b", "sibling-a", "bridge-script"]);
  });

  it("keeps expanded asset lists visible when new assets are appended", async () => {
    const initialAssets = Array.from({ length: 180 }, (_, index) => createImageAsset(index + 1));
    const noop = vi.fn();
    const view = render(createSidebarElement({ assets: initialAssets, noop }));

    const loadMoreAssetsButton = document.querySelector(
      '[data-sidebar-load-more="image-assets"]',
    ) as HTMLButtonElement | null;
    expect(loadMoreAssetsButton).not.toBeNull();
    if (!loadMoreAssetsButton) return;
    fireEvent.click(loadMoreAssetsButton);

    await waitFor(() => {
      expect(document.querySelectorAll("[data-sidebar-asset-id]").length).toBe(120);
    });

    const appendedAssets = [...initialAssets, createImageAsset(181)];
    view.rerender(createSidebarElement({ assets: appendedAssets, noop }));

    await waitFor(() => {
      expect(document.querySelectorAll("[data-sidebar-asset-id]").length).toBeGreaterThanOrEqual(120);
    });
  });

  it("uses larger hit areas and typography for history cards and asset library controls", () => {
    renderSidebar({
      recentProjects: [createProjectSnapshot(1)],
      assets: [createImageAsset(1)],
    });

    const brandTitle = screen.getByText("StoryForge");
    expect(brandTitle).toHaveClass("text-[15px]");

    const brandSubtitle = screen.getByText("褰撳墠棣栭〉浼氳瘽");
    expect(brandSubtitle).toHaveClass("text-[11px]");

    const historyCard = document.querySelector("[data-sidebar-history-id='project-1']");
    expect(historyCard).toHaveClass("rounded-[12px]", "py-1.5");

    const historyTitle = historyCard?.querySelector(".text-\\[13\\.5px\\]") as HTMLElement | null;
    expect(historyTitle).toHaveClass("text-[13.5px]", "leading-5");

    const imageTab = screen.getByRole("button", { name: /鍥剧墖/ });
    expect(imageTab).toHaveClass("rounded-[10px]", "py-2", "text-[13px]");

    const assetRow = document.querySelector("[data-sidebar-asset-id='asset-1']");
    expect(assetRow).toHaveClass("rounded-[14px]", "py-2");

    const assetLabel = assetRow?.querySelector(".text-\\[12px\\]") as HTMLElement | null;
    expect(assetLabel).toHaveClass("text-[12px]", "leading-5");
  });

  it("uses the flowing full-auto frame on conversation history in full-auto mode", () => {
    renderSidebar({
      recentProjects: [createProjectSnapshot(1)],
      automationMode: "full-auto",
      fullAutoRunStatus: "running",
    });

    const historySection = document.querySelector("[data-automation-mode='full-auto']");
    expect(historySection).toHaveClass("home-agent-full-auto-frame-active");
  });

  it("uses the blue-violet accent on active history cards, AUTO badges, subtitles, and asset count badges", () => {
    renderSidebar({
      recentProjects: [createProjectSnapshot(1, { automationMode: "full-auto" })],
      currentProjectId: "project-1",
      automationMode: "full-auto",
      assets: [createImageAsset(1), createVideoAsset(1)],
    });

    const historyCard = document.querySelector("[data-sidebar-history-id='project-1']");
    expect(historyCard).toHaveClass("bg-[rgba(108,126,210,0.18)]", "ring-[rgba(132,150,236,0.34)]");

    const statusDot = historyCard?.querySelector("[data-sidebar-history-status-dot='true']");
    expect(statusDot).toHaveClass("bg-[rgb(146,166,252)]", "shadow-[0_0_8px_2px_rgba(138,156,244,0.28)]");

    const autoBadge = historyCard?.querySelector("[data-sidebar-history-auto-badge='true']");
    expect(autoBadge).toHaveClass(
      "border-[rgba(132,150,236,0.34)]",
      "bg-[rgba(108,126,210,0.14)]",
      "text-[rgb(156,174,255)]",
    );

    const subtitle = historyCard?.querySelector("[data-sidebar-history-subtitle='true']");
    expect(subtitle).toHaveClass("text-[rgba(156,174,255,0.9)]");

    const countBadges = Array.from(document.querySelectorAll("[data-sidebar-accent-count='true']"));
    expect(countBadges.length).toBeGreaterThanOrEqual(3);
    countBadges.forEach((badge) => {
      expect(badge).toHaveClass("bg-[rgba(108,126,210,0.14)]", "text-[rgb(156,174,255)]");
    });
  });

  it("strips quick-task prefixes from full-auto history titles without changing manual titles", () => {
    const prefixedTitle = "视频工作流：测试项目";
    const fullAutoView = renderSidebar({
      recentProjects: [createProjectSnapshot(1, { automationMode: "full-auto", title: prefixedTitle })],
      automationMode: "full-auto",
    });

    const fullAutoCard = document.querySelector("[data-sidebar-history-id='project-1'] button");
    expect(screen.getByText("测试项目")).toBeInTheDocument();
    expect(screen.queryByText(prefixedTitle)).toBeNull();
    expect(fullAutoCard).toHaveAttribute("aria-label", "测试项目");
    expect(fullAutoCard).toHaveAttribute("title", "测试项目");

    fullAutoView.unmount();

    renderSidebar({
      recentProjects: [createProjectSnapshot(1, { automationMode: "manual", title: prefixedTitle })],
      automationMode: "manual",
    });

    const manualCard = document.querySelector("[data-sidebar-history-id='project-1'] button");
    expect(screen.getByText(prefixedTitle)).toBeInTheDocument();
    expect(manualCard).toHaveAttribute("aria-label", prefixedTitle);
    expect(manualCard).toHaveAttribute("title", prefixedTitle);
  });

  it("shows the correct history count for the currently visible automation stream", () => {
    const projects = [
      createProjectSnapshot(1, { automationMode: "manual" }),
      createProjectSnapshot(2, { automationMode: "manual" }),
      createProjectSnapshot(3, { automationMode: "full-auto" }),
    ];

    const manualView = renderSidebar({
      recentProjects: projects,
      automationMode: "manual",
    });

    expect(document.querySelector("[data-sidebar-history-count='true']")?.textContent?.trim()).toBe("2");
    expect(document.querySelector("[data-sidebar-history-list='true']"))
      .toHaveAttribute("data-sidebar-history-total-count", "2");

    manualView.unmount();

    renderSidebar({
      recentProjects: projects,
      automationMode: "full-auto",
    });

    expect(document.querySelector("[data-sidebar-history-count='true']")?.textContent?.trim()).toBe("1");
    expect(document.querySelector("[data-sidebar-history-list='true']"))
      .toHaveAttribute("data-sidebar-history-total-count", "1");
  });

  it("filters history cards by effective mode when a snapshot's automationMode is stale", () => {
    const staleSnapshot = createProjectSnapshot(2, {
      automationMode: "manual",
      title: "Stale Snapshot",
    });
    const recentProjectSessions = [
      createProjectSession("project-2", "full-auto", {
        ...staleSnapshot,
        automationMode: "full-auto",
      }),
    ];

    const manualView = renderSidebar({
      recentProjects: [
        createProjectSnapshot(1, { automationMode: "manual", title: "True Manual" }),
        staleSnapshot,
      ],
      recentProjectSessions,
      automationMode: "manual",
    });

    expect(document.querySelector("[data-sidebar-history-count='true']")?.textContent?.trim()).toBe("1");
    expect(screen.getByText("True Manual")).toBeInTheDocument();
    expect(screen.queryByText("Stale Snapshot")).toBeNull();

    manualView.unmount();

    renderSidebar({
      recentProjects: [
        createProjectSnapshot(1, { automationMode: "manual", title: "True Manual" }),
        staleSnapshot,
      ],
      recentProjectSessions,
      automationMode: "full-auto",
    });

    expect(document.querySelector("[data-sidebar-history-count='true']")?.textContent?.trim()).toBe("1");
    expect(screen.getByText("Stale Snapshot")).toBeInTheDocument();
    expect(screen.queryByText("True Manual")).toBeNull();
    expect(document.querySelector("[data-sidebar-history-auto-badge='true']")?.textContent).toContain("AUTO");
  });

  it("uses the stopped full-auto frame on conversation history after auto-run stops", () => {
    renderSidebar({
      recentProjects: [createProjectSnapshot(1)],
      automationMode: "full-auto",
      fullAutoRunStatus: "stopped",
    });

    const historySection = document.querySelector("[data-automation-mode='full-auto']");
    expect(historySection).toHaveClass("home-agent-full-auto-frame-stopped");
  });

  it("lets idle mobile history stretch to the remaining height in both manual and full-auto modes", () => {
    const { rerender } = renderSidebar({
      idle: true,
      recentProjects: [createProjectSnapshot(1)],
      automationMode: "manual",
    });

    let historyList = document.querySelector("[data-sidebar-history-list='true']");
    let historySection = document.querySelector("[data-automation-mode='manual']");
    expect(historyList).toHaveClass("flex-1");
    expect(historyList).not.toHaveClass("max-h-[400px]");
    expect(historySection).toHaveClass("flex", "h-full", "flex-col");

    rerender(
      <MobileSidebarSheet
        open
        onOpenChange={vi.fn()}
        idle
        recentProjects={[createProjectSnapshot(1)]}
        recentProjectsReady
        templates={[]}
        assets={[]}
        brandLabel="StoryForge"
        sheetClassName=""
        onTemplateLaunch={vi.fn()}
        onOpenProject={vi.fn()}
        onNewProject={vi.fn()}
        onOpenSettings={vi.fn()}
        automationMode="full-auto"
        fullAutoRunStatus={null}
      />,
    );

    historyList = document.querySelector("[data-sidebar-history-list='true']");
    historySection = document.querySelector("[data-automation-mode='full-auto']");
    expect(historyList).toHaveClass("flex-1");
    expect(historyList).not.toHaveClass("max-h-[400px]");
    expect(historySection).toHaveClass("flex", "h-full", "flex-col");
  });

  it("lets idle desktop history stretch to the remaining height in both manual and full-auto modes", () => {
    const { rerender } = renderDesktopSidebar({
      idle: true,
      recentProjects: [createProjectSnapshot(1)],
      automationMode: "manual",
    });

    let historyList = document.querySelector("[data-sidebar-history-list='true']");
    let historySection = document.querySelector("[data-automation-mode='manual']");
    expect(historyList).toHaveClass("flex-1");
    expect(historyList).not.toHaveClass("max-h-[400px]");
    expect(historySection).toHaveClass("flex", "h-full", "flex-col");

    rerender(
      <DesktopSidebar
        idle
        recentProjects={[createProjectSnapshot(1)]}
        recentProjectsReady
        templates={[]}
        assets={[]}
        brandLabel="StoryForge"
        expandedWidth={320}
        collapsedWidth={72}
        onTemplateLaunch={vi.fn()}
        onOpenProject={vi.fn()}
        onNewProject={vi.fn()}
        onOpenSettings={vi.fn()}
        onToggleCollapse={vi.fn()}
        automationMode="full-auto"
        fullAutoRunStatus={null}
      />,
    );

    historyList = document.querySelector("[data-sidebar-history-list='true']");
    historySection = document.querySelector("[data-automation-mode='full-auto']");
    expect(historyList).toHaveClass("flex-1");
    expect(historyList).not.toHaveClass("max-h-[400px]");
    expect(historySection).toHaveClass("flex", "h-full", "flex-col");
  });

  it("refreshes the visible history immediately when automation mode changes during project switch settling", () => {
    const manualProject = createProjectSnapshot(1, {
      automationMode: "manual",
      title: "Manual Project",
    });
    const fullAutoProject = createProjectSnapshot(2, {
      automationMode: "full-auto",
      title: "Full Auto Project",
    });
    const recentProjects = [manualProject, fullAutoProject];

    const { rerender } = renderDesktopSidebar({
      idle: true,
      recentProjects,
      currentProjectId: manualProject.projectId,
      currentProjectSnapshot: manualProject,
      automationMode: "manual",
    });

    expect(readHistoryOrder()).toEqual([manualProject.projectId]);

    rerender(
      createDesktopSidebarElement({
        idle: true,
        recentProjects,
        currentProjectId: fullAutoProject.projectId,
        currentProjectSnapshot: fullAutoProject,
        automationMode: "manual",
      }),
    );

    rerender(
      createDesktopSidebarElement({
        idle: true,
        recentProjects,
        currentProjectId: fullAutoProject.projectId,
        currentProjectSnapshot: fullAutoProject,
        automationMode: "full-auto",
      }),
    );

    expect(readHistoryOrder()).toEqual([fullAutoProject.projectId]);
  });

  it("shows extraction progress and completion hints on the matching segment video row", async () => {
    const refreshSpy = vi.fn();
    renderDesktopSidebar({
      currentProjectId: "video-project-1",
      onRefreshSegmentContinuity: refreshSpy,
      assets: [
        createImageAsset(1),
        {
          id: "segment:1-1:video",
          kind: "video",
          label: "绗?闆?路 鐗囨1-1",
          url: "E:\\library\\segment-1-1.mp4",
          meta: "鐗囨",
          origin: "derived",
          subKind: "segment",
          segmentLabel: "1-1",
        },
      ],
    });

    const videoTabButton = screen
      .getAllByRole("button", { name: /瑙嗛/ })
      .find((button) => !(button as HTMLElement).dataset.sidebarSpecialToggle);
    expect(videoTabButton).toBeTruthy();
    fireEvent.click(videoTabButton!);

    const row = await waitFor(() => {
      const candidate = document.querySelector(
        "[data-sidebar-asset-id='segment:1-1:video']",
      ) as HTMLElement | null;
      expect(candidate).not.toBeNull();
      return candidate as HTMLElement;
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("agent:segment-continuity-extraction", {
          detail: {
            projectId: "video-project-1",
            segmentLabel: "1-1",
            status: "extracting",
            progress: 42,
            message: "正在从当前片段视频抽取连续性关键帧…",
            updatedAt: "2026-05-17T10:00:00.000Z",
          },
        }),
      );
    });

    await openAssetMenu("segment:1-1:video");
    await waitFor(() => {
      expect(row.getAttribute("data-sidebar-asset-extraction-status")).toBe("extracting");
      expect(
        row.querySelector("[data-sidebar-asset-extraction-message='true']")?.textContent,
      ).toContain("正在从当前片段视频抽取连续性关键帧");
      const refreshButton = document.querySelector(
        "[role='menuitem'][data-sidebar-segment-refresh='true']",
      ) as HTMLElement | null;
      expect(refreshButton).not.toBeNull();
      expect(refreshButton).toHaveAttribute("data-disabled");
      expect(refreshButton?.getAttribute("data-sidebar-segment-refresh-state")).toBe("extracting");
      expect(refreshButton?.querySelector(".animate-spin")).not.toBeNull();
      expect(
        (row.querySelector("[data-sidebar-asset-extraction-progress='true']") as HTMLElement | null)?.style.width,
      ).toBe("42%");
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("agent:segment-continuity-extraction", {
          detail: {
            projectId: "video-project-1",
            segmentLabel: "1-1",
            status: "completed",
            progress: 100,
            message: "关键帧抽取完成，已保留 4 张连续性参考帧。",
            frameCount: 4,
            updatedAt: "2026-05-17T10:00:01.000Z",
          },
        }),
      );
    });

    await waitFor(() => {
      expect(row.getAttribute("data-sidebar-asset-extraction-status")).toBe("completed");
      expect(
        row.querySelector("[data-sidebar-asset-extraction-message='true']")?.textContent,
      ).toContain("关键帧抽取完成");
      expect(
        (row.querySelector("[data-sidebar-asset-extraction-progress='true']") as HTMLElement | null)?.style.width,
      ).toBe("100%");
    });
  });

  it("shows a persistent six-grid badge on segment videos that already have a continuity grid", async () => {
    renderDesktopSidebar({
      currentProjectId: "video-project-1",
      assets: [
        {
          id: "segment:1-2:video",
          kind: "video",
          label: "第1集·片段1-2",
          url: "E:\\library\\segment-1-2.mp4",
          meta: "片段视频",
          origin: "derived",
          subKind: "segment",
          segmentLabel: "1-2",
          historyEntryId: "history-entry-1",
          continuityGridReady: true,
        },
      ],
    });

    const videoTabButton = screen
      .getAllByRole("button", { name: /瑙嗛/ })
      .find((button) => !(button as HTMLElement).dataset.sidebarSpecialToggle);
    expect(videoTabButton).toBeTruthy();
    fireEvent.click(videoTabButton!);

    const row = await waitFor(() => {
      const candidate = document.querySelector(
        "[data-sidebar-asset-id='segment:1-2:video']",
      ) as HTMLElement | null;
      expect(candidate).not.toBeNull();
      return candidate as HTMLElement;
    });

    expect(
      row.querySelector("[data-sidebar-asset-continuity-badge='true']")?.textContent,
    ).toContain("宸茬粍鍏牸");
  });

  it("shows a missing six-grid hint and exposes a manual refresh action on formal segment videos", async () => {
    const refreshSpy = vi.fn();
    renderDesktopSidebar({
      currentProjectId: "video-project-1",
      onRefreshSegmentContinuity: refreshSpy,
      assets: [
        {
          id: "segment:1-3:video",
          kind: "video",
          label: "第1集·片段1-3",
          url: "E:\\library\\segment-1-3.mp4",
          meta: "片段视频",
          origin: "derived",
          subKind: "segment",
          segmentLabel: "1-3",
        },
      ],
    });

    const videoTabButton = screen
      .getAllByRole("button", { name: /瑙嗛/ })
      .find((button) => !(button as HTMLElement).dataset.sidebarSpecialToggle);
    expect(videoTabButton).toBeTruthy();
    fireEvent.click(videoTabButton!);

    const row = await waitFor(() => {
      const candidate = document.querySelector(
        "[data-sidebar-asset-id='segment:1-3:video']",
      ) as HTMLElement | null;
      expect(candidate).not.toBeNull();
      return candidate as HTMLElement;
    });

    expect(row.querySelector("[data-sidebar-asset-continuity-missing='true']")).not.toBeNull();
    expect(
      row.querySelector("[data-sidebar-asset-continuity-missing='true']")?.textContent,
    ).toContain("寰呯粍鍏牸");

    await openAssetMenu("segment:1-3:video");
    const refreshButton = document.querySelector(
      "[role='menuitem'][data-sidebar-segment-refresh='true']",
    ) as HTMLElement | null;
    expect(refreshButton).not.toBeNull();

    fireEvent.click(refreshButton!);

    expect(refreshSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "segment:1-3:video",
        segmentLabel: "1-3",
      }),
    );
  });

  it("keeps the continuity, history-video, and bundle special actions grouped together", () => {
    renderDesktopSidebar({
      currentProjectId: "video-project-1",
      assets: [
        {
          id: "segment:1-2:continuity-grid",
          kind: "image",
          label: "第1集·片段1-2",
          url: "E:\\library\\segment-1-2-grid.jpg",
          meta: "连续性六宫格",
          origin: "derived",
          subKind: "continuity-grid",
          segmentLabel: "1-2",
        },
        {
          id: "manual:segment-1-2:qa-failed",
          kind: "video",
          label: "缁?闂?璺?閻楀洦顔?-2 璺?QA failed",
          url: "E:\\library\\segment-1-2-qa-failed.mp4",
          meta: "QA failed / archived",
          origin: "manual",
          status: "failed",
          subKind: "history-video",
          segmentLabel: "1-2",
          historyEntryId: "history-entry-1",
        },
      ],
    });

    const shell = document.querySelector("[data-sidebar-special-shell='true']") as HTMLElement | null;
    expect(shell).not.toBeNull();
    expect(shell?.className).toContain("rounded-xl");
    expect(shell?.className).toContain("border");

    const group = document.querySelector("[data-sidebar-special-group='true']") as HTMLElement | null;
    expect(group).not.toBeNull();
    expect(group?.className).toContain("rounded-lg");
    expect(group?.className).toContain("bg-background/60");
    expect(group?.closest("[data-sidebar-special-shell='true']")).toBe(shell);

    const continuityButton = group?.querySelector(
      "[data-sidebar-special-toggle='continuity']",
    ) as HTMLElement | null;
    const historyVideoButton = group?.querySelector(
      "[data-sidebar-special-toggle='history-video']",
    ) as HTMLElement | null;
    const bundleButton = group?.querySelector(
      "[data-sidebar-special-toggle='bundle']",
    ) as HTMLElement | null;

    expect(continuityButton).not.toBeNull();
    expect(historyVideoButton).not.toBeNull();
    expect(bundleButton).not.toBeNull();
    expect(continuityButton?.className).toContain("rounded-md");
    expect(historyVideoButton?.className).toContain("rounded-md");
    expect(bundleButton?.className).toContain("rounded-md");
    expect(group?.firstElementChild).toBe(continuityButton);
    expect(group?.children[1]).toBe(historyVideoButton);
    expect(group?.lastElementChild).toBe(bundleButton);
  });

  it("sorts continuity grids by episode and segment order in the special panel", async () => {
    renderDesktopSidebar({
      currentProjectId: "video-project-1",
      assets: [
        {
          id: "segment:1-4:continuity-grid",
          kind: "image",
          label: "第1集·片段1-4 · 01",
          url: "E:\\library\\segment-1-4-grid.jpg",
          meta: "连续性六宫格",
          origin: "derived",
          subKind: "continuity-grid",
          segmentLabel: "1-4",
        },
        {
          id: "segment:1-1:continuity-grid",
          kind: "image",
          label: "第1集·片段1-1 · 01",
          url: "E:\\library\\segment-1-1-grid.jpg",
          meta: "连续性六宫格",
          origin: "derived",
          subKind: "continuity-grid",
          segmentLabel: "1-1",
        },
        {
          id: "segment:1-3:continuity-grid",
          kind: "image",
          label: "第1集·片段1-3 · 01",
          url: "E:\\library\\segment-1-3-grid.jpg",
          meta: "连续性六宫格",
          origin: "derived",
          subKind: "continuity-grid",
          segmentLabel: "1-3",
        },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "查看前情六宫格" }));

    const panel = await waitFor(
      () => document.querySelector("[data-sidebar-special-panel='continuity']") as HTMLElement | null,
    );
    expect(panel).not.toBeNull();
    expect(getRenderedAssetIds(panel!)).toEqual([
      "segment:1-1:continuity-grid",
      "segment:1-3:continuity-grid",
      "segment:1-4:continuity-grid",
    ]);
  });

  it("shows the full continuity recap paragraph in the continuity-grid lightbox", async () => {
    const recapText =
      "苏辰被叶昊重创后倒在演武场深坑之中，周围弟子的嘲笑与压迫感不断逼近。随着镜头持续缓慢推进，苏辰染血的右手逐渐握紧裂纹木剑，空气中的烟尘与灵气开始异常波动，叶昊也逐渐察觉到危险气息。最终，苏辰缓慢抬头，压抑已久的力量即将彻底觉醒。";

    renderDesktopSidebar({
      currentProjectId: "video-project-1",
      assets: [
        {
          id: "segment:1-2:continuity-grid",
          kind: "image",
          label: "第1集·片段1-2 · 02",
          url: "https://example.com/segment-1-2-grid.jpg",
          meta: "连续性六宫格",
          recapText,
          origin: "derived",
          subKind: "continuity-grid",
          segmentLabel: "1-2",
        },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "查看前情六宫格" }));

    const assetRow = await waitFor(
      () =>
        document.querySelector(
          "[data-sidebar-asset-id='segment:1-2:continuity-grid']",
        ) as HTMLElement | null,
    );
    expect(assetRow).not.toBeNull();
    const assetButton = assetRow?.querySelector(
      "button[aria-label='第1集·片段1-2 · 02']",
    ) as HTMLButtonElement | null;
    expect(assetButton).not.toBeNull();

    fireEvent.click(assetButton!);

    expect(await screen.findByText("片段 1-2 前情六宫格")).toBeTruthy();
    expect(screen.getByText(`前情提要：${recapText}`)).toBeTruthy();
  });

  it("sorts archived history videos by segment order and duplicate sequence", async () => {
    renderDesktopSidebar({
      currentProjectId: "video-project-1",
      assets: [
        {
          id: "segment-history:1-4:history-entry-1",
          kind: "video",
          label: "第1集·片段1-4 · 01",
          url: "E:\\library\\segment-1-4-archived-01.mp4",
          meta: "已归档",
          origin: "derived",
          status: "failed",
          subKind: "history-video",
          segmentLabel: "1-4",
          historyEntryId: "history-entry-1",
          archivedAt: "2026-05-19T11:00:00.000Z",
        },
        {
          id: "segment-history:1-1:history-entry-2",
          kind: "video",
          label: "第1集·片段1-1 · 02",
          url: "E:\\library\\segment-1-1-archived-02.mp4",
          meta: "已归档",
          origin: "derived",
          status: "failed",
          subKind: "history-video",
          segmentLabel: "1-1",
          historyEntryId: "history-entry-2",
          archivedAt: "2026-05-19T11:05:00.000Z",
        },
        {
          id: "segment-history:1-1:history-entry-1",
          kind: "video",
          label: "第1集·片段1-1 · 01",
          url: "E:\\library\\segment-1-1-archived-01.mp4",
          meta: "已归档",
          origin: "derived",
          status: "failed",
          subKind: "history-video",
          segmentLabel: "1-1",
          historyEntryId: "history-entry-1",
          archivedAt: "2026-05-19T11:10:00.000Z",
        },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "鏌ョ湅鍘嗗彶瑙嗛" }));

    const panel = await waitFor(
      () => document.querySelector("[data-sidebar-special-panel='history-video']") as HTMLElement | null,
    );
    expect(panel).not.toBeNull();
    expect(getRenderedAssetIds(panel!)).toEqual([
      "segment-history:1-1:history-entry-1",
      "segment-history:1-1:history-entry-2",
      "segment-history:1-4:history-entry-1",
    ]);
  });

  it("sorts segment videos in the main video list by segment order", async () => {
    renderDesktopSidebar({
      currentProjectId: "video-project-1",
      assets: [
        {
          id: "segment:1-4:video",
          kind: "video",
          label: "绗?闆?路 鐗囨1-4 路 01",
          url: "E:\\library\\segment-1-4.mp4",
          meta: "鐗囨瑙嗛",
          origin: "derived",
          subKind: "segment",
          segmentLabel: "1-4",
        },
        {
          id: "segment:1-1:video",
          kind: "video",
          label: "绗?闆?路 鐗囨1-1 路 01",
          url: "E:\\library\\segment-1-1.mp4",
          meta: "鐗囨瑙嗛",
          origin: "derived",
          subKind: "segment",
          segmentLabel: "1-1",
        },
        {
          id: "segment:1-3:video",
          kind: "video",
          label: "绗?闆?路 鐗囨1-3 路 01",
          url: "E:\\library\\segment-1-3.mp4",
          meta: "鐗囨瑙嗛",
          origin: "derived",
          subKind: "segment",
          segmentLabel: "1-3",
        },
      ],
    });

    const videoTabButton = screen
      .getAllByRole("button", { name: /瑙嗛/ })
      .find((button) => !(button as HTMLElement).dataset.sidebarSpecialToggle);
    expect(videoTabButton).toBeTruthy();
    fireEvent.click(videoTabButton!);

    const panel = await waitFor(
      () => document.querySelector("[data-sidebar-asset-list='video']") as HTMLElement | null,
    );
    expect(panel).not.toBeNull();
    await waitFor(() => {
      expect(getRenderedAssetIds(panel!)).toEqual([
        "segment:1-1:video",
        "segment:1-3:video",
        "segment:1-4:video",
      ]);
    });
  });

  it("promotes archived QA-failed segment videos through the existing add-to-assets flow", async () => {
    const eventSpy = vi.fn();
    window.addEventListener("agent:add-to-assets", eventSpy as EventListener);

    renderDesktopSidebar({
      currentProjectId: "video-project-1",
      assets: [
        {
          id: "manual:segment-1-2:qa-failed",
          kind: "video",
          label: "缁?闂?璺?閻楀洦顔?-2 璺?QA failed",
          url: "E:\\library\\segment-1-2-qa-failed.mp4",
          meta: "QA failed / archived",
          origin: "manual",
          status: "failed",
          subKind: "history-video",
          segmentLabel: "1-2",
          historyEntryId: "history-entry-1",
        },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "鏌ョ湅鍘嗗彶瑙嗛" }));

    await openAssetMenu("manual:segment-1-2:qa-failed");
    const transferButton = await waitFor(() =>
      document.querySelector("[role='menuitem'][data-sidebar-history-transfer='true']") as HTMLElement | null,
    );
    expect(transferButton).not.toBeNull();

    fireEvent.click(transferButton!);

    expect(eventSpy).toHaveBeenCalledTimes(1);
    const customEvent = eventSpy.mock.calls[0]?.[0] as CustomEvent;
    expect(customEvent.detail).toMatchObject({
      url: "E:\\library\\segment-1-2-qa-failed.mp4",
      localPath: "E:\\library\\segment-1-2-qa-failed.mp4",
      fileName: "缁?闂?璺?閻楀洦顔?-2 璺?QA failed",
      kind: "video",
      isHistoricalVersion: true,
      historyEntryId: "history-entry-1",
      target: {
        action: "replace_segment_video",
        projectId: "video-project-1",
        targetId: "1-2",
      },
    });

    window.removeEventListener("agent:add-to-assets", eventSpy as EventListener);
  });

  it("uses larger hit areas and typography for quick task entries", () => {
    renderSidebar({
      idle: true,
      templates: [
        {
          id: "template-1",
          title: "原创剧本",
          description: "从一个想法开始，由 Agent 逐步追问并完善。",
          icon: () => null,
        },
      ],
    });

    const quickTaskHeading = document.querySelector("section .text-\\[11px\\]") as HTMLElement | null;
    expect(quickTaskHeading).toHaveClass("text-[11px]");

    const quickTaskButton = screen.getByRole("button", { name: "原创剧本" });
    expect(quickTaskButton).toHaveClass("rounded-[14px]", "py-2");

    const quickTaskTitle = quickTaskButton.querySelector(".text-\\[13\\.5px\\]") as HTMLElement | null;
    expect(quickTaskTitle).toHaveClass("text-[13.5px]", "leading-5");

    const quickTaskDescription = quickTaskButton.querySelector(".text-\\[12px\\]") as HTMLElement | null;
    expect(quickTaskDescription).toHaveClass("text-[12px]", "leading-5");
  });

  it.skip("keeps quick tasks available while an active session is open", () => {
    const onTemplateLaunch = vi.fn();
    const templates: HomeAgentTemplate[] = [
      {
        id: "adaptation",
        title: "参考改编",
        description: "上传或粘贴参考文本后自动推进。",
        prompt: "我要做参考改编",
        icon: Compass,
        badge: "全自动",
      },
      {
        id: "video",
        title: "视频工作流",
        description: "接入当前剧本后自动推进。",
        prompt: "我要继续视频工作流",
        icon: PanelsTopLeft,
        badge: "全自动",
      },
    ];

    render(
      <MobileSidebarSheet
        open
        onOpenChange={vi.fn()}
        idle={false}
        recentProjects={[createProjectSnapshot(1)]}
        recentProjectsReady
        templates={templates}
        assets={[]}
        currentProjectId="project-1"
        brandLabel="StoryForge"
        sheetClassName=""
        onTemplateLaunch={onTemplateLaunch}
        onOpenProject={vi.fn()}
        onNewProject={vi.fn()}
        onOpenSettings={vi.fn()}
        automationMode="full-auto"
        fullAutoRunStatus={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "视频工作流" }));

    expect(screen.getByRole("button", { name: "参考改编" })).toBeInTheDocument();
    expect(onTemplateLaunch).toHaveBeenCalledWith("video", "我要继续视频工作流", "视频工作流");
  });

  it("keeps quick tasks hidden for active manual sessions", () => {
    render(
      <MobileSidebarSheet
        open
        onOpenChange={vi.fn()}
        idle={false}
        recentProjects={[createProjectSnapshot(1)]}
        recentProjectsReady
        templates={[
          {
            id: "video",
            title: "视频工作流",
            description: "manual should stay focused on the current session",
            prompt: "我要继续视频工作流",
            icon: PanelsTopLeft,
          },
        ]}
        assets={[]}
        currentProjectId="project-1"
        brandLabel="StoryForge"
        sheetClassName=""
        onTemplateLaunch={vi.fn()}
        onOpenProject={vi.fn()}
        onNewProject={vi.fn()}
        onOpenSettings={vi.fn()}
        automationMode="manual"
        fullAutoRunStatus={null}
      />,
    );

    expect(screen.queryByRole("button", { name: "视频工作流" })).not.toBeInTheDocument();
  });
  it("hides quick tasks for active full-auto sessions just like manual mode", () => {
    render(
      <MobileSidebarSheet
        open
        onOpenChange={vi.fn()}
        idle={false}
        recentProjects={[createProjectSnapshot(1)]}
        recentProjectsReady
        templates={[
          {
            id: "adaptation",
            title: "Adaptation",
            description: "full-auto active sessions should stay focused on the selected conversation",
            prompt: "Launch adaptation",
            icon: Compass,
          },
          {
            id: "video",
            title: "Video Workflow",
            description: "full-auto active sessions should not keep quick-task cards visible",
            prompt: "Launch video workflow",
            icon: PanelsTopLeft,
          },
        ]}
        assets={[]}
        currentProjectId="project-1"
        brandLabel="StoryForge"
        sheetClassName=""
        onTemplateLaunch={vi.fn()}
        onOpenProject={vi.fn()}
        onNewProject={vi.fn()}
        onOpenSettings={vi.fn()}
        automationMode="full-auto"
        fullAutoRunStatus={null}
      />,
    );

    expect(screen.queryByRole("button", { name: "Adaptation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Video Workflow" })).not.toBeInTheDocument();
  });

  it("keeps quick tasks visible on the full-auto new-project surface", () => {
    render(
      <MobileSidebarSheet
        open
        onOpenChange={vi.fn()}
        idle
        recentProjects={[createProjectSnapshot(1)]}
        recentProjectsReady
        templates={[
          {
            id: "video",
            title: "Video Workflow",
            description: "full-auto idle should keep entry points available",
            prompt: "Launch video workflow",
            icon: PanelsTopLeft,
          },
        ]}
        assets={[]}
        currentProjectId={undefined}
        brandLabel="StoryForge"
        sheetClassName=""
        onTemplateLaunch={vi.fn()}
        onOpenProject={vi.fn()}
        onNewProject={vi.fn()}
        onOpenSettings={vi.fn()}
        automationMode="full-auto"
        fullAutoRunStatus={null}
      />,
    );

    expect(screen.getByRole("button", { name: "Video Workflow" })).toBeInTheDocument();
  });
});

