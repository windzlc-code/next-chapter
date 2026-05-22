import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import type { SidebarAssetItem } from "./home-agent-sidebar-utils";
import { DesktopSidebar } from "./home-agent-sidebar";

function createImageAsset(
  index: number,
  overrides: Partial<Extract<SidebarAssetItem, { kind: "image" }>> = {},
): SidebarAssetItem {
  return {
    id: `asset-${index}`,
    kind: "image",
    label: `角色素材 ${index}`,
    url: `https://example.com/assets/${index}.jpg`,
    meta: "角色",
    origin: "derived",
    ...overrides,
  };
}

async function findAssetRow(assetId: string) {
  return waitFor(() => {
    const candidate = document.querySelector(
      `[data-sidebar-asset-id='${assetId}']`,
    ) as HTMLElement | null;
    expect(candidate).not.toBeNull();
    return candidate as HTMLElement;
  });
}

function renderDesktopSidebar({
  assets,
  onUploadCharacterAudioReference,
  onRemoveCharacterAudioReference,
}: {
  assets: SidebarAssetItem[];
  onUploadCharacterAudioReference?: (characterId: string, characterName?: string) => void;
  onRemoveCharacterAudioReference?: (characterId: string, characterName?: string) => void;
}) {
  const noop = vi.fn();
  return render(
    <DesktopSidebar
      idle={false}
      recentProjects={[]}
      recentProjectSessions={[]}
      recentProjectsReady
      templates={[]}
      assets={assets}
      brandLabel="StoryForge"
      expandedWidth={320}
      collapsedWidth={72}
      onTemplateLaunch={noop}
      onOpenProject={noop}
      onNewProject={noop}
      onOpenSettings={noop}
      onToggleCollapse={noop}
      onUploadCharacterAudioReference={onUploadCharacterAudioReference}
      onRemoveCharacterAudioReference={onRemoveCharacterAudioReference}
    />,
  );
}

describe("home-agent-sidebar audio menu", () => {
  it("keeps the desktop asset menu configured to open on the left", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/home-agent/home-agent-sidebar.tsx"),
      "utf8",
    );

    expect(source).toContain('side={isMobile ? "bottom" : "left"}');
    expect(source).toContain('align={isMobile ? "end" : "center"}');
  });

  it("wires upload, play, and confirmed remove character audio actions from the asset row", async () => {
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
    let view: ReturnType<typeof renderDesktopSidebar> | null = null;

    try {
      view = renderDesktopSidebar({
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

      const row = await findAssetRow("asset-1");
      const menuTrigger = row.querySelector(
        "[data-sidebar-asset-menu-trigger='true']",
      ) as HTMLButtonElement | null;
      const uploadButton = row.querySelector(
        "[data-sidebar-asset-upload-audio='true']",
      ) as HTMLButtonElement | null;
      const playButton = row.querySelector(
        "[data-sidebar-asset-play-audio='true']",
      ) as HTMLButtonElement | null;
      const removeButton = row.querySelector(
        "[data-sidebar-asset-remove-audio='true']",
      ) as HTMLButtonElement | null;

      expect(menuTrigger).not.toBeNull();
      expect(uploadButton).not.toBeNull();
      expect(playButton).not.toBeNull();
      expect(removeButton).not.toBeNull();

      fireEvent.click(uploadButton!);
      expect(onUploadCharacterAudioReference).toHaveBeenCalledWith("char-1", "林萧");

      fireEvent.click(playButton!);
      await waitFor(() => {
        expect(playSpy).toHaveBeenCalled();
      });

      fireEvent.click(removeButton!);
      expect(onRemoveCharacterAudioReference).not.toHaveBeenCalled();
      expect(document.body).toHaveTextContent("确认移除当前音频参考？");
      fireEvent.click(screen.getByRole("button", { name: "删除" }));
      expect(onRemoveCharacterAudioReference).toHaveBeenCalledWith("char-1", "林萧");
      expect(pauseSpy).toHaveBeenCalled();
    } finally {
      view?.unmount();
      playSpy.mockRestore();
      pauseSpy.mockRestore();
    }
  });

  it("shares play pause state across duplicate asset rows for the same character audio", async () => {
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
    let view: ReturnType<typeof renderDesktopSidebar> | null = null;

    try {
      view = renderDesktopSidebar({
        assets: [
          createImageAsset(1, {
            label: "角色 · 林萧",
            characterAudioTargetId: "char-1",
            characterAudioTargetName: "林萧",
            characterAudioUrl: "file:///assets/linxiao-reference.wav",
            characterAudioFileName: "linxiao-reference.wav",
            characterAudioReferenceReady: true,
          }),
          createImageAsset(2, {
            label: "角色变体 · 林萧",
            characterAudioTargetId: "char-1",
            characterAudioTargetName: "林萧",
            characterAudioUrl: "file:///assets/linxiao-reference.wav",
            characterAudioFileName: "linxiao-reference.wav",
            characterAudioReferenceReady: true,
          }),
        ],
      });

      const firstRow = await findAssetRow("asset-1");
      const firstPlayButton = firstRow.querySelector(
        "[data-sidebar-asset-play-audio='true']",
      ) as HTMLButtonElement | null;
      expect(firstPlayButton).not.toBeNull();

      fireEvent.click(firstPlayButton!);
      await waitFor(() => {
        expect(playSpy).toHaveBeenCalled();
      });

      const secondRow = await findAssetRow("asset-2");
      const secondPlayButton = secondRow.querySelector(
        "[data-sidebar-asset-play-audio='true']",
      ) as HTMLButtonElement | null;
      expect(secondPlayButton).not.toBeNull();
      expect(secondPlayButton).toHaveAttribute("aria-label", expect.stringContaining("暂停"));

      fireEvent.click(secondPlayButton!);
      expect(pauseSpy).toHaveBeenCalled();
    } finally {
      view?.unmount();
      playSpy.mockRestore();
      pauseSpy.mockRestore();
    }
  });

  it("marks audio playback menu actions to stay open while other actions still close the menu", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/home-agent/home-agent-sidebar.tsx"),
      "utf8",
    );

    expect(source).toContain('key: "play-character-audio"');
    expect(source).toContain("closeMenuOnSelect: false");
    expect(source).toContain("if (options?.closeMenuOnSelect !== false)");
    expect(source).toContain("setMenuOpen(false);");
  });
});
