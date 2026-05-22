import type { AskUserQuestionRequest } from "@/lib/agent/tools/ask-user-question";

interface StructuredQuestionExtraction {
  cleanedText: string;
  request: AskUserQuestionRequest | null;
  workflowCall?: Record<string, unknown> | null;
}

const QUESTION_HEADER_PATTERN =
  /^(?:问题|question)\s*(\d+)(?:\s*\/\s*(\d+))?(?:\s*[—\-:：]\s*(.+))?$/i;
const BULLET_PATTERN = /^\s*(?:[-*•]|(?:\d+|[A-Za-z])[.)、])\s+(.+)$/;

function collapseSpacing(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function getMarkdownDecoratorToken(line: string): string | null {
  const trimmed = line.trim();
  return trimmed === "**" || trimmed === "__" ? trimmed : null;
}

function collapseSplitMarkdownDecoratorLines(lines: string[]): string[] {
  const collapsed: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const decorator = getMarkdownDecoratorToken(lines[index]);
    const middle = lines[index + 1];
    const closing = lines[index + 2];

    if (
      decorator &&
      typeof middle === "string" &&
      middle.trim() &&
      !BULLET_PATTERN.test(middle.trim()) &&
      getMarkdownDecoratorToken(closing) === decorator
    ) {
      collapsed.push(`${decorator}${middle.trim()}${decorator}`);
      index += 2;
      continue;
    }

    collapsed.push(lines[index]);
  }

  return collapsed;
}

function sanitizeStructuredCleanedText(text: string): string {
  return collapseSpacing(
    text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .filter((line) => !getMarkdownDecoratorToken(line))
      .join("\n"),
  );
}

function stripMarkdownDecorators(value: string): string {
  let result = value.trim();
  if (getMarkdownDecoratorToken(result)) return "";
  result = result.replace(/^#{1,6}\s*/, "").replace(/^>\s*/, "").trim();

  const wrappers = [
    [/^\*\*([\s\S]+)\*\*$/u, "$1"],
    [/^__([\s\S]+)__$/u, "$1"],
    [/^~~([\s\S]+)~~$/u, "$1"],
    [/^`([\s\S]+)`$/u, "$1"],
    [/^\*([\s\S]+)\*$/u, "$1"],
    [/^_([\s\S]+)_$/u, "$1"],
  ] as const;

  let changed = true;
  while (changed) {
    changed = false;
    for (const [pattern, replacement] of wrappers) {
      if (pattern.test(result)) {
        result = result.replace(pattern, replacement).trim();
        changed = true;
      }
    }
  }

  return result.replace(/^\[(.+?)\]\(.+?\)$/u, "$1").trim();
}

function deriveQuestionHeader(id: string | undefined, question: string): string {
  const trimmedId = String(id || "").trim();
  if (trimmedId) {
    return trimmedId.replace(/^q\d+_?/i, "").slice(0, 12) || trimmedId.slice(0, 12);
  }
  return question.trim().slice(0, 12);
}

function deriveHeaderFromQuestion(question: string): string {
  const normalized = stripMarkdownDecorators(question)
    .replace(/[?？]\s*$/u, "")
    .trim();
  const candidate = normalized.split(/[，,:：]/u)[0]?.trim();
  return deriveQuestionHeader(undefined, candidate || normalized || "继续确认");
}

function normalizeOptionLabel(value: string): string {
  return stripMarkdownDecorators(value)
    .replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F]+\s*/gu, "")
    .replace(/^(?:选项\s*)?(?:[A-Za-z]|\d+)[.)、]\s*/u, "")
    .trim();
}

function buildToolRequest(
  parsed:
    | Array<Record<string, unknown>>
    | {
        tool?: string;
        arguments?: Record<string, unknown>;
        title?: string;
        description?: string;
        allowCustomInput?: boolean;
        submissionMode?: "immediate" | "confirm";
        questions?: Array<Record<string, unknown>>;
        question?: string;
        options?: Array<Record<string, unknown>>;
        header?: string;
        multiSelect?: boolean;
      },
): AskUserQuestionRequest | null {
  const normalizedParsed =
    !Array.isArray(parsed) &&
    parsed.tool === "AskUserQuestion" &&
    parsed.arguments &&
    typeof parsed.arguments === "object" &&
    !Array.isArray(parsed.arguments)
      ? parsed.arguments
      : parsed;

  const rawQuestions = Array.isArray(normalizedParsed)
    ? normalizedParsed
    : Array.isArray(normalizedParsed.questions)
      ? normalizedParsed.questions
      : typeof normalizedParsed.question === "string" && Array.isArray(normalizedParsed.options)
        ? [normalizedParsed]
        : null;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return null;
  }

  const request: AskUserQuestionRequest = {
    id: crypto.randomUUID(),
    title: Array.isArray(normalizedParsed) ? undefined : String(normalizedParsed.title ?? ""),
    description: Array.isArray(normalizedParsed) ? undefined : String(normalizedParsed.description ?? ""),
    allowCustomInput: Array.isArray(normalizedParsed)
      ? rawQuestions.every((question) => question.allowCustomInput !== false)
      : normalizedParsed.allowCustomInput !== false,
    submissionMode:
      (Array.isArray(normalizedParsed)
        ? rawQuestions.some((question) => question.submissionMode === "confirm")
        : normalizedParsed.submissionMode === "confirm")
        ? "confirm"
        : "immediate",
    questions: rawQuestions.map((question, index) => {
      const prompt = String(question.question || "").trim();
      return {
        question: prompt,
        header: String(
          question.header || deriveQuestionHeader(String(question.id || index), prompt),
        ).trim(),
        multiSelect: Boolean(question.multiSelect),
        options: Array.isArray(question.options)
          ? question.options
              .map((option) => ({
                label: String(option?.label || "").trim(),
                value:
                  typeof option?.value === "string" && option.value.trim()
                    ? option.value.trim()
                    : String(option?.label || "").trim(),
                description:
                  typeof option?.description === "string"
                    ? option.description.trim()
                    : undefined,
                rationale:
                  typeof option?.rationale === "string"
                    ? option.rationale.trim()
                    : undefined,
              }))
              .filter((option) => option.label)
          : [],
      };
    }),
  };

  return request.questions.every(
    (question) => question.question && question.options.length > 0,
  )
    ? request
    : null;
}

function extractToolInvocation(text: string): StructuredQuestionExtraction | null {
  const trimmed = text.trim();
  if (!trimmed.includes("AskUserQuestion(")) {
    if (!trimmed.includes("AskUserQuestion")) {
      return null;
    }
  }

  const codeBlockMatch = trimmed.match(
    /```(?:json)?\s*AskUserQuestion\s*\(?\s*([\s\S]*?)\s*\)?\s*```/i,
  );
  const inlineMatch =
    codeBlockMatch ??
    trimmed.match(/AskUserQuestion\s*\(?\s*([\s\S]*?)\s*\)?\s*$/i);
  const payload = inlineMatch?.[1]?.trim();

  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as
      | Array<Record<string, unknown>>
      | {
          title?: string;
          description?: string;
          allowCustomInput?: boolean;
          submissionMode?: "immediate" | "confirm";
          questions?: Array<Record<string, unknown>>;
        };

    const request = buildToolRequest(parsed);
    if (!request) {
      return null;
    }

    return {
      cleanedText: collapseSpacing(
        text.replace(codeBlockMatch?.[0] || inlineMatch?.[0] || "", ""),
      ),
      request,
      workflowCall: null,
    };
  } catch {
    return null;
  }
}

function buildLegacyAskUserRequest(parsed: Record<string, unknown>): AskUserQuestionRequest | null {
  const hasLegacyShape =
    parsed.type === "ask_user" ||
    ((typeof parsed.question === "string" || typeof parsed.prompt === "string") &&
      Array.isArray(parsed.options));
  if (!hasLegacyShape) return null;

  const rawQuestion =
    typeof parsed.question === "string"
      ? parsed.question.trim()
      : typeof parsed.prompt === "string"
        ? parsed.prompt.trim()
        : "";
  const rawOptions = Array.isArray(parsed.options) ? parsed.options : [];

  const options = rawOptions
    .map((option) => {
      if (typeof option === "string") {
        const label = option.trim();
        return label ? { label, value: label } : null;
      }

      if (!option || typeof option !== "object") return null;
      const label = typeof option.label === "string" ? option.label.trim() : "";
      if (!label) return null;

      return {
        label,
        value:
          typeof option.value === "string" && option.value.trim()
            ? option.value.trim()
            : label,
        description:
          typeof option.description === "string" ? option.description.trim() : undefined,
        rationale:
          typeof option.rationale === "string"
            ? option.rationale.trim()
            : typeof option.desc === "string"
              ? option.desc.trim()
              : undefined,
      };
    })
    .filter((option): option is NonNullable<typeof option> => Boolean(option));

  if (!rawQuestion || options.length === 0) {
    return null;
  }

  const customInputFlag =
    parsed.allowCustomInput !== false &&
    (typeof parsed.allowCustomInput === "boolean"
      ? parsed.allowCustomInput
      : options.some((option) => /自定义|custom/i.test(option.label)));

  return {
    id: crypto.randomUUID(),
    title: typeof parsed.title === "string" ? parsed.title.trim() : undefined,
    description: typeof parsed.description === "string" ? parsed.description.trim() : undefined,
    allowCustomInput: customInputFlag,
    submissionMode: parsed.submissionMode === "confirm" ? "confirm" : "immediate",
    questions: [
      {
        question: rawQuestion,
        header:
          typeof parsed.header === "string" && parsed.header.trim()
            ? parsed.header.trim()
            : deriveHeaderFromQuestion(rawQuestion),
        multiSelect: parsed.multiSelect === true,
        options,
      },
    ],
  };
}

function extractBalancedJsonObject(text: string, startIndex: number): { json: string; endIndex: number } | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          json: text.slice(startIndex, index + 1),
          endIndex: index + 1,
        };
      }
    }
  }

  return null;
}

function extractFirstStructuredJsonPayload(text: string): string | null {
  const objectStart = text.indexOf("{");
  if (objectStart >= 0) {
    return extractBalancedJsonObject(text, objectStart)?.json ?? null;
  }

  const arrayStart = text.indexOf("[");
  if (arrayStart >= 0) {
    const arrayEnd = text.lastIndexOf("]");
    if (arrayEnd > arrayStart) {
      return text.slice(arrayStart, arrayEnd + 1);
    }
  }

  return null;
}

function extractLegacyAskUserInvocation(text: string): StructuredQuestionExtraction | null {
  const trimmed = text.trim();
  if (!trimmed.includes("\"type\"") || !trimmed.includes("ask_user")) {
    return null;
  }

  const askUserMatch = /"type"\s*:\s*"ask_user"/i.exec(trimmed);
  if (!askUserMatch) {
    return null;
  }

  const typeIndex = askUserMatch.index;
  const objectStart = trimmed.lastIndexOf("{", typeIndex);
  if (objectStart < 0) {
    return null;
  }

  const extracted = extractBalancedJsonObject(trimmed, objectStart);
  if (!extracted) {
    return null;
  }

  try {
    const parsed = JSON.parse(extracted.json) as Record<string, unknown>;
    const request = buildLegacyAskUserRequest(parsed);
    if (!request) {
      return null;
    }

    return {
      cleanedText: collapseSpacing(
        `${trimmed.slice(0, objectStart)}${trimmed.slice(extracted.endIndex)}`,
      ),
      request,
      workflowCall: null,
    };
  } catch {
    return null;
  }
}

function extractWorkflowInvocation(text: string): StructuredQuestionExtraction | null {
  const trimmed = text.trim();
  if (!trimmed.includes("HomeStudioWorkflow")) {
    return null;
  }

  const codeBlockMatches = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  const toolPayload = codeBlockMatches
    .map((match) => match[1]?.trim() || "")
    .find((payload) => /HomeStudioWorkflow|\"tool\"\s*:\s*\"HomeStudioWorkflow\"/i.test(payload));

  const rawJsonPayload =
    toolPayload &&
    !/"tool"\s*:\s*"HomeStudioWorkflow"/i.test(toolPayload) &&
    /"action"\s*:\s*".+?"/i.test(toolPayload)
      ? toolPayload.match(/(\{[\s\S]*\})/i)
      : null;

  const invocationMatch =
    (toolPayload &&
      (toolPayload.match(/HomeStudioWorkflow\s*\(\s*([\s\S]*?)\s*\)\s*$/i) ||
        toolPayload.match(/(\{[\s\S]*\"tool\"\s*:\s*\"HomeStudioWorkflow\"[\s\S]*\})/i) ||
        rawJsonPayload)) ||
    trimmed.match(/HomeStudioWorkflow\s*\(\s*([\s\S]*?)\s*\)\s*$/i);

  const payload = invocationMatch?.[1]?.trim() || invocationMatch?.[0]?.trim();
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const workflowCall =
      parsed.tool === "HomeStudioWorkflow"
        ? parsed.arguments &&
          typeof parsed.arguments === "object" &&
          !Array.isArray(parsed.arguments)
          ? { ...(parsed.arguments as Record<string, unknown>) }
          : Object.fromEntries(
              Object.entries(parsed).filter(([key]) => key !== "tool"),
            )
        : parsed;

    if (typeof workflowCall.action !== "string" || !workflowCall.action.trim()) {
      return null;
    }

    const matchedBlock = codeBlockMatches.find((match) =>
      (match[1] || "").includes(payload),
    )?.[0];

    return {
      cleanedText: collapseSpacing(
        text.replace(matchedBlock || invocationMatch?.[0] || "", ""),
      ),
      request: null,
      workflowCall,
    };
  } catch {
    return null;
  }
}

function extractCommentedAskUserInvocation(text: string): StructuredQuestionExtraction | null {
  const trimmed = text.trim();
  if (!trimmed.includes("AskUserQuestion")) {
    return null;
  }

  const codeBlockMatches = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  const matchedBlock = codeBlockMatches.find((match) => /AskUserQuestion/i.test(match[1] || ""));
  const blockContent = matchedBlock?.[1]?.trim();
  if (!blockContent) {
    return null;
  }

  const payload =
    extractFirstStructuredJsonPayload(blockContent) ||
    blockContent.match(/AskUserQuestion\s*\(?\s*([\s\S]*?)\s*\)?$/i)?.[1]?.trim();
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const request = buildLegacyAskUserRequest(parsed) ?? buildToolRequest(parsed);
    if (!request) {
      return null;
    }

    return {
      cleanedText: collapseSpacing(text.replace(matchedBlock?.[0] || "", "")),
      request,
      workflowCall: null,
    };
  } catch {
    return null;
  }
}

function parseQuestionHeader(line: string): { index: number; total?: number; title?: string } | null {
  const normalized = stripMarkdownDecorators(line);
  const match = normalized.match(QUESTION_HEADER_PATTERN);
  if (!match) return null;

  return {
    index: Number.parseInt(match[1], 10),
    total: match[2] ? Number.parseInt(match[2], 10) : undefined,
    title: normalizeOptionLabel(match[3] || "") || undefined,
  };
}

function collapseSplitQuestionHeaderLines(lines: string[]): string[] {
  const collapsed: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index];
    const next = lines[index + 1];
    const nextTrimmed = next?.trimStart() ?? "";
    if (nextTrimmed.startsWith("- ")) {
      const combined = `${current.trimEnd()} ${nextTrimmed}`;
      if (parseQuestionHeader(combined)) {
        collapsed.push(combined);
        index += 1;
        continue;
      }
    }

    collapsed.push(current);
  }

  return collapsed;
}

function parseOptionLine(line: string): {
  label: string;
  rationale?: string;
  isCustomInputHint: boolean;
} | null {
  const match = line.match(BULLET_PATTERN);
  if (!match) return null;

  const normalized = normalizeOptionLabel(match[1] || "");
  if (!normalized) return null;

  if (
    /自定义|custom/i.test(normalized) &&
    /(输入|回答|补充|说明|custom|input)/i.test(normalized)
  ) {
    return {
      label: "",
      isCustomInputHint: true,
    };
  }

  if (/^其他(?:\s|[，,:：-]|$)/u.test(normalized) && /(描述|说明|补充|自定)/u.test(normalized)) {
    return {
      label: "",
      isCustomInputHint: true,
    };
  }

  const colonMatch = normalized.match(/^(.+?)[：:]\s*(.+)$/u);
  if (colonMatch) {
    return {
      label: normalizeOptionLabel(colonMatch[1]),
      rationale: stripMarkdownDecorators(colonMatch[2]).trim(),
      isCustomInputHint: false,
    };
  }

  const parentheticalMatch = normalized.match(/^(.+?)[（(]\s*(.+?)\s*[）)]$/u);
  if (parentheticalMatch) {
    return {
      label: normalizeOptionLabel(parentheticalMatch[1]),
      rationale: stripMarkdownDecorators(parentheticalMatch[2]).trim(),
      isCustomInputHint: false,
    };
  }

  return {
    label: normalized,
    isCustomInputHint: false,
  };
}

function expandCollapsedOptionLines(text: string): string {
  return text.replace(/([^\n])(?=(?:-\s+|\d+[.)]\s+))/g, "$1\n");
}

/**
 * 检测形如 "1. 单集时长" 的编号标题，且其后紧跟非编号的子弹点选项。
 * 用于兼容 LLM 未调用 AskUserQuestion 工具、直接输出 Markdown 编号列表的情况。
 */
function detectNumberedQuestionHeader(
  lines: string[],
  index: number,
): { index: number; title: string } | null {
  const normalized = stripMarkdownDecorators(lines[index].trim());
  const numberedMatch = normalized.match(/^(\d+)[.)、]\s*(.+)$/u);
  if (!numberedMatch) return null;

  // 向前找下一个非空行
  let lookahead = index + 1;
  while (lookahead < lines.length && !lines[lookahead].trim()) {
    lookahead += 1;
  }
  if (lookahead >= lines.length) return null;

  const nextLine = lines[lookahead].trim();
  if (!BULLET_PATTERN.test(nextLine)) return null;

  // 下一行必须是非编号的子弹点（•、-、*），而非另一个编号标题
  const nextNormalized = stripMarkdownDecorators(nextLine);
  if (/^(\d+)[.)、]\s*/u.test(nextNormalized)) return null;

  return {
    index: Number.parseInt(numberedMatch[1], 10),
    title: normalizeOptionLabel(numberedMatch[2]),
  };
}

function buildMarkdownRequest(text: string): StructuredQuestionExtraction | null {
  const lines = collapseSplitQuestionHeaderLines(
    collapseSplitMarkdownDecoratorLines(
      expandCollapsedOptionLines(text).replace(/\r\n?/g, "\n").split("\n"),
    ),
  );
  const keptLines: string[] = [];
  const questions: AskUserQuestionRequest["questions"] = [];
  let inferredTotal: number | undefined;

  for (let index = 0; index < lines.length; ) {
    const header =
      parseQuestionHeader(lines[index]) ?? detectNumberedQuestionHeader(lines, index);

    if (!header) {
      keptLines.push(lines[index]);
      index += 1;
      continue;
    }

    const blockLines = [lines[index]];
    const questionPromptLines: string[] = [];
    const trailingLines: string[] = [];
    const options: AskUserQuestionRequest["questions"][number]["options"] = [];
    let blockIndex = index + 1;
    let seenOptions = false;

    while (
      blockIndex < lines.length &&
      !parseQuestionHeader(lines[blockIndex]) &&
      !detectNumberedQuestionHeader(lines, blockIndex)
    ) {
      blockLines.push(lines[blockIndex]);
      const trimmedLine = lines[blockIndex].trim();
      if (!trimmedLine) {
        blockIndex += 1;
        continue;
      }

      const option = parseOptionLine(trimmedLine);
      if (option) {
        seenOptions = true;
        if (!option.isCustomInputHint && option.label) {
          options.push({
            label: option.label,
            value: option.label,
            rationale: option.rationale,
          });
        }
        blockIndex += 1;
        continue;
      }

      // 选项之后的非选项行视为尾部文本，保留到 keptLines 而非问题提示
      if (seenOptions) {
        trailingLines.push(lines[blockIndex]);
      } else {
        questionPromptLines.push(stripMarkdownDecorators(trimmedLine));
      }
      blockIndex += 1;
    }

    if (options.length > 0) {
      const prompt = questionPromptLines.join(" ").trim();
      const headerText = header.title || deriveQuestionHeader(undefined, prompt || `问题${header.index}`);
      const questionText = prompt || `请先确认${headerText}`;
      questions.push({
        question: questionText,
        header: headerText,
        multiSelect: /多选|可多选|任选|1\s*[-~至到]\s*\d+/u.test(prompt),
        options,
      });
      inferredTotal = "total" in header ? header.total ?? inferredTotal : inferredTotal;
      keptLines.push(...trailingLines);
    } else {
      keptLines.push(...blockLines);
    }

    index = blockIndex;
  }

  if (questions.length === 0) {
    return null;
  }

  return {
    cleanedText: sanitizeStructuredCleanedText(keptLines.join("\n")),
    request: {
      id: crypto.randomUUID(),
      title: inferredTotal && inferredTotal > 1 ? `先确认 ${questions.length} 个关键问题` : undefined,
      allowCustomInput: true,
      submissionMode: "immediate",
      questions,
    },
    workflowCall: null,
  };
}

function extractQuestionPromptFromLine(line: string): {
  question: string;
  remainder: string;
} | null {
  const boldQuestionMatches = [...line.matchAll(/(?:\*\*|__)(.+?[?？])(?:\*\*|__)/gu)];
  const boldQuestion = boldQuestionMatches.at(-1);

  if (boldQuestion?.[1]) {
    return {
      question: stripMarkdownDecorators(boldQuestion[1]).trim(),
      remainder: stripMarkdownDecorators(line.replace(boldQuestion[0], "")).trim(),
    };
  }

  const normalized = stripMarkdownDecorators(line);
  if (/[?？]\s*$/u.test(normalized)) {
    return {
      question: normalized.trim(),
      remainder: "",
    };
  }

  return null;
}

function extractDeclarativeSelectionPromptFromLine(line: string): {
  question: string;
  remainder: string;
} | null {
  const normalized = stripMarkdownDecorators(line).trim();
  if (!normalized) return null;

  const looksLikeSelectionLead =
    /(常见|通常|一般).*(目标|方向|类型|路径).*(有|分为|包括|共|类)/u.test(normalized) ||
    /(?:先|请先|接下来)?(?:选择|确认|锁定).*(目标|方向|类型|路径)/u.test(normalized);

  if (!looksLikeSelectionLead) return null;

  return {
    question: "请选择一个方向",
    remainder: "",
  };
}

function buildDecisionPromptFromLead(line: string): {
  question: string;
  remainder: string;
} | null {
  const normalized = stripMarkdownDecorators(line).trim();
  if (!normalized) return null;

  const directHeading = normalized.match(
    /^(?:#{1,6}\s*)?(下一步|接下来|后续|可选方案|建议路径|推荐路径|决策分支|关键分歧|请选择|你可以选择)([\s\S]*)$/iu,
  );
  if (directHeading) {
    const question = stripMarkdownDecorators(directHeading[2] || "")
      .replace(/^[：:\s-]+/u, "")
      .replace(/[\s。！？?!]+$/u, "")
      .trim();
    return {
      question:
        !question || /^(?:建议|选项|方案|路径|分支)$/u.test(question)
          ? "请选择下一步"
          : question,
      remainder: "",
    };
  }

  if (
    /(?:常见|通常|一般).*(?:目标|方向|类型|路径).*(?:分为|包括|如下|几类)/iu.test(normalized) ||
    /(?:建议|接下来|下一步|后续).*(?:选择|确认|锁定).*(?:目标|方向|类型|路径|动作|方案)/iu.test(
      normalized,
    ) ||
    /(?:可以|可先|可继续).*(?:选择|走|推进).*(?:路径|方案|步骤|动作)/iu.test(normalized)
  ) {
    return {
      question: "请选择一个方向",
      remainder: "",
    };
  }

  return extractDeclarativeSelectionPromptFromLine(line);
}

function buildInlinePromptRequest(text: string): StructuredQuestionExtraction | null {
  const lines = expandCollapsedOptionLines(text).replace(/\r\n?/g, "\n").split("\n");
  let promptIndex = -1;
  let promptQuestion = "";
  let promptRemainder = "";
  let optionStart = -1;
  let optionEnd = -1;
  let options: AskUserQuestionRequest["questions"][number]["options"] = [];

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const maybeOption = parseOptionLine(lines[index].trim());
    if (!maybeOption) {
      continue;
    }

    const clusterOptions: AskUserQuestionRequest["questions"][number]["options"] = [];
    let clusterStart = index;
    let clusterEnd = index;

    while (clusterStart >= 0) {
      const current = lines[clusterStart].trim();
      if (!current) {
        clusterStart -= 1;
        continue;
      }

      const parsed = parseOptionLine(current);
      if (!parsed) break;
      if (!parsed.isCustomInputHint && parsed.label) {
        clusterOptions.unshift({
          label: parsed.label,
          value: parsed.label,
          rationale: parsed.rationale,
        });
      }
      clusterStart -= 1;
    }

    if (clusterOptions.length < 2) {
      index = clusterStart;
      continue;
    }

    let candidatePromptIndex = clusterStart;
    let fallbackPrompt:
      | {
          index: number;
          question: string;
          remainder: string;
        }
      | null = null;

    while (candidatePromptIndex >= 0 && clusterStart - candidatePromptIndex <= 6) {
      const current = lines[candidatePromptIndex].trim();
      if (!current || /^[-*_]{3,}$/u.test(current)) {
        candidatePromptIndex -= 1;
        continue;
      }

      const prompt = extractQuestionPromptFromLine(lines[candidatePromptIndex]);
      const inferredPrompt = prompt ?? buildDecisionPromptFromLead(lines[candidatePromptIndex]);
      if (inferredPrompt) {
        promptIndex = candidatePromptIndex;
        promptQuestion = inferredPrompt.question;
        promptRemainder = inferredPrompt.remainder;
        optionStart = clusterStart + 1;
        optionEnd = clusterEnd;
        options = clusterOptions;
        fallbackPrompt = null;
        break;
      }

      const genericPrompt = extractDeclarativeSelectionPromptFromLine(lines[candidatePromptIndex]);
      if (!fallbackPrompt && genericPrompt) {
        fallbackPrompt = {
          index: candidatePromptIndex,
          question: genericPrompt.question,
          remainder: genericPrompt.remainder,
        };
      }

      candidatePromptIndex -= 1;
    }

    if (promptIndex < 0 && fallbackPrompt) {
      promptIndex = fallbackPrompt.index;
      promptQuestion = fallbackPrompt.question;
      promptRemainder = fallbackPrompt.remainder;
      optionStart = clusterStart + 1;
      optionEnd = clusterEnd;
      options = clusterOptions;
    }

    if (promptIndex >= 0) {
      break;
    }

    index = clusterStart;
  }

  if (promptIndex < 0 || optionStart < 0 || optionEnd < optionStart || options.length < 2) {
    return null;
  }

  const keptLines = lines.flatMap((line, index) => {
    if (index === promptIndex) {
      return promptRemainder ? [promptRemainder] : [];
    }
    if (index >= optionStart && index <= optionEnd) {
      return [];
    }
    return [line];
  });

  return {
    cleanedText: sanitizeStructuredCleanedText(keptLines.join("\n")),
    request: {
      id: crypto.randomUUID(),
      allowCustomInput: true,
      submissionMode: "immediate",
      questions: [
        {
          question: promptQuestion,
          header: deriveHeaderFromQuestion(promptQuestion),
          multiSelect: /多选|可多选/u.test(promptQuestion),
          options,
        },
      ],
    },
    workflowCall: null,
  };
}

function isPlainLineOptionCandidate(line: string): string | null {
  const normalized = normalizeOptionLabel(line);
  if (!normalized) return null;
  if (BULLET_PATTERN.test(line)) return null;
  if (normalized.length > 32) return null;
  if (/[?？:：。！？；;，,]\s*$/u.test(normalized)) return null;
  if (
    /^(?:\u6216\u8005|\u4e5f\u53ef\u4ee5|\u8bf7|\u5982\u679c|\u4f60\u53ef\u4ee5|\u6ca1\u7406\u89e3|\u4ee5\u4e0b|\u4e0b\u9762)/u.test(
      normalized,
    )
  ) {
    return null;
  }
  return normalized;
}

function buildPlainLineSelectionRequest(text: string): StructuredQuestionExtraction | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  for (let promptIndex = lines.length - 1; promptIndex >= 0; promptIndex -= 1) {
    const promptLine = stripMarkdownDecorators(lines[promptIndex]).trim();
    if (!promptLine) continue;

    const looksLikePrompt =
      /[?？]\s*$/u.test(promptLine) ||
      /(?:\u8bf7\u9009\u62e9|\u8bf7\u4ece\u4ee5\u4e0b\u9009\u9879\u4e2d\u9009\u62e9|\u6216\u8005\u544a\u8bc9\u6211|\u4f60\u60f3\u505a\u4ec0\u4e48)/u.test(
        promptLine,
      );
    if (!looksLikePrompt) continue;

    const options: AskUserQuestionRequest["questions"][number]["options"] = [];
    const consumed = new Set<number>([promptIndex]);
    let title = "";

    for (let index = promptIndex - 1; index >= 0; index -= 1) {
      const current = stripMarkdownDecorators(lines[index]).trim();
      if (!current) {
        if (options.length > 0) {
          consumed.add(index);
        }
        continue;
      }

      if (/[：:]\s*$/u.test(current)) {
        if (options.length > 0) {
          title = current.replace(/[：:]\s*$/u, "").trim();
          consumed.add(index);
          break;
        }
        continue;
      }

      const optionLabel = isPlainLineOptionCandidate(current);
      if (!optionLabel) {
        if (options.length > 0) break;
        continue;
      }

      options.unshift({
        label: optionLabel,
        value: optionLabel,
      });
      consumed.add(index);
    }

    if (options.length < 2) continue;

    const question = promptLine.replace(/[：:]\s*$/u, "").trim();
    const keptLines = lines.filter((_, index) => !consumed.has(index));

    return {
      cleanedText: sanitizeStructuredCleanedText(keptLines.join("\n")),
      request: {
        id: crypto.randomUUID(),
        title: title || undefined,
        allowCustomInput: true,
        submissionMode: "immediate",
        questions: [
          {
            question,
            header: deriveHeaderFromQuestion(title || question),
            multiSelect: false,
            options,
          },
        ],
      },
      workflowCall: null,
    };
  }

  return null;
}

export function extractStructuredQuestion(text: string): StructuredQuestionExtraction {
  let workingText = text;
  let request: AskUserQuestionRequest | null = null;
  let workflowCall: Record<string, unknown> | null = null;

  const workflowExtraction = extractWorkflowInvocation(workingText);
  if (workflowExtraction) {
    workingText = workflowExtraction.cleanedText;
    workflowCall = workflowExtraction.workflowCall ?? null;
  }

  const toolExtraction = extractToolInvocation(workingText);
  if (toolExtraction) {
    workingText = toolExtraction.cleanedText;
    request = toolExtraction.request;
  }

  if (!request) {
    const commentedToolExtraction = extractCommentedAskUserInvocation(workingText);
    if (commentedToolExtraction) {
      workingText = commentedToolExtraction.cleanedText;
      request = commentedToolExtraction.request;
    }
  }

  if (!request) {
    const legacyExtraction = extractLegacyAskUserInvocation(workingText);
    if (legacyExtraction) {
      workingText = legacyExtraction.cleanedText;
      request = legacyExtraction.request;
    }
  }

  if (!request) {
    const markdownExtraction = buildMarkdownRequest(workingText);
    if (markdownExtraction) {
      workingText = markdownExtraction.cleanedText;
      request = markdownExtraction.request;
    }
  }

  if (!request) {
    const inlineExtraction = buildInlinePromptRequest(workingText);
    if (inlineExtraction) {
      workingText = inlineExtraction.cleanedText;
      request = inlineExtraction.request;
    }
  }

  // Prefer real selectable options over freeform-only prompts; a request with no
  // options renders as an empty choice panel.
  if (!request) {
    const plainLineExtraction = buildPlainLineSelectionRequest(workingText);
    if (plainLineExtraction) {
      workingText = plainLineExtraction.cleanedText;
      request = plainLineExtraction.request;
    }
  }

  if (!request) {
    request = buildLeadingPromptFallback(workingText);
  }

  return {
    cleanedText: request ? sanitizeStructuredCleanedText(workingText) : collapseSpacing(workingText),
    request,
    workflowCall,
  };
}

/**
 * Keep the old freeform-only fallback intentionally inert. Without at least two
 * renderable options, the composer choice UI becomes an empty panel.
 */
function buildLeadingPromptFallback(text: string): AskUserQuestionRequest | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 只处理较短的文本（长文本通常是正常回复，不是引导语）
  if (trimmed.length > 300) return null;

  const lastLine = trimmed.split("\n").filter(Boolean).at(-1)?.trim() ?? "";

  const hasQuestionKeyword = /需要确认|请选择|请问|请告诉我|请提供|请说明|你希望|你想要|你倾向|你打算|想了解|想知道|能告诉我|可以告诉我/.test(trimmed);

  const isLeadingPrompt =
    // 以冒号结尾且含有问题关键词（避免"以下是分析结果："这类误触发）
    (/[：:]\s*$/.test(lastLine) && hasQuestionKeyword) ||
    // 含"需要确认"/"请选择"等关键词（不要求冒号结尾）
    hasQuestionKeyword ||
    // 以问号结尾
    /[？?]\s*$/.test(lastLine);

  if (!isLeadingPrompt) return null;

  // 提取问题文本：去掉末尾冒号，作为问题提示
  const question = lastLine.replace(/[：:]\s*$/, "").trim() || trimmed;

  void question;
  return null;
}
