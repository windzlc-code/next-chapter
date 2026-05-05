import "./polyfills";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { installGlobalErrorHandler } from "./lib/global-error-handler";
import { autoCleanupOnStartup } from "./lib/safe-storage";
import { startMemoryMonitoring } from "./lib/memory-monitor";

// 清理可能损坏的 localStorage 数据
autoCleanupOnStartup();

// 启动内存监控
startMemoryMonitoring();

installGlobalErrorHandler();

createRoot(document.getElementById("root")!).render(<App />);
