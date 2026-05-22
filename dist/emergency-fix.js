// 紧急修复脚本 - 在浏览器控制台运行
// 用于快速清理所有可能导致闪退的数据

(function emergencyFix() {
  console.log('🔧 开始紧急修复...');

  // 1. 清理所有生成任务相关的 localStorage
  const keysToClean = [
    'generating-tasks',
    'generating-storyboard-tasks',
    'phase1-results',
    'decompose-meta',
    'charImg-generating',
    'sceneImg-generating',
    'charDesc-generating',
    'sceneDesc-generating',
    'char-image-model',
    'char-view-mode',
    'custom-art-style-prompt',
  ];

  let cleaned = 0;
  let corrupted = 0;

  keysToClean.forEach(key => {
    try {
      const value = localStorage.getItem(key);
      if (value) {
        // 尝试解析 JSON
        try {
          JSON.parse(value);
          // 即使能解析,也清理生成任务相关的数据
          if (key.includes('generating') || key.includes('phase') || key.includes('decompose')) {
            localStorage.removeItem(key);
            cleaned++;
            console.log(`✅ 已清理: ${key}`);
          }
        } catch {
          // JSON 解析失败,说明数据损坏
          localStorage.removeItem(key);
          corrupted++;
          console.log(`🔥 已清理损坏数据: ${key}`);
        }
      }
    } catch (err) {
      console.warn(`⚠️ 无法处理 ${key}:`, err);
    }
  });

  // 2. 清理 IndexedDB 中可能的大数据
  if (window.indexedDB) {
    try {
      indexedDB.databases().then(dbs => {
        dbs.forEach(db => {
          if (db.name && (db.name.includes('workspace') || db.name.includes('project'))) {
            console.log(`🗑️ 发现数据库: ${db.name}`);
          }
        });
      });
    } catch (err) {
      console.log('无法列出 IndexedDB 数据库');
    }
  }

  // 3. 清理 sessionStorage
  try {
    const sessionKeys = ['imported-script', 'decompose-meta'];
    sessionKeys.forEach(key => {
      if (sessionStorage.getItem(key)) {
        sessionStorage.removeItem(key);
        console.log(`✅ 已清理 sessionStorage: ${key}`);
      }
    });
  } catch (err) {
    console.warn('无法清理 sessionStorage:', err);
  }

  console.log('\n📊 修复统计:');
  console.log(`  - 清理的键: ${cleaned}`);
  console.log(`  - 损坏的数据: ${corrupted}`);
  console.log(`  - 总计: ${cleaned + corrupted}`);

  if (cleaned + corrupted > 0) {
    console.log('\n✅ 修复完成!请刷新页面 (F5 或 Ctrl+R)');
    console.log('如果问题仍然存在,请尝试:');
    console.log('  1. 完全关闭应用');
    console.log('  2. 清除浏览器缓存');
    console.log('  3. 重新启动应用');
  } else {
    console.log('\n✅ 未发现需要清理的数据');
  }

  return {
    cleaned,
    corrupted,
    total: cleaned + corrupted
  };
})();
