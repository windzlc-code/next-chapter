import * as React from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

const { Suspense, lazy, memo, useEffect, useRef, useState } = React;

const SETTINGS_PANEL_CLASS =
  "rounded-[28px] border border-border bg-background text-foreground shadow-[0_28px_70px_rgba(0,0,0,0.55)]";
const MOBILE_SETTINGS_SHEET =
  "w-full border-r border-border bg-background p-0 text-foreground shadow-[18px_0_48px_rgba(0,0,0,0.4)] overscroll-contain sm:max-w-[440px]";
const loadSettingsPage = () => import("@/pages/Settings");
const SettingsPage = lazy(loadSettingsPage);
let settingsPagePreloadPromise: Promise<unknown> | null = null;
let settingsPageWarmupScheduled = false;

function preloadSettingsPage() {
  if (!settingsPagePreloadPromise) {
    settingsPagePreloadPromise = loadSettingsPage();
  }
  return settingsPagePreloadPromise;
}

function scheduleSettingsPageWarmup() {
  if (settingsPageWarmupScheduled || typeof window === "undefined") return;
  settingsPageWarmupScheduled = true;
  const warm = () => {
    void preloadSettingsPage();
  };
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(warm);
    return;
  }
  window.setTimeout(warm, 0);
}

scheduleSettingsPageWarmup();

function useWarmSettingsPage() {
  useEffect(() => {
    if (typeof window === "undefined") {
      void preloadSettingsPage();
      return;
    }

    const warm = () => {
      void preloadSettingsPage();
    };
    let quickWarmFrame: number | null =
      typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame(() => warm())
        : null;
    let quickWarmTimer: number | null = window.setTimeout(warm, 180);

    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(warm, { timeout: 500 });
      return () => {
        if (quickWarmFrame !== null && typeof window.cancelAnimationFrame === "function") {
          window.cancelAnimationFrame(quickWarmFrame);
          quickWarmFrame = null;
        }
        if (quickWarmTimer !== null) {
          window.clearTimeout(quickWarmTimer);
          quickWarmTimer = null;
        }
        if (typeof window.cancelIdleCallback === "function") {
          window.cancelIdleCallback(handle);
        }
      };
    }

    return () => {
      if (quickWarmFrame !== null && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(quickWarmFrame);
      }
      if (quickWarmTimer !== null) {
        window.clearTimeout(quickWarmTimer);
      }
    };
  }, []);
}

export const DesktopSettingsPanel = memo(function DesktopSettingsPanel({
  open,
  onClose,
  onSaved,
  leftOffset,
  width,
}: {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  leftOffset: number;
  width: number;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const [hasOpenedOnce, setHasOpenedOnce] = useState(open);
  useWarmSettingsPage();

  useEffect(() => {
    if (open) {
      setHasOpenedOnce(true);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;

      const targetElement = target instanceof Element ? target : target.parentElement;
      if (targetElement?.closest("[data-settings-floating-root='true']")) return;

      // Clicks on the home desktop sidebar (including the settings toggle) must not count as
      // "outside" the panel — otherwise pointerdown closes and the button click re-opens.
      if (targetElement?.closest("[data-home-desktop-sidebar='true']")) return;

      onClose();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [onClose, open]);

  if (!open && !hasOpenedOnce) return null;

  return (
    <aside
      ref={panelRef}
      data-home-settings-panel="desktop"
      aria-hidden={!open}
      className={cn(
        "fixed bottom-4 top-4 z-50 hidden transition-opacity duration-150 ease-out lg:block",
        open ? "visible pointer-events-auto opacity-100" : "invisible pointer-events-none opacity-0",
      )}
      style={{
        left: leftOffset - 16,
        width: `min(${width}px, calc(100vw - ${leftOffset + 32}px))`,
      }}
    >
      <div className={cn("flex h-full min-h-0 flex-col overflow-hidden", SETTINGS_PANEL_CLASS)}>
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              正在加载设置面板…
            </div>
          }
        >
          <SettingsPage embedded onClose={onClose} onSaved={onSaved} />
        </Suspense>
      </div>
    </aside>
  );
});

export const MobileSettingsSheet = memo(function MobileSettingsSheet({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}) {
  const isMobile = useIsMobile();
  const [hasOpenedOnce, setHasOpenedOnce] = useState(open);
  useWarmSettingsPage();

  useEffect(() => {
    if (open) {
      setHasOpenedOnce(true);
    }
  }, [open]);

  if (!isMobile) return null;
  if (!open && !hasOpenedOnce) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        data-home-settings-panel="mobile"
        forceMount
        side="left"
        overlayClassName="bg-black/58 backdrop-blur-0"
        className={cn(MOBILE_SETTINGS_SHEET, "lg:hidden")}
      >
        <SheetHeader className="sr-only">
          <SheetTitle>设置</SheetTitle>
          <SheetDescription>在首页内完成模型、密钥、路径与外观设置。</SheetDescription>
        </SheetHeader>
        <Suspense
          fallback={
            <div className="flex min-h-[220px] items-center justify-center px-6 py-10 text-sm text-muted-foreground">
              正在加载设置面板…
            </div>
          }
        >
          <SettingsPage embedded onClose={() => onOpenChange(false)} onSaved={onSaved} />
        </Suspense>
      </SheetContent>
    </Sheet>
  );
});
