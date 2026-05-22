const fs = require("fs");
const path = require("path");

function readJson(pathname) {
  return JSON.parse(fs.readFileSync(pathname, "utf8").replace(/^\uFEFF/, ""));
}

function writeJson(pathname, value) {
  fs.writeFileSync(pathname, "\uFEFF" + JSON.stringify(value, null, 2), "utf8");
}

function ensureDir(pathname) {
  fs.mkdirSync(pathname, { recursive: true });
}

function moveFile(sourcePath, targetPath) {
  ensureDir(path.dirname(targetPath));
  fs.renameSync(sourcePath, targetPath);
}

function nowLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate()
  )} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function toPosix(pathname) {
  return pathname.replace(/\\/g, "/");
}

function main() {
  const workspace = "E:/Other/work/22/next-chapter_0.4.3_007";
  const root = `${workspace}/genshin-cn-voice-presets-merged`;
  const archiveRoot = `${workspace}/genshin-cn-voice-presets-merged-pruned-out/strict-pass-20260520`;
  const manifestPath = `${root}/manifest.json`;
  const summaryPath = `${root}/summary.json`;
  const readmePath = `${root}/README.md`;
  const reportPath = `${archiveRoot}/strict-prune-report.json`;

  const pruneList = [
    { category_id: "C05", row_idx: 1699, reason: "语气偏日常小愿望，低温锋利感不足。" },
    { category_id: "C06", row_idx: 3490, reason: "威胁和狠劲更强，和慵懒磁性不够贴合。" },
    { category_id: "C08", row_idx: 4014, reason: "喊话和攻击表演感过强，不像冷感锐薄。" },
    { category_id: "C09", row_idx: 1794, reason: "情绪外放指责感太强，不够温润知性。" },
    { category_id: "C13", row_idx: 395, reason: "悲恸求告感重，不是阴冷轻蔑。" },
    { category_id: "C13", row_idx: 1037, reason: "研究推演感重，反派操控感不足。" },
    { category_id: "C13", row_idx: 1419, reason: "日常询问口吻，不像反派阴冷。" },
    { category_id: "C14", row_idx: 135, reason: "安抚说教感更重，油滑世故不足。" },
    { category_id: "C14", row_idx: 796, reason: "背景说明口吻偏重，不够圆滑商贩感。" },
    { category_id: "C14", row_idx: 1390, reason: "鼓励夸赞感更强，不够油滑世故。" },
    { category_id: "C15", row_idx: 354, reason: "理性分析感偏强，不像低能量疲态。" },
    { category_id: "C15", row_idx: 1135, reason: "场景说明味更重，不够死气沉沉。" },
    { category_id: "C16", row_idx: 2185, reason: "更像幼态轻软，不像病弱虚浮。" },
    { category_id: "C16", row_idx: 2260, reason: "逻辑分析感明显，不像轻气气短。" },
    { category_id: "C16", row_idx: 3252, reason: "庄重誓言感更强，不是病弱状态。" },
    { category_id: "C17", row_idx: 2430, reason: "寓言式叙述偏重，不够市井粗砺。" },
    { category_id: "C17", row_idx: 2638, reason: "仪式说明腔偏重，不像市井大叔。" },
    { category_id: "C17", row_idx: 3047, reason: "立场宣示感较强，烟火气不足。" },
    { category_id: "C18", row_idx: 4, reason: "更贴合萝莉高亮灵动，不够戏精舞台感。" },
    { category_id: "C18", row_idx: 42, reason: "更贴合萝莉高亮灵动，不够戏精舞台感。" },
    { category_id: "C19", row_idx: 179, reason: "偏清冷写景，不够梦呓空灵。" },
    { category_id: "C19", row_idx: 794, reason: "态度干净锋利，不够悬浮空灵。" },
    { category_id: "C19", row_idx: 1135, reason: "票券说明口吻偏实，不够梦呓感。" },
    { category_id: "C20", row_idx: 2315, reason: "回忆叙事感更强，不是怒意爆发。" },
    { category_id: "C20", row_idx: 2682, reason: "评价他人口吻，不是高张力喊话。" },
    { category_id: "C22", row_idx: 4856, reason: "中二宣言感强，不像病娇贴脸。" },
    { category_id: "C23", row_idx: 3470, reason: "生活化请求口吻，不是审讯控场。" },
    { category_id: "C23", row_idx: 8221, reason: "劝诫语气更重，不像冷面审讯。" },
    { category_id: "C23", row_idx: 11032, reason: "日常叙述感明显，不是压声控场。" },
    { category_id: "C24", row_idx: 811, reason: "好奇搭话多于危险牵引。" },
    { category_id: "C24", row_idx: 2415, reason: "舞台退场感更强，不是危险亲近。" },
    { category_id: "C24", row_idx: 2867, reason: "信息判断多于贴近玩味。" },
    { category_id: "C25", row_idx: 2534, reason: "整体更偏青年知性，不像中年沉厚。" },
    { category_id: "C27", row_idx: 5590, reason: "笑场自我介绍偏活泼，不够端雅稳叙。" },
    { category_id: "C27", row_idx: 6572, reason: "青春理想感偏强，不够熟龄稳叙。" },
    { category_id: "C28", row_idx: 2355, reason: "天气感叹口吻，不像师者讲述。" },
  ];

  const manifest = readJson(manifestPath);
  const summary = readJson(summaryPath);
  const byKey = new Map(
    manifest.map((item) => [`${item.category_id}:${item.row_idx}`, item])
  );

  const removed = [];
  for (const prune of pruneList) {
    const key = `${prune.category_id}:${prune.row_idx}`;
    const item = byKey.get(key);
    if (!item) {
      throw new Error(`Missing manifest entry for ${key}`);
    }

    const sourcePath = item.saved_path.replace(/\\/g, "/");
    const relativePath = path.relative(root, sourcePath);
    const archivePath = path.join(archiveRoot, relativePath);

    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Missing file for ${key}: ${sourcePath}`);
    }

    moveFile(sourcePath, archivePath);
    removed.push({
      category_id: item.category_id,
      category_title: item.category_title,
      folder: item.folder,
      row_idx: item.row_idx,
      speaker: item.speaker,
      type: item.type,
      duration_seconds: item.duration_seconds,
      from_path: item.saved_path,
      archive_path: toPosix(archivePath).replace(/\//g, "\\"),
      reason: prune.reason,
    });
  }

  const removeKeys = new Set(pruneList.map((item) => `${item.category_id}:${item.row_idx}`));
  const nextManifest = manifest.filter(
    (item) => !removeKeys.has(`${item.category_id}:${item.row_idx}`)
  );

  const countByCategory = new Map();
  for (const item of nextManifest) {
    countByCategory.set(
      item.category_id,
      (countByCategory.get(item.category_id) || 0) + 1
    );
  }

  summary.built_at = nowLocal();
  summary.merge_strategy =
    "Curated merge with similarity pruning, high-contrast archetype additions, restored age-layer timbres, and a final strict pass that removes clips whose performance no longer matches the target folder name closely enough.";
  summary.total_downloaded_files = nextManifest.length;
  summary.category_counts = summary.category_counts.map((item) => ({
    ...item,
    count: countByCategory.get(item.id) || 0,
  }));

  writeJson(manifestPath, nextManifest);
  writeJson(summaryPath, summary);

  const lines = [];
  lines.push("# Genshin Chinese Voice Preset Library - Merged Curated Edition");
  lines.push("");
  lines.push(`- Primary source: ${summary.primary_audio_source}`);
  lines.push(`- Built at: ${summary.built_at}`);
  lines.push(`- Total files: ${summary.total_downloaded_files}`);
  lines.push(
    "- Goal: maximize audible separation between folders, then keep only clips that still sound close enough to the folder name after a stricter second-pass review."
  );
  lines.push(`- Strict-pass archive: ${archiveRoot.replace(/\//g, "\\")}`);
  lines.push("");
  lines.push("## Kept Categories");
  lines.push("");
  for (const item of summary.category_counts) {
    lines.push(
      `- [${item.group_path.join(" / ")}] ${item.folder}: ${item.count} files`
    );
    lines.push(`  Description: ${item.description}`);
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push(
    "- This pass does not try to refill folders back to 5 items. It only removes entries that no longer feel close enough to the folder label."
  );
  lines.push(
    "- Stronger role/performance folders were pruned more aggressively than base timbre folders, because wording and acting style matter more there."
  );
  lines.push(
    "- Removed files were moved out of the main library instead of deleted, so they can still be reviewed or reused later."
  );
  lines.push(
    "- `manifest.json` keeps the surviving dataset row ids for traceability."
  );
  fs.writeFileSync(readmePath, "\uFEFF" + lines.join("\n"), "utf8");

  writeJson(reportPath, {
    pruned_at: summary.built_at,
    removed_count: removed.length,
    archive_root: archiveRoot.replace(/\//g, "\\"),
    removed,
  });

  console.log(
    JSON.stringify(
      {
        total_remaining: nextManifest.length,
        removed_count: removed.length,
        archive_root: archiveRoot.replace(/\//g, "\\"),
      },
      null,
      2
    )
  );
}

main();
