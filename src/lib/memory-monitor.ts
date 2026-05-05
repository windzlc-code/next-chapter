/**
 * 内存监控和自动清理
 * 防止图片加载导致的内存溢出
 */

let lastCleanup = Date.now();
const CLEANUP_INTERVAL = 30000;

type PerformanceWithMemory = Performance & {
  memory?: {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  };
};

export function monitorMemory() {
  const memory = (performance as PerformanceWithMemory).memory;
  if (!memory) return;

  const used = memory.usedJSHeapSize;
  const limit = memory.jsHeapSizeLimit;
  const usagePercent = (used / limit) * 100;

  if (usagePercent > 70) {
    console.warn(`⚠️ 内存使用过高 ${usagePercent.toFixed(1)}%，触发自动清理`);
    cleanupMemory();
  }

  return { used, total: memory.totalJSHeapSize, limit, usagePercent };
}

export function cleanupMemory() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;

  lastCleanup = now;

  try {
    if (global.gc) global.gc();

    const keysToCheck = [
      'generating-tasks',
      'generating-storyboard-tasks',
      'phase1-results',
      'decompose-meta',
    ];

    keysToCheck.forEach(key => {
      try {
        const value = localStorage.getItem(key);
        if (value && value.length > 100000) {
          localStorage.removeItem(key);
        }
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }
}

export function startMemoryMonitoring() {
  const interval = setInterval(monitorMemory, CLEANUP_INTERVAL);

  // 使用 pagehide 替代 beforeunload，更可靠
  window.addEventListener('pagehide', () => clearInterval(interval), { once: true });

  return interval;
}
