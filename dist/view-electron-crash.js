// 在浏览器控制台运行此脚本查看 Electron 渲染进程崩溃日志

(async function viewElectronCrashLogs() {
  console.log('🔍 正在读取 Electron 崩溃日志...');

  try {
    // 检查是否在 Electron 环境
    if (!window.electronAPI) {
      console.error('❌ 不在 Electron 环境中');
      return;
    }

    // 读取崩溃日志
    const result = await window.electronAPI.invoke('crash:getLogs');

    if (!result.ok) {
      console.error('❌ 读取崩溃日志失败:', result.error);
      return;
    }

    const logs = result.logs || [];

    console.log('=== Electron 渲染进程崩溃日志 ===');
    console.log(`共 ${logs.length} 条记录\n`);

    if (logs.length === 0) {
      console.log('✅ 没有崩溃记录');
      return logs;
    }

    logs.forEach((log, index) => {
      console.log(`\n--- 崩溃 #${index + 1} ---`);
      console.log(`时间: ${log.timestamp}`);
      console.log(`原因: ${log.reason}`);
      console.log(`退出码: ${log.exitCode}`);
    });

    console.log('\n=== 日志结束 ===');
    console.log('\n💡 崩溃原因说明:');
    console.log('  - crashed: 渲染进程崩溃（通常是内存溢出或 GPU 问题）');
    console.log('  - killed: 进程被强制终止');
    console.log('  - oom: 内存不足（Out of Memory）');
    console.log('  - launch-failed: 启动失败');
    console.log('  - integrity-failure: 完整性检查失败');

    return logs;
  } catch (err) {
    console.error('❌ 读取崩溃日志时出错:', err);
  }
})();
