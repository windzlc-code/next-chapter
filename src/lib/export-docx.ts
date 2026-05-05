import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
  WidthType,
  ShadingType,
  PageBreak,
  LevelFormat,
  Header,
  Footer,
  PageNumber,
} from "docx";
import { saveAs } from "file-saver";
import type { DramaSetup, EpisodeScript } from "@/types/drama";

export type ExportToDocxResult =
  | { status: "saved"; filePath?: string }
  | { status: "cancelled" };

function isMissingSaveBinaryHandler(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("storage:saveBinaryFile") && message.includes("No handler registered");
}

const FONT = "Microsoft YaHei";
const FONT_FALLBACK = "Arial";
const PAGE_WIDTH = 11906; // A4
const PAGE_HEIGHT = 16838;
const MARGIN = 1440; // 1 inch
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2; // ~9026

const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };
const cellMargins = { top: 60, bottom: 60, left: 100, right: 100 };

function headerCell(text: string, width: number): TableCell {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders,
    margins: cellMargins,
    shading: { fill: "2B579A", type: ShadingType.CLEAR },
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text, bold: true, font: FONT, size: 20, color: "FFFFFF" })],
      }),
    ],
  });
}

function dataCell(text: string, width: number): TableCell {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders,
    margins: cellMargins,
    children: [
      new Paragraph({
        children: [new TextRun({ text, font: FONT, size: 20 })],
      }),
    ],
  });
}

/** Parse script content into structured paragraphs */
function parseScriptContent(content: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      paragraphs.push(new Paragraph({ children: [] }));
      continue;
    }

    // Scene heading: # 1-1 or ## 场景
    if (/^#{1,3}\s/.test(trimmed)) {
      const text = trimmed.replace(/^#{1,3}\s*/, "");
      paragraphs.push(
        new Paragraph({
          spacing: { before: 240, after: 120 },
          children: [
            new TextRun({
              text,
              bold: true,
              font: FONT,
              size: 24,
              color: "2B579A",
            }),
          ],
        })
      );
      continue;
    }

    // △ description lines
    if (trimmed.startsWith("△")) {
      paragraphs.push(
        new Paragraph({
          spacing: { before: 60, after: 60 },
          indent: { left: 360 },
          children: [
            new TextRun({
              text: "△ ",
              bold: true,
              font: FONT,
              size: 20,
              color: "7B7B7B",
            }),
            new TextRun({
              text: trimmed.slice(1).trim(),
              font: FONT,
              size: 20,
              italics: true,
              color: "555555",
            }),
          ],
        })
      );
      continue;
    }

    // Dialogue: 角色名：（语气）台词 or 旁白：
    const dialogueMatch = trimmed.match(/^(.+?)[：:](.+)$/);
    if (dialogueMatch) {
      const speaker = dialogueMatch[1].trim();
      const dialogue = dialogueMatch[2].trim();
      const isNarration = speaker === "旁白" || speaker.toLowerCase() === "narration";

      paragraphs.push(
        new Paragraph({
          spacing: { before: 80, after: 80 },
          indent: { left: isNarration ? 360 : 0 },
          children: [
            new TextRun({
              text: `${speaker}：`,
              bold: true,
              font: FONT,
              size: 21,
              color: isNarration ? "8B5CF6" : "1A1A1A",
            }),
            new TextRun({
              text: dialogue,
              font: FONT,
              size: 21,
            }),
          ],
        })
      );
      continue;
    }

    // Cast list: 出场人物：
    if (trimmed.startsWith("出场人物")) {
      paragraphs.push(
        new Paragraph({
          spacing: { before: 60, after: 60 },
          children: [
            new TextRun({
              text: trimmed,
              font: FONT,
              size: 20,
              bold: true,
              color: "D97706",
            }),
          ],
        })
      );
      continue;
    }

    // Default paragraph
    paragraphs.push(
      new Paragraph({
        spacing: { before: 40, after: 40 },
        children: [new TextRun({ text: trimmed, font: FONT, size: 20 })],
      })
    );
  }

  return paragraphs;
}

/** Extract character info from characters text */
function extractCharacterRows(characters: string): { name: string; info: string }[] {
  const rows: { name: string; info: string }[] = [];
  const matches = characters.matchAll(
    /(?:^|\n)(?:###?\s*)?\d*\.?\s*\*{0,2}(.+?)\*{0,2}\s*[（(](.+?)[）)]/g
  );
  for (const m of matches) {
    rows.push({ name: m[1].trim(), info: m[2].trim() });
  }
  return rows;
}

export async function exportToDocx(
  setup: DramaSetup,
  dramaTitle: string,
  creativePlan: string,
  characters: string,
  episodes: EpisodeScript[]
): Promise<ExportToDocxResult> {
  const sortedEpisodes = [...episodes].sort((a, b) => a.number - b.number);
  const totalWords = episodes.reduce((s, e) => s + e.wordCount, 0);
  const charRows = extractCharacterRows(characters);

  const children: (Paragraph | Table)[] = [];

  // ===== COVER PAGE =====
  children.push(new Paragraph({ children: [], spacing: { before: 3000 } }));
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
      children: [
        new TextRun({
          text: dramaTitle || "未命名短剧",
          bold: true,
          font: FONT,
          size: 56,
          color: "1A1A1A",
        }),
      ],
    })
  );
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [
        new TextRun({
          text: "剧本文档",
          font: FONT,
          size: 28,
          color: "666666",
        }),
      ],
    })
  );

  // Info summary
  const infoLines = [
    `题材：${setup.genres.join(" + ")}`,
    `受众：${setup.audience}`,
    `基调：${setup.tone}`,
    `结局：${setup.ending}`,
    `总集数：${setup.totalEpisodes}`,
    `已完成：${episodes.length} 集`,
    `总字数：${totalWords.toLocaleString()}`,
  ];
  for (const info of infoLines) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 60 },
        children: [new TextRun({ text: info, font: FONT, size: 22, color: "444444" })],
      })
    );
  }

  children.push(new Paragraph({ children: [new PageBreak()] }));

  // ===== TABLE OF CONTENTS (manual) =====
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 300 },
      children: [new TextRun({ text: "目录", font: FONT, size: 36, bold: true })],
    })
  );

  const tocItems = [
    "角色表",
    "创作方案",
    ...sortedEpisodes.map((ep) => `第${ep.number}集：${ep.title}`),
  ];
  for (const item of tocItems) {
    children.push(
      new Paragraph({
        spacing: { before: 80 },
        indent: { left: 360 },
        children: [new TextRun({ text: `● ${item}`, font: FONT, size: 22 })],
      })
    );
  }

  children.push(new Paragraph({ children: [new PageBreak()] }));

  // ===== CHARACTER TABLE =====
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 200 },
      children: [new TextRun({ text: "角色表", font: FONT, size: 32, bold: true })],
    })
  );

  if (charRows.length > 0) {
    const col1 = Math.round(CONTENT_WIDTH * 0.25);
    const col2 = CONTENT_WIDTH - col1;
    const tableRows = [
      new TableRow({ children: [headerCell("角色名", col1), headerCell("简介", col2)] }),
      ...charRows.map(
        (r) => new TableRow({ children: [dataCell(r.name, col1), dataCell(r.info, col2)] })
      ),
    ];
    children.push(
      new Table({
        width: { size: CONTENT_WIDTH, type: WidthType.DXA },
        columnWidths: [col1, col2],
        rows: tableRows,
      })
    );
  } else {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: "（请参考角色档案）", font: FONT, size: 20, color: "999999" })],
      })
    );
  }

  // Full character text
  if (characters.trim()) {
    children.push(new Paragraph({ children: [], spacing: { before: 200 } }));
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { after: 120 },
        children: [new TextRun({ text: "角色档案详情", font: FONT, size: 26, bold: true })],
      })
    );
    for (const line of characters.split("\n")) {
      const t = line.trim();
      if (!t) {
        children.push(new Paragraph({ children: [] }));
        continue;
      }
      const isSubHeading = /^#{1,3}\s/.test(t);
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: t.replace(/^#{1,3}\s*/, ""),
              font: FONT,
              size: isSubHeading ? 24 : 20,
              bold: isSubHeading,
            }),
          ],
        })
      );
    }
  }

  children.push(new Paragraph({ children: [new PageBreak()] }));

  // ===== CREATIVE PLAN =====
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 200 },
      children: [new TextRun({ text: "创作方案", font: FONT, size: 32, bold: true })],
    })
  );
  for (const line of creativePlan.split("\n")) {
    const t = line.trim();
    if (!t) {
      children.push(new Paragraph({ children: [] }));
      continue;
    }
    const isH = /^#{1,3}\s/.test(t);
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: t.replace(/^#{1,3}\s*/, ""),
            font: FONT,
            size: isH ? 24 : 20,
            bold: isH,
          }),
        ],
      })
    );
  }

  children.push(new Paragraph({ children: [new PageBreak()] }));

  // ===== EPISODES =====
  for (const ep of sortedEpisodes) {
    // Episode title
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 200, after: 200 },
        children: [
          new TextRun({
            text: `第${ep.number}集：${ep.title}`,
            font: FONT,
            size: 32,
            bold: true,
          }),
        ],
      })
    );

    // Word count badge
    children.push(
      new Paragraph({
        spacing: { after: 200 },
        children: [
          new TextRun({
            text: `字数：${ep.wordCount.toLocaleString()}`,
            font: FONT,
            size: 18,
            color: "888888",
          }),
        ],
      })
    );

    // Parse and add script content
    const scriptParagraphs = parseScriptContent(ep.content);
    children.push(...scriptParagraphs);

    // Page break after each episode (except last)
    if (ep !== sortedEpisodes[sortedEpisodes.length - 1]) {
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }
  }

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: FONT, size: 21 },
        },
      },
      paragraphStyles: [
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 32, bold: true, font: FONT },
          paragraph: { spacing: { before: 240, after: 200 } },
        },
        {
          id: "Heading2",
          name: "Heading 2",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 26, bold: true, font: FONT },
          paragraph: { spacing: { before: 180, after: 120 } },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
            margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({
                    text: dramaTitle || "剧本",
                    font: FONT,
                    size: 16,
                    color: "AAAAAA",
                  }),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    font: FONT_FALLBACK,
                    size: 18,
                    color: "999999",
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  const buffer = await Packer.toBlob(doc);
  const fileName = `${dramaTitle || "剧本"}.docx`;
  const saveBinaryFile = window.electronAPI?.storage?.saveBinaryFile;

  if (saveBinaryFile) {
    try {
      const bytes = new Uint8Array(await buffer.arrayBuffer());
      let binary = "";
      bytes.forEach((byte) => {
        binary += String.fromCharCode(byte);
      });
      const result = await saveBinaryFile({
        defaultFileName: fileName,
        filters: [{ name: "Word Document", extensions: ["docx"] }],
        base64: btoa(binary),
      });
      if (!result.ok) {
        throw new Error(result.error || "保存 Word 文件失败。");
      }
      if (result.cancelled) {
        return { status: "cancelled" };
      }
      return { status: "saved", filePath: result.filePath };
    } catch (error) {
      if (!isMissingSaveBinaryHandler(error)) {
        throw error;
      }
    }
  }

  saveAs(buffer, fileName);
  return { status: "saved" };
}
