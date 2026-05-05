export interface AssistantMessageSection {
  id: string;
  heading: string;
  body: string;
}

export interface AssistantMessageSubSection {
  heading: string;
  body: string;
}

export interface AssistantMessageSectionParseResult {
  lead: string;
  sections: AssistantMessageSection[];
}

const CHINESE_SECTION_HEADING_RE = /^([一二三四五六七八九十百千]+)\s*[、.．]\s*(.+)$/;
const MARKDOWN_SECTION_HEADING_RE = /^(#{1,2})\s+(.+)$/;

function normalizeHeading(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

function isSectionHeading(line: string): { heading: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const markdownMatch = trimmed.match(MARKDOWN_SECTION_HEADING_RE);
  if (markdownMatch) {
    return { heading: normalizeHeading(markdownMatch[2] || trimmed) };
  }

  const chineseMatch = trimmed.match(CHINESE_SECTION_HEADING_RE);
  if (chineseMatch) {
    return { heading: normalizeHeading(trimmed) };
  }

  return null;
}

export function splitAssistantMessageSections(content: string): AssistantMessageSectionParseResult {
  const lines = String(content || "").replace(/\r\n/g, "\n").split("\n");
  const leadLines: string[] = [];
  const sections: AssistantMessageSection[] = [];

  let currentHeading: string | null = null;
  let currentLines: string[] = [];
  let inCodeFence = false;

  const flushSection = () => {
    if (!currentHeading) return;
    const body = currentLines.join("\n").trim();
    sections.push({
      id: `assistant-section-${sections.length}`,
      heading: currentHeading,
      body,
    });
    currentHeading = null;
    currentLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inCodeFence = !inCodeFence;
    }

    if (!inCodeFence) {
      const match = isSectionHeading(line);
      if (match) {
        flushSection();
        currentHeading = match.heading;
        continue;
      }
    }

    if (currentHeading) {
      currentLines.push(line);
    } else {
      leadLines.push(line);
    }
  }

  flushSection();

  return {
    lead: leadLines.join("\n").trim(),
    sections: sections.filter((section) => section.heading.trim() && section.body.trim()),
  };
}

const BOLD_SUBSECTION_RE = /^\*\*([^*]+)\*\*$/;

export function splitSectionSubSections(body: string): {
  lead: string;
  subSections: AssistantMessageSubSection[];
} {
  const lines = body.split("\n");
  const leadLines: string[] = [];
  const subSections: AssistantMessageSubSection[] = [];

  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (!currentHeading) return;
    const subBody = currentLines.join("\n").trim();
    if (subBody) {
      subSections.push({ heading: currentHeading, body: subBody });
    }
    currentHeading = null;
    currentLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const boldMatch = trimmed.match(BOLD_SUBSECTION_RE);
    if (boldMatch) {
      flush();
      currentHeading = boldMatch[1].trim();
      continue;
    }
    if (currentHeading) {
      currentLines.push(line);
    } else {
      leadLines.push(line);
    }
  }
  flush();

  return {
    lead: leadLines.join("\n").trim(),
    subSections,
  };
}
