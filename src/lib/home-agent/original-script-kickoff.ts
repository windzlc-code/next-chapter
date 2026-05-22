import type { AskUserQuestionRequest } from "@/lib/agent/tools/ask-user-question";
import type { HomeAgentMessage, StudioQuestionState } from "@/lib/home-agent/types";
import type { DramaSetup } from "@/types/drama";
import { AUDIENCES, ENDINGS, GENRES, TARGET_MARKETS, TONES } from "@/types/drama";

export const ORIGINAL_SCRIPT_TEMPLATE_ID = "script";
const ORIGINAL_SCRIPT_REQUEST_PREFIX = "original-script-kickoff";

const DEFAULT_AUDIENCE = "女频";
const DEFAULT_TONE = "甜虐";
const DEFAULT_ENDING = "HE";
const DEFAULT_TARGET_MARKET = "cn";
const DEFAULT_TOTAL_EPISODES = 60;

const DEFAULT_CONFIG_SUMMARY = "默认：女频 / 甜虐 / HE / 60集";

type OriginalScriptKickoffStep =
  | "setup-mode"
  | "target-market"
  | "genres"
  | "creative-input"
  | "config-profile"
  | "audience"
  | "tone"
  | "ending"
  | "word-count"
  | "custom-topic";

type OriginalScriptSetupMode = "topic" | "creative";

type KickoffAnswerKey =
  | "setupMode"
  | "targetMarket"
  | "genres"
  | "creativeInput"
  | "configProfile"
  | "audience"
  | "tone"
  | "ending"
  | "wordCount"
  | "customTopic";

type KickoffAnswers = Partial<Record<KickoffAnswerKey, string>>;
type KickoffDisplayAnswers = Partial<Record<KickoffAnswerKey, string>>;

const KICKOFF_CHAT_TURN_PATTERNS = [
  /^(?:你好|您好|哈喽|嗨|hello|hi|早上好|中午好|下午好|晚上好|在吗|在么|在不在)[!！。,.?？]*$/i,
  /^(?:收到|好的|好哦|ok|okay|明白|先等等|稍等|等下|暂停|继续|下一步)[!！。,.?？]*$/i,
  /(什么意思|啥意思|为什么|为啥|怎么选|怎么填|怎么定|区别是|有什么区别|解释一下|介绍一下|说说看|说说|讲讲|先聊聊|先分析一下|先讨论一下|比较一下|适合什么|自然语言|拿不准|没想好|不太确定|帮我判断|你来定|你决定)/,
] as const;

export interface OriginalScriptKickoffCompletion {
  setupInput: Record<string, unknown>;
  userBubble: string;
  structuredSummary: string;
}

const ORIGINAL_SCRIPT_WORD_COUNTS = [
  { value: "40集（紧凑）", label: "40集（紧凑）", description: "节奏紧凑，适合高密度冲突和快速反转。", totalEpisodes: 40 },
  { value: "60集（标准）", label: "60集（标准）", description: "标准篇幅，人物动机与情节推进均衡。", totalEpisodes: 60 },
  { value: "80集（长线）", label: "80集（长线）", description: "长线叙事，适合多线并行和关系铺垫。", totalEpisodes: 80 },
  { value: "100集（超长）", label: "100集（超长）", description: "超长篇幅，适合宏大格局和多角色群像。", totalEpisodes: 100 },
] as const;

const EXAMPLE_CREATIVE_OPTIONS = [
  {
    label: "豪门契约 + 身份反转",
    value: "替父还债的普通女孩被迫签下豪门契约婚姻，却发现冷面继承人正在借她布局一场更大的身份反转。",
    rationale: "适合走高钩子情感反转路线。",
  },
  {
    label: "古风宅斗 + 商战逆袭",
    value: "穿越成将军府庶女的现代白领，用现代经营思路在古代后宅与商场双线逆袭。",
    rationale: "适合古风爽感和女性成长线。",
  },
  {
    label: "都市悬爱 + 双强博弈",
    value: "女律师在调查旧案时被迫与嫌疑人继承人联手，两人一边互相试探，一边揭开上一代的谋局。",
    rationale: "适合悬疑和高张力情感并行。",
  },
] as const;

function buildGenreRationale(genre: (typeof GENRES)[number]): string {
  return `${genre.category} · ${genre.desc} · 受众：${genre.audience}`;
}

function isKickoffStep(value: string): value is OriginalScriptKickoffStep {
  return [
    "setup-mode",
    "target-market",
    "genres",
    "creative-input",
    "config-profile",
    "audience",
    "tone",
    "ending",
    "word-count",
    "custom-topic",
  ].includes(value);
}

function parseKickoffRequestMeta(requestId: string): { flowId: string; step: OriginalScriptKickoffStep } | null {
  const parts = requestId.split(":");
  if (parts.length < 3) return null;
  if (parts[0] !== ORIGINAL_SCRIPT_REQUEST_PREFIX) return null;
  const flowId = parts[1]?.trim();
  const step = parts[2]?.trim();
  if (!flowId || !step || !isKickoffStep(step)) return null;
  return { flowId, step };
}

function normalizeSetupMode(value: string | undefined): OriginalScriptSetupMode {
  return value === "creative" ? "creative" : "topic";
}

function normalizeKickoffInput(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。！？、,.!?\-_/（）()【】[\]“”"'`~:：；;]/g, "");
}

function matchesKickoffOptionText(
  value: string,
  options: Array<{ label?: string; value?: string }> | undefined,
): boolean {
  const normalizedValue = normalizeKickoffInput(value);
  if (!normalizedValue || !options?.length) return false;

  return options.some((option) => {
    const candidates = [option.label, option.value]
      .map((item) => normalizeKickoffInput(String(item || "")))
      .filter(Boolean);
    return candidates.some((candidate) => candidate === normalizedValue || normalizedValue.includes(candidate));
  });
}

function isLikelyKickoffConversationTurn(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (KICKOFF_CHAT_TURN_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  return /[?？]$/.test(trimmed) && /(什么|怎么|为何|为啥|区别|要不要|行不行|可以吗)/.test(trimmed);
}

function matchesOriginalKickoffAudienceAnswer(value: string): boolean {
  return /(女频|女性向|女性读者|年轻女性|都市女性|女生向|女生|女性|宝妈|男频|男性向|男性读者|男生向|男生|男性|全年龄|全龄|大众向|泛人群|不知道|不确定|暂不确定|先给建议|你先给建议|都行)/i.test(
    value,
  );
}

function matchesOriginalKickoffToneAnswer(value: string): boolean {
  return /(甜虐|甜宠|甜|虐|爽|燃|热血|搞笑|喜剧|轻喜|治愈|温暖|压抑|黑暗)/.test(value);
}

function matchesOriginalKickoffEndingAnswer(value: string): boolean {
  return /(?:\bHE\b|\bBE\b|\bOE\b|好结局|坏结局|悲剧|遗憾|开放式?|圆满|团圆)/i.test(value);
}

function matchesOriginalKickoffWordCountAnswer(value: string): boolean {
  const normalized = value.trim();
  if (/^\d{1,4}$/.test(normalized) || /^\d{1,4}\s*集$/i.test(normalized)) {
    return true;
  }
  return /(?:\b\d{1,3}\s*集\b|\d{1,3}\s*episodes?|\d{1,3}集|短一点|短篇|短线|标准|长线|超长)/i.test(
    value,
  );
}

function getDisplayValue(
  answers: KickoffDisplayAnswers,
  key: KickoffAnswerKey,
  fallback: string,
): string {
  return answers[key]?.trim() || fallback;
}

function formatWordCountByTotalEpisodes(totalEpisodes: number): string {
  const matched = ORIGINAL_SCRIPT_WORD_COUNTS.find((item) => item.totalEpisodes === totalEpisodes);
  return matched?.label ?? `${totalEpisodes}集`;
}

function coerceWordCountTotalEpisodes(value: string | undefined): number {
  const matched = ORIGINAL_SCRIPT_WORD_COUNTS.find((item) => item.value === value || item.label === value);
  if (matched) return matched.totalEpisodes;
  const numeric = Number.parseInt((value || "").replace(/[^\d]/g, ""), 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : DEFAULT_TOTAL_EPISODES;
}

function buildKickoffQuestionRequest(
  flowId: string,
  step: OriginalScriptKickoffStep,
  answers: KickoffAnswers,
  displayAnswers: KickoffDisplayAnswers,
): AskUserQuestionRequest {
  const setupMode = normalizeSetupMode(answers.setupMode);
  const targetMarket = answers.targetMarket || DEFAULT_TARGET_MARKET;

  switch (step) {
    case "setup-mode":
      return {
        id: `${ORIGINAL_SCRIPT_REQUEST_PREFIX}:${flowId}:setup-mode`,
        title: "原创剧本立项",
        description: `先确定起点，再由 Agent 在首页继续收口。${DEFAULT_CONFIG_SUMMARY} 可直接沿用。`,
        allowCustomInput: false,
        submissionMode: "immediate",
        questions: [
          {
            header: "创作方式",
            question: "这次想从哪种方式开始原创剧本？",
            multiSelect: false,
            options: [
              {
                label: "选题创作",
                value: "topic",
                rationale: "先定市场和题材，再沿用传统面板默认配置快速进入人设开发。",
              },
              {
                label: "创意创作",
                value: "creative",
                rationale: "先把你现有的创意或文档摘要交给我，再按需要补充配置。",
              },
            ],
          },
        ],
      };
    case "target-market":
      return {
        id: `${ORIGINAL_SCRIPT_REQUEST_PREFIX}:${flowId}:target-market`,
        title: "目标市场",
        description:
          setupMode === "topic"
            ? "先定市场，再给你过滤对应的题材选项。"
            : "先定市场，再承接你的创意内容。",
        allowCustomInput: false,
        submissionMode: "immediate",
        questions: [
          {
            header: "目标市场",
            question: "这次原创剧本主要想打哪个目标市场？",
            multiSelect: false,
            options: TARGET_MARKETS.map((market) => ({
              label: market.label,
              value: market.value,
              rationale:
                market.value === DEFAULT_TARGET_MARKET
                  ? `${market.desc} · 默认市场`
                  : market.desc,
            })),
          },
        ],
      };
    case "genres": {
      type GenreMarket = (typeof GENRES)[number]["markets"][number];
      const genreOptions = GENRES.filter((genre) =>
        (genre.markets as readonly string[]).includes(targetMarket),
      ) as typeof GENRES[number][];
      const visibleOptions =
        genreOptions.length > 0
          ? genreOptions
          : GENRES.filter((genre) => (genre.markets as readonly string[]).includes("cn")).slice(0, 12) as typeof GENRES[number][];
      return {
        id: `${ORIGINAL_SCRIPT_REQUEST_PREFIX}:${flowId}:genres`,
        title: "题材选择",
        description:
          genreOptions.length > 0
            ? "参考传统创作面板，最多选 2 个更贴近你这次方向的题材。"
            : "这个市场暂时没有完整预设，我先给你一组通用题材，也可以直接自定义输入。",
        allowCustomInput: true,
        submissionMode: "confirm",
        questions: [
          {
            header: "题材选择",
            question: "先选 1 到 2 个更接近你这次方向的题材。",
            multiSelect: true,
            options: visibleOptions.map((genre) => ({
              label: genre.label,
              value: genre.value,
              rationale: buildGenreRationale(genre),
            })),
          },
        ],
      };
    }
    case "creative-input":
      return {
        id: `${ORIGINAL_SCRIPT_REQUEST_PREFIX}:${flowId}:creative-input`,
        title: "创意输入",
        description: "直接在输入框里写你的创意想法，也可以粘贴文档摘要；下方是 3 个快速示例。",
        allowCustomInput: true,
        submissionMode: "immediate",
        questions: [
          {
            header: "创意内容",
            question: "把你的创意想法、故事灵感或文档摘要直接发给我。",
            multiSelect: false,
            options: EXAMPLE_CREATIVE_OPTIONS.map((item) => ({
              label: item.label,
              value: item.value,
              rationale: item.rationale,
            })),
          },
        ],
      };
    case "config-profile":
      return {
        id: `${ORIGINAL_SCRIPT_REQUEST_PREFIX}:${flowId}:config-profile`,
        title: "创作配置",
        description: DEFAULT_CONFIG_SUMMARY,
        allowCustomInput: false,
        submissionMode: "immediate",
        questions: [
          {
            header: "配置策略",
            question: "这轮立项先沿用默认配置，还是逐项细调？",
            multiSelect: false,
            options: [
              {
                label: "我想逐项细调",
                value: "customize",
                rationale: "我会继续追问受众、基调、结局和篇幅。",
              },
            ],
          },
        ],
      };
    case "audience":
      return {
        id: `${ORIGINAL_SCRIPT_REQUEST_PREFIX}:${flowId}:audience`,
        title: "目标受众",
        description: `默认 ${DEFAULT_AUDIENCE}`,
        allowCustomInput: true,
        submissionMode: "immediate",
        questions: [
          {
            header: "目标受众",
            question: "这次更希望主打哪类受众？",
            multiSelect: false,
            presentation: "card",
            options: [
              ...AUDIENCES.map((audience) => ({
                label: audience.label,
                value: audience.value,
                rationale: audience.desc,
              })),
              {
                label: "暂不确定，先给建议",
                value: "暂不确定，先给建议",
                rationale: "先让我根据市场和题材给你一个更稳的受众建议，再继续后面的基调和结局。",
              },
            ],
          },
        ],
      };
    case "tone":
      return {
        id: `${ORIGINAL_SCRIPT_REQUEST_PREFIX}:${flowId}:tone`,
        title: "故事基调",
        description: `默认 ${DEFAULT_TONE}`,
        allowCustomInput: true,
        submissionMode: "immediate",
        questions: [
          {
            header: "故事基调",
            question: "先把故事基调定下来，方便 Agent 收口人物和节奏。",
            multiSelect: false,
            presentation: "card",
            options: TONES.map((tone) => ({
              label: tone.label,
              value: tone.value,
              rationale: tone.desc,
            })),
          },
        ],
      };
    case "ending":
      return {
        id: `${ORIGINAL_SCRIPT_REQUEST_PREFIX}:${flowId}:ending`,
        title: "结局类型",
        description: `默认 ${DEFAULT_ENDING}`,
        allowCustomInput: true,
        submissionMode: "immediate",
        questions: [
          {
            header: "结局类型",
            question: "你希望最终落在什么结局上？",
            multiSelect: false,
            presentation: "card",
            options: ENDINGS.map((ending) => ({
              label: ending.label,
              value: ending.value,
              rationale: ending.desc,
            })),
          },
        ],
      };
    case "word-count":
      return {
        id: `${ORIGINAL_SCRIPT_REQUEST_PREFIX}:${flowId}:word-count`,
        title: "集数规模",
        description: `默认 ${formatWordCountByTotalEpisodes(DEFAULT_TOTAL_EPISODES)}`,
        allowCustomInput: true,
        submissionMode: "immediate",
        questions: [
          {
            header: "集数规模",
            question: "先选一个更接近你的集数规模。",
            multiSelect: false,
            options: ORIGINAL_SCRIPT_WORD_COUNTS.map((count) => ({
              label: count.label,
              value: count.value,
              rationale: count.description,
            })),
          },
        ],
      };
    case "custom-topic":
      return {
        id: `${ORIGINAL_SCRIPT_REQUEST_PREFIX}:${flowId}:custom-topic`,
        title: "补充描述",
        description: "这一步可选，不补也能直接进入人设开发。",
        allowCustomInput: true,
        submissionMode: "immediate",
        questions: [
          {
            header: "补充描述",
            question: "最后还有没有一句话故事方向、主角设定或特殊要求要补充？",
            multiSelect: false,
            options: [
              {
                label: "暂不补充",
                value: "无",
                rationale: "先按上面的立项信息继续推进，后面也可以随时补充。",
                confirmDialog: {
                  title: "确认开始创作？",
                  description: "以下是你的立项配置，确认后将直接进入创作方案。",
                  confirmLabel: "确认，开始创作",
                  cancelLabel: "返回补充",
                  summaryRows: buildKickoffSummaryDisplay(displayAnswers),
                },
              },
            ],
          },
        ],
      };
  }
}

export function buildKickoffSummaryDisplay(answers: KickoffDisplayAnswers): string[] {
  const setupModeLabel = getDisplayValue(
    answers,
    "setupMode",
    normalizeSetupMode(answers.setupMode) === "creative" ? "创意创作" : "选题创作",
  );
  const targetMarketLabel = getDisplayValue(answers, "targetMarket", "国内（中文）");
  const configProfile = answers.configProfile?.trim() || DEFAULT_CONFIG_SUMMARY;

  const rows = [
    `创作方式：${setupModeLabel}`,
    `目标市场：${targetMarketLabel}`,
  ];

  if (normalizeSetupMode(answers.setupMode) === "creative") {
    const creativeInput = getDisplayValue(answers, "creativeInput", "").trim();
    rows.push(`创意内容：${creativeInput || "未填写"}`);
  } else {
    const genres = getDisplayValue(answers, "genres", "").trim();
    rows.push(`题材选择：${genres || "未填写"}`);
  }

  rows.push(`创作配置：${configProfile}`);

  const audience = getDisplayValue(answers, "audience", DEFAULT_AUDIENCE);
  const tone = getDisplayValue(answers, "tone", DEFAULT_TONE);
  const ending = getDisplayValue(answers, "ending", DEFAULT_ENDING);
  const wordCount = getDisplayValue(answers, "wordCount", formatWordCountByTotalEpisodes(DEFAULT_TOTAL_EPISODES));
  rows.push(`目标受众：${audience}`);
  rows.push(`故事基调：${tone}`);
  rows.push(`结局类型：${ending}`);
  rows.push(`集数规模：${wordCount}`);

  if (answers.customTopic?.trim() && answers.customTopic !== "无") {
    rows.push(`补充描述：${answers.customTopic.trim()}`);
  }

  return rows;
}

function buildKickoffStructuredSetup(
  answers: KickoffAnswers,
  displayAnswers: KickoffDisplayAnswers,
): OriginalScriptKickoffCompletion {
  const setupMode = normalizeSetupMode(answers.setupMode);
  const targetMarket = answers.targetMarket || DEFAULT_TARGET_MARKET;
  const totalEpisodes = coerceWordCountTotalEpisodes(
    answers.wordCount || formatWordCountByTotalEpisodes(DEFAULT_TOTAL_EPISODES),
  );
  const genreValues =
    setupMode === "topic"
      ? (answers.genres || "")
          .split("/")
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, 2)
      : [];

  const structuredSetup: DramaSetup = {
    genres: genreValues,
    audience: answers.audience || DEFAULT_AUDIENCE,
    tone: answers.tone || DEFAULT_TONE,
    ending: answers.ending || DEFAULT_ENDING,
    totalEpisodes,
    targetMarket,
    customTopic:
      setupMode === "topic" && answers.customTopic && answers.customTopic !== "无"
        ? answers.customTopic.trim()
        : undefined,
    setupMode,
    creativeInput: setupMode === "creative" ? answers.creativeInput?.trim() || undefined : undefined,
  };

  const summaryLines = buildKickoffSummaryDisplay(displayAnswers);
  const shortParts = [
    getDisplayValue(displayAnswers, "setupMode", setupMode === "creative" ? "创意创作" : "选题创作"),
    getDisplayValue(displayAnswers, "targetMarket", "国内（中文）"),
    setupMode === "creative"
      ? "已收下创意内容"
      : getDisplayValue(displayAnswers, "genres", "未设定题材"),
    answers.configProfile === "customize" ? "已细调配置" : "沿用默认配置",
  ];

  return {
    setupInput: {
      ...structuredSetup,
      projectKind: "script",
    },
    userBubble: `原创剧本立项：${shortParts.filter(Boolean).join(" / ")}`,
    structuredSummary: summaryLines.join("\n"),
  };
}

function nextKickoffStep(step: OriginalScriptKickoffStep, answers: KickoffAnswers): OriginalScriptKickoffStep | null {
  switch (step) {
    case "setup-mode":
      return "target-market";
    case "target-market":
      return normalizeSetupMode(answers.setupMode) === "creative" ? "creative-input" : "genres";
    case "genres":
    case "creative-input":
      return "audience";
    case "config-profile":
      return answers.configProfile === "customize" ? "audience" : normalizeSetupMode(answers.setupMode) === "topic" ? "custom-topic" : null;
    case "audience":
      return "tone";
    case "tone":
      return "ending";
    case "ending":
      return "word-count";
    case "word-count":
      return normalizeSetupMode(answers.setupMode) === "topic" ? "custom-topic" : null;
    case "custom-topic":
      return null;
    default:
      return null;
  }
}

function writeKickoffAnswer(
  answers: KickoffAnswers,
  displayAnswers: KickoffDisplayAnswers,
  step: OriginalScriptKickoffStep,
  submittedValue: string,
  displayValue: string,
): { nextAnswers: KickoffAnswers; nextDisplayAnswers: KickoffDisplayAnswers; bubble: string } {
  switch (step) {
    case "setup-mode":
      return {
        nextAnswers: { ...answers, setupMode: submittedValue },
        nextDisplayAnswers: { ...displayAnswers, setupMode: displayValue },
        bubble: `创作方式：${displayValue}`,
      };
    case "target-market":
      return {
        nextAnswers: { ...answers, targetMarket: submittedValue },
        nextDisplayAnswers: { ...displayAnswers, targetMarket: displayValue },
        bubble: `目标市场：${displayValue}`,
      };
    case "genres": {
      const picked = submittedValue
        .split("/")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 2);
      const pickedDisplay = displayValue
        .split("/")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 2);
      const genreAnswer = picked.join(" / ");
      const genreDisplay = pickedDisplay.join(" / ");
      return {
        nextAnswers: { ...answers, genres: genreAnswer },
        nextDisplayAnswers: { ...displayAnswers, genres: genreDisplay },
        bubble: `题材选择：${genreDisplay}`,
      };
    }
    case "creative-input":
      return {
        nextAnswers: { ...answers, creativeInput: submittedValue.trim() },
        nextDisplayAnswers: { ...displayAnswers, creativeInput: displayValue.trim() },
        bubble: `创意内容：${displayValue.trim()}`,
      };
    case "config-profile":
      return {
        nextAnswers: { ...answers, configProfile: submittedValue },
        nextDisplayAnswers: {
          ...displayAnswers,
          configProfile: submittedValue === "customize" ? "自定义配置" : DEFAULT_CONFIG_SUMMARY,
        },
        bubble: submittedValue === "customize" ? "创作配置：我想逐项细调" : `创作配置：${DEFAULT_CONFIG_SUMMARY}`,
      };
    case "audience":
      return {
        nextAnswers: { ...answers, audience: submittedValue },
        nextDisplayAnswers: { ...displayAnswers, audience: displayValue },
        bubble: `目标受众：${displayValue}`,
      };
    case "tone":
      return {
        nextAnswers: { ...answers, tone: submittedValue },
        nextDisplayAnswers: { ...displayAnswers, tone: displayValue },
        bubble: `故事基调：${displayValue}`,
      };
    case "ending":
      return {
        nextAnswers: { ...answers, ending: submittedValue },
        nextDisplayAnswers: { ...displayAnswers, ending: displayValue },
        bubble: `结局类型：${displayValue}`,
      };
    case "word-count":
      return {
        nextAnswers: { ...answers, wordCount: submittedValue },
        nextDisplayAnswers: { ...displayAnswers, wordCount: displayValue },
        bubble: `集数规模：${displayValue}`,
      };
    case "custom-topic":
      return {
        nextAnswers: { ...answers, customTopic: submittedValue.trim() },
        nextDisplayAnswers: { ...displayAnswers, customTopic: displayValue.trim() },
        bubble: `补充描述：${displayValue.trim()}`,
      };
  }
}

export function isOriginalScriptKickoffRequest(request: Pick<AskUserQuestionRequest, "id"> | null | undefined): boolean {
  return Boolean(request?.id?.startsWith(ORIGINAL_SCRIPT_REQUEST_PREFIX));
}

export function isOriginalScriptKickoffGenreQuestion(question: { id: string } | null | undefined): boolean {
  return Boolean(question?.id.includes(":genres:") || question?.id.endsWith(":genres"));
}

export function shouldTreatOriginalScriptKickoffInputAsAnswer(params: {
  qState: StudioQuestionState;
  draft: string;
}): boolean {
  const { qState, draft } = params;
  const trimmed = draft.trim();
  if (!trimmed) return false;

  const meta = parseKickoffRequestMeta(qState.request.id);
  if (!meta) return false;
  if (isLikelyKickoffConversationTurn(trimmed)) return false;

  const activeQuestion =
    qState.request.questions[qState.currentIndex] ??
    qState.request.questions[0];
  const options = activeQuestion?.options;

  switch (meta.step) {
    case "audience":
      return matchesKickoffOptionText(trimmed, options) || matchesOriginalKickoffAudienceAnswer(trimmed);
    case "tone":
      return matchesKickoffOptionText(trimmed, options) || matchesOriginalKickoffToneAnswer(trimmed);
    case "ending":
      return matchesKickoffOptionText(trimmed, options) || matchesOriginalKickoffEndingAnswer(trimmed);
    case "word-count":
      return matchesKickoffOptionText(trimmed, options) || matchesOriginalKickoffWordCountAnswer(trimmed);
    case "creative-input":
    case "custom-topic":
      if (matchesKickoffOptionText(trimmed, options)) return true;
      return trimmed.length >= 4;
    case "setup-mode":
    case "target-market":
    case "config-profile":
      return matchesKickoffOptionText(trimmed, options);
    case "genres":
      return false;
    default:
      return false;
  }
}

function prevKickoffStep(step: OriginalScriptKickoffStep, answers: KickoffAnswers): OriginalScriptKickoffStep | null {
  switch (step) {
    case "setup-mode":
      return null;
    case "target-market":
      return "setup-mode";
    case "genres":
    case "creative-input":
      return "target-market";
    case "config-profile":
      return normalizeSetupMode(answers.setupMode) === "creative" ? "creative-input" : "genres";
    case "audience":
      return normalizeSetupMode(answers.setupMode) === "creative" ? "creative-input" : "genres";
    case "tone":
      return "audience";
    case "ending":
      return "tone";
    case "word-count":
      return "ending";
    case "custom-topic":
      return "word-count";
    default:
      return null;
  }
}

export function canRewindOriginalScriptKickoff(qState: StudioQuestionState): boolean {
  const meta = parseKickoffRequestMeta(qState.request.id);
  if (!meta) return false;
  return prevKickoffStep(meta.step, qState.answers as KickoffAnswers) !== null;
}

export function rewindOriginalScriptKickoff(qState: StudioQuestionState): StudioQuestionState | null {
  const meta = parseKickoffRequestMeta(qState.request.id);
  if (!meta) return null;
  const answers = qState.answers as KickoffAnswers;
  const prevStep = prevKickoffStep(meta.step, answers);
  if (!prevStep) return null;
  // Clear the answer for the step we're going back to
  const stepToAnswerKey: Partial<Record<OriginalScriptKickoffStep, KickoffAnswerKey>> = {
    "setup-mode": "setupMode",
    "target-market": "targetMarket",
    genres: "genres",
    "creative-input": "creativeInput",
    "config-profile": "configProfile",
    audience: "audience",
    tone: "tone",
    ending: "ending",
    "word-count": "wordCount",
    "custom-topic": "customTopic",
  };
  const clearKey = stepToAnswerKey[prevStep];
  const clearedAnswers: KickoffAnswers = clearKey ? { ...answers, [clearKey]: undefined } : { ...answers };
  const clearedDisplayAnswers: KickoffDisplayAnswers = clearKey
    ? { ...(qState.displayAnswers as KickoffDisplayAnswers), [clearKey]: undefined }
    : { ...(qState.displayAnswers as KickoffDisplayAnswers) };
  return {
    source: qState.source,
    request: buildKickoffQuestionRequest(meta.flowId, prevStep, clearedAnswers, clearedDisplayAnswers),
    currentIndex: 0,
    answers: clearedAnswers,
    displayAnswers: clearedDisplayAnswers,
  };
}

export function rewindOriginalScriptKickoffMessages(messages: HomeAgentMessage[]): HomeAgentMessage[] {
  if (messages.length < 2) return messages;

  let trailingAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") {
      trailingAssistantIndex = i;
      break;
    }
  }

  if (trailingAssistantIndex === -1) return messages;

  let answerIndex = -1;
  for (let i = trailingAssistantIndex - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      answerIndex = i;
      break;
    }
    if (messages[i]?.role === "assistant") {
      break;
    }
  }

  if (answerIndex === -1) {
    return [...messages.slice(0, trailingAssistantIndex), ...messages.slice(trailingAssistantIndex + 1)];
  }

  return [...messages.slice(0, answerIndex), ...messages.slice(trailingAssistantIndex + 1)];
}

export function buildOriginalScriptKickoffIntro(): string {
  return `我们先按传统创作面板把原创剧本立项定下来。第一步先选“选题创作”或“创意创作”；如果你不想逐项细调，我会默认按 ${DEFAULT_CONFIG_SUMMARY} 继续，并直接把结果写入项目，下一步就进入人设开发。`;
}

export function buildOriginalScriptKickoffRequest(): AskUserQuestionRequest {
  return buildKickoffQuestionRequest(crypto.randomUUID(), "setup-mode", {}, {});
}

export function buildOriginalScriptKickoffBlueprintRequests(): AskUserQuestionRequest[] {
  const flowId = "workflow-blueprint";
  const defaultTargetMarketLabel =
    TARGET_MARKETS.find((item) => item.value === DEFAULT_TARGET_MARKET)?.label || "国内（中文）";

  return [
    buildKickoffQuestionRequest(flowId, "setup-mode", {}, {}),
    buildKickoffQuestionRequest(
      flowId,
      "target-market",
      { setupMode: "topic" },
      { setupMode: "选题创作" },
    ),
    buildKickoffQuestionRequest(
      flowId,
      "genres",
      { setupMode: "topic", targetMarket: DEFAULT_TARGET_MARKET },
      {
        setupMode: "选题创作",
        targetMarket: defaultTargetMarketLabel,
      },
    ),
    buildKickoffQuestionRequest(
      flowId,
      "target-market",
      { setupMode: "creative" },
      { setupMode: "创意创作" },
    ),
    buildKickoffQuestionRequest(
      flowId,
      "creative-input",
      { setupMode: "creative", targetMarket: DEFAULT_TARGET_MARKET },
      {
        setupMode: "创意创作",
        targetMarket: defaultTargetMarketLabel,
      },
    ),
    buildKickoffQuestionRequest(flowId, "config-profile", { setupMode: "topic" }, {}),
    buildKickoffQuestionRequest(flowId, "audience", { setupMode: "topic" }, {}),
    buildKickoffQuestionRequest(flowId, "tone", { setupMode: "topic" }, {}),
    buildKickoffQuestionRequest(flowId, "ending", { setupMode: "topic" }, {}),
    buildKickoffQuestionRequest(flowId, "word-count", { setupMode: "topic" }, {}),
    buildKickoffQuestionRequest(flowId, "custom-topic", { setupMode: "topic" }, {}),
  ];
}

export function buildOriginalScriptKickoffPrompt(answer: string): string {
  const cleaned = answer.trim();
  return [
    "我要启动一个原创剧本项目。",
    "下面是我刚按传统创作面板确认的立项信息：",
    cleaned,
    "立项信息已经写入项目，创作方案也已经同步生成完毕。请直接向我展示创作方案的核心内容（核心冲突、故事方向、主要看点），然后等待我选择下一步，不要再调用任何工作流工具。",
  ].join("\n\n");
}

export function advanceOriginalScriptKickoff(params: {
  qState: StudioQuestionState;
  value: string;
  label?: string;
}): {
  userBubble: string;
  nextQState: StudioQuestionState | null;
  completion: OriginalScriptKickoffCompletion | null;
} | null {
  const { qState, value, label } = params;
  const meta = parseKickoffRequestMeta(qState.request.id);
  const activeQuestion = qState.request.questions[0];
  if (!meta || !activeQuestion) return null;

  const submittedValue = value.trim();
  const displayValue = (label || value).trim();
  if (!submittedValue) return null;

  const answers = qState.answers as KickoffAnswers;
  const displayAnswers = qState.displayAnswers as KickoffDisplayAnswers;
  const written = writeKickoffAnswer(answers, displayAnswers, meta.step, submittedValue, displayValue);
  const nextStep = nextKickoffStep(meta.step, written.nextAnswers);

  if (!nextStep) {
    return {
      userBubble: written.bubble,
      nextQState: null,
      completion: buildOriginalScriptKickoffStructuredSetup(written.nextAnswers, written.nextDisplayAnswers),
    };
  }

  return {
    userBubble: written.bubble,
    nextQState: {
      source: qState.source,
      request: buildKickoffQuestionRequest(meta.flowId, nextStep, written.nextAnswers, written.nextDisplayAnswers),
      currentIndex: 0,
      answers: written.nextAnswers,
      displayAnswers: written.nextDisplayAnswers,
    },
    completion: null,
  };
}

function buildOriginalScriptKickoffStructuredSetup(
  answers: KickoffAnswers,
  displayAnswers: KickoffDisplayAnswers,
): OriginalScriptKickoffCompletion {
  if (!answers.audience) answers.audience = DEFAULT_AUDIENCE;
  if (!displayAnswers.audience) displayAnswers.audience = DEFAULT_AUDIENCE;
  if (!answers.tone) answers.tone = DEFAULT_TONE;
  if (!displayAnswers.tone) displayAnswers.tone = DEFAULT_TONE;
  if (!answers.ending) answers.ending = DEFAULT_ENDING;
  if (!displayAnswers.ending) displayAnswers.ending = DEFAULT_ENDING;
  if (!answers.wordCount) answers.wordCount = formatWordCountByTotalEpisodes(DEFAULT_TOTAL_EPISODES);
  if (!displayAnswers.wordCount) displayAnswers.wordCount = formatWordCountByTotalEpisodes(DEFAULT_TOTAL_EPISODES);
  if (!answers.targetMarket) answers.targetMarket = DEFAULT_TARGET_MARKET;
  if (!displayAnswers.targetMarket) {
    const market = TARGET_MARKETS.find((item) => item.value === DEFAULT_TARGET_MARKET);
    displayAnswers.targetMarket = market?.label || "国内（中文）";
  }
  return buildKickoffStructuredSetup(answers, displayAnswers);
}
