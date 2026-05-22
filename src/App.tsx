import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense, lazy, useEffect } from "react";
import { BrowserRouter, HashRouter, Routes, Route, useLocation, useNavigate } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import NotFound from "./pages/NotFound";

const Home = lazy(() => import("./pages/Home"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,   // 5分钟内不重新请求
      gcTime: 10 * 60 * 1000,     // 10分钟后回收缓存
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const isFileProtocol = typeof window !== "undefined" && window.location.protocol === "file:";
const Router = isFileProtocol ? HashRouter : BrowserRouter;
const ROUTER_FUTURE_FLAGS = {
  v7_startTransition: true,
  v7_relativeSplatPath: true,
} as const;

function AppStartupFallback() {
  return (
    <div
      data-home-startup-fallback="true"
      className="flex min-h-screen items-center justify-center bg-[#090b11] px-6 text-slate-100"
    >
      <div className="w-full max-w-[420px] rounded-[28px] border border-white/[0.08] bg-white/[0.03] px-7 py-8 shadow-[0_24px_80px_rgba(0,0,0,0.32)] backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <div className="h-3 w-3 animate-pulse rounded-full bg-[#7c92ff]" />
          <div className="text-[15px] font-semibold tracking-[0.22em] text-slate-200/92">INFINIO</div>
        </div>
        <div className="mt-5 text-[26px] font-semibold leading-tight text-white">正在恢复首页工作台</div>
        <p className="mt-3 text-[14px] leading-7 text-slate-300">
          正在加载当前会话、最近项目和模型设置，首屏准备完成后会自动进入主页。
        </p>
        <div className="mt-6 h-[2px] overflow-hidden rounded-full bg-white/[0.08]">
          <div className="h-full w-1/3 animate-[pulse_1.8s_ease-in-out_infinite] rounded-full bg-[#7c92ff]" />
        </div>
      </div>
    </div>
  );
}

function LegacyHomeRedirect({ utility }: { utility?: "settings" }) {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const search = new URLSearchParams(location.search);
      const shouldLoadHandoff =
        location.pathname === "/script-creator" || location.pathname === "/compliance-review";

      const handoffModule = shouldLoadHandoff ? await import("@/lib/agent-intake") : null;

      if (location.pathname === "/script-creator") {
        const projectId = search.get("id");
        if (projectId && handoffModule) {
          const step = search.get("step");
          const prompt =
            step === "compliance"
              ? "恢复这个历史项目，并优先继续处理合规审查。"
              : "恢复这个历史项目，并给我下一步建议。";

          handoffModule.saveAgentHandoff(
            handoffModule.buildAgentHandoff(prompt, {
              route: "script-creator",
              title: "已从旧链接回到首页会话",
              subtitle:
                "我会直接在首页里恢复这个项目，并根据当前阶段给出下一步建议，不再进入旧工作台。",
              resumeProjectId: projectId,
            }),
          );
        }
      }

      if (location.pathname === "/compliance-review") {
        const taskId = search.get("task");
        if (taskId && handoffModule) {
          const taskHistoryModule = await import("@/lib/task-history");
          const restore = taskHistoryModule.loadComplianceStandaloneRestore(taskId);
          const prompt = restore?.scriptText?.trim()
            ? `请在首页继续我的合规审查任务。以下是待审内容：\n\n${restore.scriptText}`
            : "请在首页继续我的合规审查任务，并先告诉我还缺哪些上下文。";

          handoffModule.saveAgentHandoff(
            handoffModule.buildAgentHandoff(prompt, {
              route: "script-creator",
              title: "已把合规任务收口到首页会话",
              subtitle:
                "后续的风险分析、修订建议和继续追问都会留在同一页完成，不再打开旧审查页面。",
            }),
          );
        }
      }

      search.delete("id");
      search.delete("step");
      search.delete("task");
      search.delete("panel");

      if (utility) {
        search.set("utility", utility);
      } else {
        search.delete("utility");
      }

      if (!cancelled) {
        const query = search.toString();
        navigate({ pathname: "/", search: query ? `?${query}` : "" }, { replace: true });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [location.pathname, location.search, navigate, utility]);

  return null;
}

const App = () => (
  <ThemeProvider attribute="class" defaultTheme="dark" storageKey="storyforge-theme">
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <Router future={ROUTER_FUTURE_FLAGS}>
          <Suspense fallback={<AppStartupFallback />}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/modules" element={<LegacyHomeRedirect />} />
              <Route path="/workspace" element={<LegacyHomeRedirect />} />
              <Route path="/script-creator" element={<LegacyHomeRedirect />} />
              <Route path="/compliance-review" element={<LegacyHomeRedirect />} />
              <Route path="/settings" element={<LegacyHomeRedirect utility="settings" />} />
              <Route path="/history" element={<LegacyHomeRedirect />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </Router>
      </TooltipProvider>
    </QueryClientProvider>
  </ThemeProvider>
);

export default App;
