import * as React from "react";
import {
  hydrateHomeAgentCloudSharedState,
  startHomeAgentCloudSharedStateSync,
} from "@/lib/home-agent/cloud-shared-state";
import { hydrateConversationArchivesFromCloud } from "@/lib/home-agent/conversation-archive";
import HomeStudioStartupFallback from "./HomeStudioStartupFallback";

type HomeAgentStudioProps = React.ComponentProps<typeof import("./HomeAgentStudio")["default"]>;

const LazyHomeAgentStudio = React.lazy(() => import("./HomeAgentStudio"));

export default function HomeAgentStudioBootstrap(props: HomeAgentStudioProps) {
  const [shouldLoadStudio, setShouldLoadStudio] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    let frameA = 0;
    let frameB = 0;
    let timer = 0;
    let stopCloudSync: (() => void) | null = null;

    const activate = () => {
      if (cancelled) return;
      React.startTransition(() => {
        setShouldLoadStudio(true);
      });
    };

    const boot = async () => {
      await hydrateHomeAgentCloudSharedState();
      await hydrateConversationArchivesFromCloud();
      if (cancelled) return;
      stopCloudSync = startHomeAgentCloudSharedStateSync();
      frameA = window.requestAnimationFrame(() => {
        frameB = window.requestAnimationFrame(() => {
          activate();
        });
      });
      timer = window.setTimeout(activate, 120);
    };

    void boot();

    return () => {
      cancelled = true;
      stopCloudSync?.();
      if (frameA) window.cancelAnimationFrame(frameA);
      if (frameB) window.cancelAnimationFrame(frameB);
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  if (!shouldLoadStudio) {
    return (
      <HomeStudioStartupFallback
        dataAttribute="data-home-studio-bootstrap-fallback"
        description="基础外壳已就绪，正在加载工作台核心模块。"
      />
    );
  }

  return (
    <React.Suspense
      fallback={
        <HomeStudioStartupFallback
          dataAttribute="data-home-studio-deferred-fallback"
          description="正在加载最近项目和会话恢复状态，工作台会自动接入。"
        />
      }
    >
      <LazyHomeAgentStudio {...props} />
    </React.Suspense>
  );
}
