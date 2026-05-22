const fs = require("fs");
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

function nowLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate()
  )} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function main() {
  const root =
    "E:/Other/work/22/next-chapter_0.4.3_007/genshin-cn-voice-presets-merged";
  const manifestPath = `${root}/manifest.json`;
  const summaryPath = `${root}/summary.json`;
  const readmePath = `${root}/README.md`;
  const selectedRowsPath =
    "E:/Other/work/22/next-chapter_0.4.3_007/temp/age_probe2/selected_rows.json";

  const manifest = readJson(manifestPath).filter(
    (x) => !["C25", "C26"].includes(x.category_id)
  );
  const summary = readJson(summaryPath);
  summary.category_counts = summary.category_counts.filter(
    (x) => !["C25", "C26"].includes(x.id)
  );

  const selectedRows = readJson(selectedRowsPath);
  const rowsById = new Map(selectedRows.map((x) => [x.row_idx, x]));

  const additions = [
    {
      category_id: "C25",
      source_category_id: "B_M07",
      category_group_path: "基础音色/男声",
      category_title: "中年 沉厚老练",
      folder: "12_中年_沉厚老练",
      description:
        "颗粒更重、阅历感更深，从青年成熟线再往上推一档，但不走长者叙事状态。",
      files: [
        {
          row_idx: 4132,
          saved_path: `${root}/基础音色/男声/12_中年_沉厚老练/01_Baizhu_vo_BZLQ002_5_changsheng_05.wav`,
        },
        {
          row_idx: 5562,
          saved_path: `${root}/基础音色/男声/12_中年_沉厚老练/02_Diluc_vo_diluc_teammate_kaeya_01.wav`,
        },
        {
          row_idx: 10297,
          saved_path: `${root}/基础音色/男声/12_中年_沉厚老练/03_Diluc_vo_diluc_friendship_03.wav`,
        },
        {
          row_idx: 4619,
          saved_path: `${root}/基础音色/男声/12_中年_沉厚老练/04_Kaeya_vo_KYCOP001_1909703_kaeya_03.wav`,
        },
        {
          row_idx: 2534,
          saved_path: `${root}/基础音色/男声/12_中年_沉厚老练/05_Tighnari_vo_CNLQ103_2_tighnari_05.wav`,
        },
      ],
    },
    {
      category_id: "C26",
      source_category_id: "B_M08",
      category_group_path: "基础音色/男声",
      category_title: "年长 苍劲从容",
      folder: "13_年长_苍劲从容",
      description:
        "更慢、更稳、更苍劲，是基础层里的年长老成线，不等同于讲述者或审讯状态。",
      files: [
        {
          row_idx: 1123,
          saved_path: `${root}/基础音色/男声/13_年长_苍劲从容/01_Neuvillette_vo_FDAQ302_5_neuvillette_10.wav`,
        },
        {
          row_idx: 1145,
          saved_path: `${root}/基础音色/男声/13_年长_苍劲从容/02_Neuvillette_vo_FDAQ304_10_neuvillette_01.wav`,
        },
        {
          row_idx: 1254,
          saved_path: `${root}/基础音色/男声/13_年长_苍劲从容/03_Neuvillette_vo_FDAQ003_30_neuvillette_04.wav`,
        },
        {
          row_idx: 2826,
          saved_path: `${root}/基础音色/男声/13_年长_苍劲从容/04_Neuvillette_vo_SLLQ001_23_neuvillette_22.wav`,
        },
        {
          row_idx: 3621,
          saved_path: `${root}/基础音色/男声/13_年长_苍劲从容/05_Neuvillette_vo_FDAQ002_11_neuvillette_13.wav`,
        },
      ],
    },
  ];

  for (const category of additions) {
    for (const f of category.files) {
      const row = rowsById.get(f.row_idx);
      if (!row) {
        throw new Error(`Missing metadata for row ${f.row_idx}`);
      }
      manifest.push({
        category_id: category.category_id,
        source_category_id: category.source_category_id,
        category_group_path: category.category_group_path,
        category_title: category.category_title,
        folder: category.folder,
        speaker: row.speaker,
        type: row.type,
        transcription: row.transcription,
        duration_seconds: durationSeconds(f.saved_path),
        row_idx: row.row_idx,
        in_game_filename: row.inGameFilename,
        source_audio_url: row.source_audio_url,
        saved_path: f.saved_path.replace(/\//g, "\\"),
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
    "Curated merge with similarity pruning, then selective high-contrast role-archetype additions, and finally missing age-layer base timbres for clearer adult separation.";
  summary.total_downloaded_files = manifest.length;
  summary.category_counts.push(
    {
      id: "C25",
      source_id: "B_M07",
      group_path: ["基础音色", "男声"],
      title: "中年 沉厚老练",
      folder: "12_中年_沉厚老练",
      description:
        "颗粒更重、阅历感更深，从青年成熟线再往上推一档，但不走长者叙事状态。",
      count: 5,
    },
    {
      id: "C26",
      source_id: "B_M08",
      group_path: ["基础音色", "男声"],
      title: "年长 苍劲从容",
      folder: "13_年长_苍劲从容",
      description:
        "更慢、更稳、更苍劲，是基础层里的年长老成线，不等同于讲述者或审讯状态。",
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
  for (const c of summary.category_counts) {
    lines.push(
      `- [${c.group_path.join(" / ")}] ${c.folder}: ${c.count} files`
    );
    lines.push(`  Description: ${c.description}`);
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push(
    "- This merged edition still keeps the >= 5s rule for all newly added clips."
  );
  lines.push(
    "- `12_中年_沉厚老练` stays separate from `09_青年_温润知性` and `10_青年_沉稳权威`: it is rougher, older, and more experience-heavy instead of simply calm or authoritative."
  );
  lines.push(
    "- `13_年长_苍劲从容` stays separate from `12_长者权威_老成叙事`: this one is a base timbre age layer, while `12_长者权威_老成叙事` is a role-state folder."
  );
  lines.push(
    "- The dataset has fewer long, high-quality Chinese clips that sound like literal elderly women, so this pass prioritizes filling the missing middle-aged and older male base layers first."
  );
  lines.push(
    "- `manifest.json` keeps source category ids and dataset row ids for traceability."
  );
  fs.writeFileSync(readmePath, "\uFEFF" + lines.join("\n"), "utf8");

  console.log(
    JSON.stringify(
      { total: manifest.length, built_at: summary.built_at },
      null,
      2
    )
  );
}

main();
