// 安全的 localStorage 读取工具
// 用于防止损坏的数据导致应用崩溃

export function safeGetLocalStorage<T>(key: string, defaultValue: T): T {
  try {
    const item = localStorage.getItem(key);
    if (!item) return defaultValue;

    if (typeof defaultValue === 'string') {
      return item as T;
    }

    return JSON.parse(item) as T;
  } catch {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
    return defaultValue;
  }
}

// 写入节流缓存，防止同一 key 在短时间内重复写入
const writeThrottleCache = new Map<string, { value: string; timer: ReturnType<typeof setTimeout> }>();
const WRITE_THROTTLE_MS = 300;

export function safeSetLocalStorage<T>(key: string, value: T, throttle = false): boolean {
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);

    if (throttle) {
      const existing = writeThrottleCache.get(key);
      if (existing) {
        clearTimeout(existing.timer);
      }
      const timer = setTimeout(() => {
        try { localStorage.setItem(key, serialized); } catch { /* ignore */ }
        writeThrottleCache.delete(key);
      }, WRITE_THROTTLE_MS);
      writeThrottleCache.set(key, { value: serialized, timer });
      return true;
    }

    localStorage.setItem(key, serialized);
    return true;
  } catch {
    return false;
  }
}

export function safeRemoveLocalStorage(key: string): boolean {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function cleanupCorruptedStorage(keys: string[]): number {
  let cleaned = 0;
  for (const key of keys) {
    try {
      const item = localStorage.getItem(key);
      if (item) JSON.parse(item);
    } catch {
      try {
        localStorage.removeItem(key);
        cleaned++;
      } catch { /* ignore */ }
    }
  }
  return cleaned;
}

export function autoCleanupOnStartup() {
  const keysToCheck = [
    'generating-tasks',
    'generating-storyboard-tasks',
    'phase1-results',
    'decompose-meta',
    'charImg-generating',
    'sceneImg-generating',
    'charDesc-generating',
    'sceneDesc-generating',
  ];

  const stringKeys = ['char-image-model', 'char-view-mode', 'custom-art-style-prompt'];
  stringKeys.forEach(key => {
    try {
      const value = localStorage.getItem(key);
      if (value) {
        try {
          JSON.parse(value);
          localStorage.removeItem(key);
        } catch { /* 正确的纯字符串格式，保留 */ }
      }
    } catch { /* ignore */ }
  });

  cleanupCorruptedStorage(keysToCheck);
}
