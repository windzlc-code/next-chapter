function stripTitleDecorators(value: string): string {
  return value
    .trim()
    .replace(/^[-*•\d.)、\s]+/u, "")
    .replace(/^#{1,6}\s*/u, "")
    .replace(/^\*\*(.+)\*\*$/u, "$1")
    .replace(/^__(.+)__$/u, "$1")
    .replace(/^《(.+)》$/u, "$1")
    .replace(/^<(.+)>$/u, "$1")
    .replace(/^「(.+)」$/u, "$1")
    .replace(/^『(.+)』$/u, "$1")
    .replace(/^“(.+)”$/u, "$1")
    .replace(/^"(.+)"$/u, "$1")
    .trim();
}

function normalizeTitleCandidate(value: string): string | null {
  const cleaned = stripTitleDecorators(value)
    .replace(/[。！？.!?：:；;，,]+$/u, "")
    .trim();

  if (!cleaned) return null;
  if (cleaned.length < 2 || cleaned.length > 60) return null;
  if (/^(未命名|当前项目|该项目|这个项目|项目名称|暂定项目名称)$/u.test(cleaned)) {
    return null;
  }

  return cleaned;
}

function pickWrappedTitle(value: string): string | null {
  const wrappedMatch =
    value.match(/[《<「『“"]\s*([^》>」』”"\n]{2,60})\s*[》>」』”"]/u) ??
    value.match(/`([^`\n]{2,60})`/u);
  if (!wrappedMatch?.[1]) return null;
  return normalizeTitleCandidate(wrappedMatch[1]);
}

const USER_PROJECT_TITLE_FALLBACK = "新会话项目";
const USER_PROJECT_TITLE_MAX_LENGTH = 24;
const USER_REQUEST_PREFIXES = [
  /^(?:请先|请帮我|帮我|帮忙|麻烦你|请|我要|我想|想要|先|开始|继续|继续帮我|继续帮忙|我们来|来)\s*/u,
  /^(?:起草|写|做|生成|创建|开|开启|启动|整理|搭建|构思|规划|制作|推进|完善|补完)(?:一部|一个|一份|一套|一支|个|份|部)?\s*/u,
  /^(?:把|将)\s*/u,
  /^(?:这个|当前)?(?:项目|故事|短剧|剧本)\s*(?:先)?(?:做|写|完善|推进)\s*/u,
  /^(?:一个|一部|一份|一套|一支)\s*/u,
];
const GENERIC_USER_PROJECT_TITLES = /^(?:继续|继续执行|执行|开始|推进|完善|处理|创作|写作|制作|生成|新建|创建|新项目|项目)$/u;

function stripUserProjectRequestPrefix(value: string): string {
  let current = value.trim();

  for (let changed = true; changed; ) {
    changed = false;
    for (const pattern of USER_REQUEST_PREFIXES) {
      const next = current.replace(pattern, "").trim();
      if (next && next !== current) {
        current = next;
        changed = true;
      }
    }
  }

  return current;
}

export function buildAutoSessionProjectTitle(text: string): string {
  const firstLine = String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const firstClause = firstLine?.split(/[。！？!?；;，,]/u)[0]?.trim() ?? "";
  const normalized = stripUserProjectRequestPrefix(stripTitleDecorators(firstClause || firstLine || ""))
    .replace(/[《》"'`“”]/gu, "")
    .replace(/[吧呀呢啦]$/u, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized || GENERIC_USER_PROJECT_TITLES.test(normalized)) {
    return USER_PROJECT_TITLE_FALLBACK;
  }

  const clipped =
    normalized.length > USER_PROJECT_TITLE_MAX_LENGTH
      ? normalized.slice(0, USER_PROJECT_TITLE_MAX_LENGTH).trim()
      : normalized;

  return clipped || USER_PROJECT_TITLE_FALLBACK;
}

const TITLE_MARKER =
  /(暂定项目名称|项目暂定名|建议项目名称|建议项目名|项目名称暂定|暂定剧名|建议剧名|暂定片名|建议片名|项目名更新为|项目名称更新为|项目名改为|项目名称改为|定名为|命名为)\s*[:：]?\s*(.+)?/iu;

export function extractAssistantProjectTitle(text: string): string | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;

    const markerMatch = line.match(TITLE_MARKER);
    if (!markerMatch) continue;

    const sameLineCandidate = markerMatch[2]?.trim() || "";
    const wrappedSameLine = pickWrappedTitle(sameLineCandidate);
    if (wrappedSameLine) return wrappedSameLine;

    const normalizedSameLine = normalizeTitleCandidate(sameLineCandidate);
    if (normalizedSameLine) return normalizedSameLine;

    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const nextLine = lines[nextIndex]?.trim();
      if (!nextLine) continue;
      const wrappedNextLine = pickWrappedTitle(nextLine);
      if (wrappedNextLine) return wrappedNextLine;

      const normalizedNextLine = normalizeTitleCandidate(nextLine);
      if (normalizedNextLine) return normalizedNextLine;
      break;
    }
  }

  const inlineRename =
    text.match(/(?:项目名|项目名称|剧名|片名)(?:更新为|改为|定为|命名为)\s*[《<「『“"]?\s*([^》>」』”"\n]{2,60})\s*[》>」』”"]?/iu) ??
    text.match(/(?:暂定|建议)(?:项目名称|项目名|剧名|片名)\s*[《<「『“"]?\s*([^》>」』”"\n]{2,60})\s*[》>」』”"]?/iu);

  if (inlineRename?.[1]) {
    return normalizeTitleCandidate(inlineRename[1]);
  }

  return null;
}
