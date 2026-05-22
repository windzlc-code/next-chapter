// 全局崩溃日志记录器 - 在应用启动前加载
// 捕获所有错误并保存到 localStorage，即使页面闪退也能查看

(function() {
  const CRASH_LOG_KEY = 'crash-logs';
  const MAX_LOGS = 50;

  // 获取现有日志
  function getLogs() {
    try {
      const logs = localStorage.getItem(CRASH_LOG_KEY);
      return logs ? JSON.parse(logs) : [];
    } catch {
      return [];
    }
  }

  // 保存日志
  function saveLog(log) {
    try {
      const logs = getLogs();
      logs.unshift({
        ...log,
        timestamp: new Date().toISOString(),
        url: window.location.href,
        userAgent: navigator.userAgent
      });

      // 只保留最近的日志
      if (logs.length > MAX_LOGS) {
        logs.length = MAX_LOGS;
      }

      localStorage.setItem(CRASH_LOG_KEY, JSON.stringify(logs, null, 2));

      // 同时输出到控制台
      console.error('💥 崩溃日志已保存:', log);
    } catch (err) {
      console.error('无法保存崩溃日志:', err);
    }
  }

  // 捕获未处理的错误
  window.addEventListener('error', function(event) {
    saveLog({
      type: 'error',
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      stack: event.error?.stack
    });
  });

  // 捕获未处理的 Promise 拒绝
  window.addEventListener('unhandledrejection', function(event) {
    saveLog({
      type: 'unhandledRejection',
      reason: event.reason?.toString(),
      stack: event.reason?.stack
    });
  });

  // 捕获 React 错误边界未捕获的错误
  const originalConsoleError = console.error;
  console.error = function(...args) {
    // 检查是否是 React 错误
    const message = args.join(' ');
    if (message.includes('React') || message.includes('component')) {
      saveLog({
        type: 'console.error',
        message: message,
        args: args.map(arg => {
          try {
            return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
          } catch {
            return String(arg);
          }
        })
      });
    }
    originalConsoleError.apply(console, args);
  };

  // 提供查看日志的函数
  window.viewCrashLogs = function() {
    const logs = getLogs();
    console.log('=== 崩溃日志 ===');
    console.log(`共 ${logs.length} 条记录\n`);

    if (logs.length === 0) {
      console.log('✅ 没有崩溃记录');
      return;
    }

    logs.forEach((log, index) => {
      console.log(`\n--- 日志 #${index + 1} ---`);
      console.log(`时间: ${log.timestamp}`);
      console.log(`类型: ${log.type}`);
      console.log(`URL: ${log.url}`);
      console.log(`消息: ${log.message || log.reason}`);
      if (log.filename) {
        console.log(`文件: ${log.filename}:${log.lineno}:${log.colno}`);
      }
      if (log.stack) {
        console.log(`堆栈:\n${log.stack}`);
      }
    });

    console.log('\n=== 日志结束 ===');
    console.log('提示: 运行 clearCrashLogs() 清除所有日志');

    return logs;
  };

  // 提供清除日志的函数
  window.clearCrashLogs = function() {
    localStorage.removeItem(CRASH_LOG_KEY);
    console.log('✅ 已清除所有崩溃日志');
  };

  // 启动时显示提示
  console.log('🛡️ 崩溃日志记录器已启动');
  console.log('💡 使用 viewCrashLogs() 查看崩溃日志');
  console.log('💡 使用 clearCrashLogs() 清除日志');

  // 检查是否有旧日志
  const existingLogs = getLogs();
  if (existingLogs.length > 0) {
    console.warn(`⚠️ 发现 ${existingLogs.length} 条历史崩溃日志，运行 viewCrashLogs() 查看`);
  }
})();
