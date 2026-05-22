import "./polyfills";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { API_CONFIG_UPDATED_EVENT, queueApiConfigSyncToServerProxy } from "./lib/api-config";
import { installGlobalErrorHandler } from "./lib/global-error-handler";
import { autoCleanupOnStartup } from "./lib/safe-storage";
import { startMemoryMonitoring } from "./lib/memory-monitor";

// 清理可能损坏的 localStorage 数据
autoCleanupOnStartup();

// 启动内存监控
startMemoryMonitoring();

installGlobalErrorHandler();

if (typeof window !== "undefined") {
  queueApiConfigSyncToServerProxy();
  window.addEventListener(API_CONFIG_UPDATED_EVENT, () => {
    queueApiConfigSyncToServerProxy();
  });
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Home root container is missing.");
}

createRoot(rootElement).render(<App />);

const clearBootSplash = () => {
  document.getElementById("boot-splash")?.remove();
};

window.requestAnimationFrame(() => {
  window.requestAnimationFrame(clearBootSplash);
});
