const fs = require("fs");
const path = require("path");
const cp = require("child_process");

function readJson(pathname) {
  return JSON.parse(fs.readFileSync(pathname, "utf8").replace(/^\uFEFF/, ""));
}

function writeJson(pathname, value) {
  fs.writeFileSync(pathname, "\uFEFF" + JSON.stringify(value, null, 2), "utf8");
}

function durationSeconds(pathname) {
  const out = cp
    .execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=nw=1:nk=1",
        pathname,
      ],
      { encoding: "utf8" }
    )
    .trim();
  return Math.round(parseFloat(out) * 1000) / 1000;
}

function ensureDir(pathname) {
  fs.mkdirSync(pathname, { recursive: true });
}

function copyFile(sourcePath, targetPath) {
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
}

function nowLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate()
  )} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function main() {
  const workspace = "E:/Other/work/22/next-chapter_0.4.3_007";
  const root = `${workspace}/genshin-cn-voice-presets-merged`;
  const manifestPath = `${root}/manifest.json`;
  const summaryPath = `${root}/summary.json`;
  const readmePath = `${root}/README.md`;
  const metadataPath = `${workspace}/temp/female_age_metadata.json`;

  const manifest = readJson(manifestPath).filter(
    (item) => !["C27", "C28"].includes(item.category_id)
  );
  const summary = readJson(summaryPath);
  summary.category_counts = summary.category_counts.filter(
    (item) => !["C27", "C28"].includes(item.id)
  );

  const metadata = readJson(metadataPath);
  const metaByRow = new Map(metadata.map((item) => [item.row_idx, item]));

  const additions = [
    {
      category_id: "C27",
      source_category_id: "B_F09",
      category_group_path: "基础音色/女声",
      category_title: "熟龄女 端雅稳叙",
      folder: "07_熟龄女_端雅稳叙",
      description:
        "更像经历过事的成熟女声，气息更稳、句子更长，不走御姐冷压或慵懒磁性。",
      files: [
        {
          row_idx: 4165,
          source_path: `${workspace}/temp/female_age_probe/Ningguang_4165.wav`,
          saved_path: `${root}/基础音色/女声/07_熟龄女_端雅稳叙/01_Ningguang_vo_ningguang_teammate_yaoyao_01.wav`,
        },
        {
          row_idx: 4129,
          source_path: `${workspace}/temp/female_age_probe/Navia_4129.wav`,
          saved_path: `${root}/基础音色/女声/07_熟龄女_端雅稳叙/02_Navia_vo_FDAQ005_2_navia_02.wav`,
        },
        {
          row_idx: 6127,
          source_path: `${workspace}/temp/female_age_probe/Ningguang_6127.wav`,
          saved_path: `${root}/基础音色/女声/07_熟龄女_端雅稳叙/03_Ningguang_vo_ningguang_dialog_idle_02.wav`,
        },
        {
          row_idx: 5590,
          source_path: `${workspace}/temp/female_age_probe3/Navia_5590.wav`,
          saved_path: `${root}/基础音色/女声/07_熟龄女_端雅稳叙/04_Navia_vo_FDAQ003_17_navia_02.wav`,
        },
        {
          row_idx: 6572,
          source_path: `${workspace}/temp/female_age_probe/Nilou_6572.wav`,
          saved_path: `${root}/基础音色/女声/07_熟龄女_端雅稳叙/05_Nilou_vo_nilou_friendship_02.wav`,
        },
      ],
    },
    {
      category_id: "C28",
      source_category_id: "B_F10",
      category_group_path: "基础音色/女声",
      category_title: "长者女 师者讲述",
      folder: "08_长者女_师者讲述",
      description:
        "更偏长者、导师、授课感，语气有指导和解释意味，和少女俏皮或戏精张力明显分开。",
      files: [
        {
          row_idx: 4870,
          source_path: `${workspace}/temp/age_probe2/Xianyun_4870.wav`,
          saved_path: `${root}/基础音色/女声/08_长者女_师者讲述/01_Xianyun_vo_LYLQ002_14_xianyun_06.wav`,
        },
        {
          row_idx: 2355,
          source_path: `${workspace}/temp/female_age_probe4/Faruzan_2355.wav`,
          saved_path: `${root}/基础音色/女声/08_长者女_师者讲述/02_Faruzan_vo_faruzan_weather_gale_01.wav`,
        },
        {
          row_idx: 2542,
          source_path: `${workspace}/temp/female_age_probe4/Faruzan_2542.wav`,
          saved_path: `${root}/基础音色/女声/08_长者女_师者讲述/03_Faruzan_vo_FRZCOP001_1917310_faruzan_02.wav`,
        },
        {
          row_idx: 3803,
          source_path: `${workspace}/temp/female_age_probe3/Faruzan_3803.wav`,
          saved_path: `${root}/基础音色/女声/08_长者女_师者讲述/04_Faruzan_vo_FRZCOP001_1917304_faruzan_16.wav`,
        },
        {
          row_idx: 5298,
          source_path: `${workspace}/temp/female_age_probe3/Faruzan_5298.wav`,
          saved_path: `${root}/基础音色/女声/08_长者女_师者讲述/05_Faruzan_vo_FRZCOP001_1917203_faruzan_11.wav`,
        },
      ],
    },
  ];

  for (const category of additions) {
    for (const file of category.files) {
      const meta = metaByRow.get(file.row_idx);
      if (!meta) {
        throw new Error(`Missing metadata for row ${file.row_idx}`);
      }
      if (!fs.existsSync(file.source_path)) {
        throw new Error(`Missing source file: ${file.source_path}`);
      }
      copyFile(file.source_path, file.saved_path);
      manifest.push({
        category_id: category.category_id,
        source_category_id: category.source_category_id,
        category_group_path: category.category_group_path,
        category_title: category.category_title,
        folder: category.folder,
        speaker: meta.speaker,
        type: meta.type,
        transcription: meta.transcription,
        duration_seconds: durationSeconds(file.saved_path),
        row_idx: meta.row_idx,
        in_game_filename: meta.inGameFilename,
        source_audio_url: meta.source_audio_url,
        saved_path: file.saved_path.replace(/\//g, "\\"),
      });
    }
  }

  manifest.sort((a, b) => {
    const na = parseInt(String(a.category_id).replace(/\D/g, ""), 10);
    const nb = parseInt(String(b.category_id).replace(/\D/g, ""), 10);
    if (na !== nb) return na - nb;
    return String(a.saved_path).localeCompare(String(b.saved_path));
  });

  summary.built_at = nowLocal();
  summary.merge_strategy =
    "Curated merge with similarity pruning, then selective high-contrast role-archetype additions, and finally missing age-layer base timbres for clearer adult separation, including newly restored mature and elder-feeling female base layers.";
  summary.total_downloaded_files = manifest.length;
  summary.category_counts.push(
    {
      id: "C27",
      source_id: "B_F09",
      group_path: ["基础音色", "女声"],
      title: "熟龄女 端雅稳叙",
      folder: "07_熟龄女_端雅稳叙",
      description:
        "更像经历过事的成熟女声，气息更稳、句子更长，不走御姐冷压或慵懒磁性。",
      count: 5,
    },
    {
      id: "C28",
      source_id: "B_F10",
      group_path: ["基础音色", "女声"],
      title: "长者女 师者讲述",
      folder: "08_长者女_师者讲述",
      description:
        "更偏长者、导师、授课感，语气有指导和解释意味，和少女俏皮或戏精张力明显分开。",
      count: 5,
    }
  );
  summary.category_counts.sort((a, b) => {
    const na = parseInt(String(a.id).replace(/\D/g, ""), 10);
    const nb = parseInt(String(b.id).replace(/\D/g, ""), 10);
    return na - nb;
  });

  writeJson(manifestPath, manifest);
  writeJson(summaryPath, summary);

  const lines = [];
  lines.push("# Genshin Chinese Voice Preset Library - Merged Curated Edition");
  lines.push("");
  lines.push(`- Primary source: ${summary.primary_audio_source}`);
  lines.push(`- Built at: ${summary.built_at}`);
  lines.push(`- Total files: ${summary.total_downloaded_files}`);
  lines.push(
    "- Goal: maximize audible separation between folders, remove near-duplicate timbre groups, then add back only role types or age layers that still sound clearly different."
  );
  lines.push("");
  lines.push("## Kept Categories");
  lines.push("");
  for (const category of summary.category_counts) {
    lines.push(
      `- [${category.group_path.join(" / ")}] ${category.folder}: ${category.count} files`
    );
    lines.push(`  Description: ${category.description}`);
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push(
    "- This merged edition still keeps the >= 5s rule for all newly added clips."
  );
  lines.push(
    "- `07_熟龄女_端雅稳叙` stays separate from `21_名门御姐_贵气控场` and `06_成女_慵懒磁性`: it is a base timbre age layer, not a high-status role mask or a lazy-sultry color."
  );
  lines.push(
    "- `08_长者女_师者讲述` stays separate from `18_戏精张力_舞台感强`: this folder leans toward elder-teacher explanation and guidance, not theatrical projection."
  );
  lines.push(
    "- Literal elderly-woman Chinese clips remain sparse in this dataset, so `08_长者女_师者讲述` is curated toward mentor and elder feeling rather than a deliberately rasped old-lady caricature."
  );
  lines.push(
    "- `manifest.json` keeps source category ids and dataset row ids for traceability."
  );
  fs.writeFileSync(readmePath, "\uFEFF" + lines.join("\n"), "utf8");

  console.log(
    JSON.stringify(
      {
        total: manifest.length,
        built_at: summary.built_at,
        added_categories: additions.map((item) => item.category_id),
      },
      null,
      2
    )
  );
}

main();
