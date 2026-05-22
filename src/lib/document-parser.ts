/**
 * 浏览器端文档解析
 * 支持 PDF、DOCX（.doc/.docx）、纯文本
 */

export async function parseDocument(file: File): Promise<string> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";

  if (ext === "pdf") {
    return parsePdf(file);
  }

  if (ext === "docx" || ext === "doc") {
    return parseDocx(file);
  }

  if (ext === "txt") {
    return parseTxt(file);
  }

  throw new Error(`不支持的文件格式: .${ext}，支持 PDF、DOCX、DOC、TXT`);
}

async function parsePdf(file: File): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const parts: string[] = [];
  type PdfTextItemLike = {
    str?: string;
  };

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => {
        const candidate = item as PdfTextItemLike;
        return typeof candidate.str === "string" ? candidate.str : "";
      })
      .join(" ");
    parts.push(text);
  }

  const result = parts.join("\n\n");
  if (!result.trim()) {
    throw new Error("PDF 中未提取到文本内容，可能是扫描件或图片型 PDF");
  }
  return result;
}

async function parseDocx(file: File): Promise<string> {
  const mammoth = await import("mammoth");
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

async function parseTxt(file: File): Promise<string> {
  return await file.text();
}
