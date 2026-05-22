import ExcelJS from "exceljs";
import type { Scene, CharacterSetting, SceneSetting } from "@/types/project";
import { getCharacterDisplayName, getSceneDisplayName } from "@/lib/workspace-labels";

const COLS = ["分镜序号", "画面描述", "对白", "角色", "时长(秒)"] as const;

export async function exportScenesToXlsx(
  scenes: Scene[],
  title?: string,
  characters: CharacterSetting[] = [],
  sceneSettings: SceneSetting[] = [],
  options?: {
    directoryPath?: string;
  },
) {
  if (scenes.length === 0) return;

  const segmentMap = new Map<string, Scene[]>();
  const segmentOrder: string[] = [];
  for (const scene of scenes) {
    const label = scene.segmentLabel || "未分组";
    if (!segmentMap.has(label)) {
      segmentMap.set(label, []);
      segmentOrder.push(label);
    }
    segmentMap.get(label)!.push(scene);
  }

  const hasEpisodes = segmentOrder.some((label) => /^\d+-\d+$/.test(label));

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("分镜脚本", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  worksheet.columns = [
    { key: "shot", width: 12 },
    { key: "desc", width: 58 },
    { key: "dialogue", width: 38 },
    { key: "chars", width: 26 },
    { key: "duration", width: 10 },
  ];

  const borderThin: Partial<ExcelJS.Borders> = {
    top: { style: "thin", color: { argb: "FFDDDDDD" } },
    bottom: { style: "thin", color: { argb: "FFDDDDDD" } },
    left: { style: "thin", color: { argb: "FFDDDDDD" } },
    right: { style: "thin", color: { argb: "FFDDDDDD" } },
  };

  const styleColHeader: Partial<ExcelJS.Style> = {
    font: { bold: true, color: { argb: "FFFFFFFF" }, size: 11 },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF1A1A2E" } },
    alignment: { vertical: "middle", horizontal: "center" },
    border: borderThin,
  };

  const styleEpisodeHeader: Partial<ExcelJS.Style> = {
    font: { bold: true, size: 13, color: { argb: "FF1A1A2E" } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFC5CAE9" } },
    alignment: { vertical: "middle", horizontal: "left" },
    border: borderThin,
  };

  const styleSegmentHeader: Partial<ExcelJS.Style> = {
    font: { bold: true, size: 10, color: { argb: "FF303F9F" } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EAF6" } },
    alignment: { vertical: "middle", horizontal: "left", wrapText: true },
    border: borderThin,
  };

  const styleSuffix: Partial<ExcelJS.Style> = {
    font: { italic: true, size: 9, color: { argb: "FF999999" } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F5F5" } },
    alignment: { vertical: "middle" },
  };

  const headerRow = worksheet.addRow(COLS as unknown as string[]);
  headerRow.height = 28;
  headerRow.eachCell((cell) => {
    Object.assign(cell, { style: styleColHeader });
  });

  let lastEpisodeNumber = "";

  for (const segmentLabel of segmentOrder) {
    const segmentScenes = segmentMap.get(segmentLabel)!;
    const episodeNumber = hasEpisodes ? segmentLabel.split("-")[0] : "";

    if (hasEpisodes && episodeNumber !== lastEpisodeNumber) {
      lastEpisodeNumber = episodeNumber;
      const episodeTotalScenes = segmentOrder
        .filter((label) => label.startsWith(`${episodeNumber}-`))
        .reduce((sum, label) => sum + (segmentMap.get(label)?.length || 0), 0);
      const episodeSegmentCount = segmentOrder.filter((label) =>
        label.startsWith(`${episodeNumber}-`),
      ).length;

      const row = worksheet.addRow([
        `第 ${episodeNumber} 集    （${episodeSegmentCount} 个片段 · ${episodeTotalScenes} 个分镜）`,
      ]);
      worksheet.mergeCells(row.number, 1, row.number, 5);
      row.height = 30;
      row.eachCell((cell) => {
        Object.assign(cell, { style: styleEpisodeHeader });
      });
    }

    const sceneNames = [
      ...new Set(segmentScenes.map((scene) => getSceneDisplayName(scene, sceneSettings)).filter(Boolean)),
    ];
    const characterNames = [
      ...new Set(
        segmentScenes.flatMap((scene) =>
          scene.characters
            .map((characterName) =>
              getCharacterDisplayName(String(characterName || ""), scene, characters),
            )
            .filter(Boolean),
        ),
      ),
    ];

    const tags = [
      ...sceneNames.map((name) => `【${name}】`),
      ...characterNames.map((name) => `【${name}】`),
    ];

    const segmentDuration = segmentScenes[0]?.duration || 15;
    const segmentTitle = `片段 ${segmentLabel} (时长: ${segmentDuration}s)`;
    const tagText = tags.length > 0 ? `    场景/人物标签：${tags.join(" ")}` : "";

    const segmentRow = worksheet.addRow([segmentTitle + tagText]);
    worksheet.mergeCells(segmentRow.number, 1, segmentRow.number, 5);
    segmentRow.height = 26;
    segmentRow.eachCell((cell) => {
      Object.assign(cell, { style: styleSegmentHeader });
    });

    for (let index = 0; index < segmentScenes.length; index++) {
      const scene = segmentScenes[index];
      const row = worksheet.addRow([
        `分镜 ${index + 1}`,
        scene.description || "",
        scene.dialogue || "",
        (scene.characters || [])
          .map((characterName) =>
            getCharacterDisplayName(String(characterName || ""), scene, characters),
          )
          .join("、"),
        scene.duration ?? 5,
      ]);
      row.height = 22;

      row.getCell(1).style = {
        font: { bold: true, size: 10 },
        alignment: { vertical: "top", horizontal: "center" },
        border: borderThin,
      };
      row.getCell(2).style = {
        font: { size: 10 },
        alignment: { vertical: "top", wrapText: true },
        border: borderThin,
      };
      row.getCell(3).style = {
        font: { italic: true, size: 10, color: { argb: "FF666666" } },
        alignment: { vertical: "top", wrapText: true },
        border: borderThin,
      };
      row.getCell(4).style = {
        font: { size: 10 },
        alignment: { vertical: "top", wrapText: true },
        border: borderThin,
      };
      row.getCell(5).style = {
        font: { size: 10 },
        alignment: { vertical: "top", horizontal: "center" },
        border: borderThin,
      };
    }

    const suffixRow = worksheet.addRow(["通用后缀：无字幕、无水印、无背景音"]);
    worksheet.mergeCells(suffixRow.number, 1, suffixRow.number, 5);
    suffixRow.height = 20;
    suffixRow.eachCell((cell) => {
      Object.assign(cell, { style: styleSuffix });
    });

    worksheet.addRow([]);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const fileName = title ? `${title.slice(0, 30)}_分镜.xlsx` : "分镜脚本.xlsx";

  const directoryPath = options?.directoryPath?.trim();
  if (directoryPath) {
    const writer = window.electronAPI?.jimeng?.writeFile;
    if (!writer) {
      throw new Error("当前环境不支持直接写入 xlsx 文件。");
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    const filePath = `${directoryPath.replace(/[\\/]+$/, "")}/${fileName}`;
    const result = await writer(filePath, btoa(binary));
    if (!result.ok) {
      throw new Error(result.error || "导出 xlsx 失败。");
    }
    return { status: "saved" as const, filePath };
  }

  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
  return { status: "saved" as const };
}
