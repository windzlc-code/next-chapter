import type { ComposerQuestion, ConversationProjectSnapshot } from "./types";

export interface AutoResearchTaskSpec {
  id: string;
  title: string;
  prompt: string;
}

export interface AutoResearchPlan {
  reason: string;
  kickoff: string;
  tasks: AutoResearchTaskSpec[];
}

function normalizeInput(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function containsAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function buildProjectPrefix(snapshot: ConversationProjectSnapshot | null): string {
  if (!snapshot) return "当前是一个新需求。";
  return `当前项目《${snapshot.title}》，阶段为 ${snapshot.derivedStage}，当前目标是：${snapshot.currentObjective || snapshot.agentSummary}。`;
}

function buildKickoff(titles: string[]): string {
  return `我先并行研究 ${titles.length} 个方向：${titles.join("、")}。你可以继续补充要求，结果会自动回流到当前会话。`;
}

function buildScriptResearchPlan(
  prompt: string,
  snapshot: ConversationProjectSnapshot | null,
): AutoResearchPlan {
  const prefix = buildProjectPrefix(snapshot);
  const tasks: AutoResearchTaskSpec[] = [
    {
      id: "market-fit",
      title: "目标市场",
      prompt: `${prefix}请只研究这个需求最匹配的目标市场、受众和平台分发方向。用户原始要求：${prompt}`,
    },
    {
      id: "style-route",
      title: "风格路线",
      prompt: `${prefix}请只研究这个需求最适合的风格路线、叙事调性和钩子表达方式。用户原始要求：${prompt}`,
    },
    {
      id: "hook-structure",
      title: "卖点结构",
      prompt: `${prefix}请只研究这个项目最值得优先放大的卖点、人物关系和开篇结构。用户原始要求：${prompt}`,
    },
  ];

  return {
    reason: "script-research",
    kickoff: buildKickoff(tasks.map((task) => task.title)),
    tasks,
  };
}

function buildAdaptationResearchPlan(
  prompt: string,
  snapshot: ConversationProjectSnapshot | null,
): AutoResearchPlan {
  const prefix = buildProjectPrefix(snapshot);
  const tasks: AutoResearchTaskSpec[] = [
    {
      id: "adaptation-route",
      title: "改编路线",
      prompt: `${prefix}请只研究这个参考改编需求最可行的改编路线，包括保留什么、重做什么。用户原始要求：${prompt}`,
    },
    {
      id: "audience-fit",
      title: "受众适配",
      prompt: `${prefix}请只研究这个改编需求对目标受众和市场的适配策略。用户原始要求：${prompt}`,
    },
    {
      id: "character-shift",
      title: "角色重塑",
      prompt: `${prefix}请只研究这个改编需求最值得重塑的人物关系和角色卖点。用户原始要求：${prompt}`,
    },
  ];

  return {
    reason: "adaptation-research",
    kickoff: buildKickoff(tasks.map((task) => task.title)),
    tasks,
  };
}

function buildVideoResearchPlan(
  prompt: string,
  snapshot: ConversationProjectSnapshot | null,
): AutoResearchPlan {
  const prefix = buildProjectPrefix(snapshot);
  const tasks: AutoResearchTaskSpec[] = [
    {
      id: "platform-packaging",
      title: "平台包装",
      prompt: `${prefix}请只研究这个视频需求在不同平台上的包装方式、节奏和首屏抓力。用户原始要求：${prompt}`,
    },
    {
      id: "visual-direction",
      title: "视觉方向",
      prompt: `${prefix}请只研究这个视频需求最适合的视觉语言、镜头风格和氛围策略。用户原始要求：${prompt}`,
    },
    {
      id: "production-path",
      title: "出片策略",
      prompt: `${prefix}请只研究这个视频需求最稳妥的出片路径、资产准备和批量推进方式。用户原始要求：${prompt}`,
    },
  ];

  return {
    reason: "video-research",
    kickoff: buildKickoff(tasks.map((task) => task.title)),
    tasks,
  };
}

export function buildAutoResearchPlan(
  rawPrompt: string,
  snapshot: ConversationProjectSnapshot | null,
): AutoResearchPlan | null {
  const prompt = normalizeInput(rawPrompt);
  if (!prompt) return null;

  const hasResearchIntent = containsAny(prompt, [
    "分析",
    "研究",
    "比较",
    "对比",
    "定位",
    "方向",
    "策略",
    "适合",
    "怎么做更好",
  ]);

  if (!hasResearchIntent) return null;

  const lowerKind = snapshot?.projectKind;
  const isVideo =
    lowerKind === "video" || containsAny(prompt, ["视频", "分镜", "出片", "预告片", "提示词", "平台包装"]);
  const isAdaptation =
    lowerKind === "adaptation" || containsAny(prompt, ["改编", "参考", "转译", "重塑"]);

  if (isVideo) return buildVideoResearchPlan(prompt, snapshot);
  if (isAdaptation) return buildAdaptationResearchPlan(prompt, snapshot);
  return buildScriptResearchPlan(prompt, snapshot);
}

export function buildResearchPromptOverlay(plan: AutoResearchPlan, taskIds: string[]): string {
  const lines = plan.tasks.map((task, index) => {
    const taskId = taskIds[index] ?? "unknown";
    return `- ${task.title}（后台任务 ${taskId}）`;
  });

  return [
    "系统提示：我已自动启动并行研究，请不要重复创建同类研究任务。",
    "后台研究方向：",
    ...lines,
    "请在前台会话里继续推进主线，等后台结果回流后再整合。",
  ].join("\n");
}

export function buildAutoResearchChoiceQuestion(plan: AutoResearchPlan): ComposerQuestion {
  return buildAutoResearchStepQuestion(plan, 0) as ComposerQuestion;
}

function buildAutoResearchStepOptions(task: AutoResearchTaskSpec): Array<{
  id: string;
  label: string;
  rationale?: string;
}> {
  if (task.id === "market-fit" || task.title.includes("目标市场")) {
    return [
      { id: "cn-zh", label: "中国（中文）", rationale: "面向中文用户与中文平台生态。" },
      { id: "us-eu-en", label: "欧美（英文）", rationale: "面向英语用户与海外平台分发。" },
      { id: "jp-kr", label: "日韩（本地语）", rationale: "面向日语/韩语语境与审美偏好。" },
      { id: "sea", label: "东南亚（英语/本地语）", rationale: "兼顾英语与本地化语境，重短视频扩散。" },
      { id: "global", label: "全球多语", rationale: "从一开始按多语言版本规划。" },
      { id: "uncertain", label: "暂不确定，先给推荐", rationale: "由系统先给默认市场建议。" },
    ];
  }

  if (task.id === "style-route" || task.title.includes("风格路线")) {
    return [
      { id: "short-hook", label: "短平快强钩子", rationale: "前 3-5 秒抓人，适合短视频平台分发。" },
      { id: "emotion-share", label: "情绪共鸣可分享", rationale: "强调情绪击中与转发讨论，适合社媒扩散。" },
      { id: "realist-trust", label: "现实纪实可信感", rationale: "强调真实语境与可信表达，利于信任沉淀。" },
      { id: "premium-brand", label: "高级质感品牌向", rationale: "强调画面质感与调性统一，利于品牌化内容。" },
      { id: "uncertain", label: "暂不确定，先给推荐", rationale: "由系统先给默认风格路线。" },
    ];
  }

  if (task.id === "hook-structure" || task.title.includes("卖点结构")) {
    return [
      { id: "opening-hook", label: "开场钩子优先", rationale: "优先保证首屏停留与前段完播。" },
      { id: "character-hook", label: "人物关系卖点优先", rationale: "通过角色关系拉扯提升持续追更。" },
      { id: "twist-hook", label: "连续反转卖点优先", rationale: "通过节奏反转提升留存与讨论。" },
      { id: "emotion-hook", label: "情绪金句传播优先", rationale: "优先打造可截取、可传播的情绪点。" },
      { id: "uncertain", label: "暂不确定，先给推荐", rationale: "由系统先给默认卖点结构。" },
    ];
  }

  return [
    { id: "default-a", label: `偏保守推进（${task.title}）` },
    { id: "default-b", label: `偏激进突破（${task.title}）` },
    { id: "default-c", label: "暂不确定，先给推荐" },
  ];
}

export function buildAutoResearchStepQuestion(
  plan: AutoResearchPlan,
  stepIndex: number,
): ComposerQuestion | null {
  const task = plan.tasks[stepIndex];
  if (!task) return null;
  const current = stepIndex + 1;
  const total = plan.tasks.length;

  return {
    id: `auto-research:step:${stepIndex}`,
    title: `快捷研究（${current}/${total}）`,
    description:
      task.title === "目标市场"
        ? "目标市场你更想优先哪类方向？"
        : task.title === "风格路线"
          ? "风格路线你更倾向哪种市场表达？"
          : task.title === "卖点结构"
            ? "卖点结构你想先押哪种增长抓手？"
            : `请先选择「${task.title}」的方向。`,
    options: buildAutoResearchStepOptions(task).map((option) => ({
      id: `auto-research-step-${stepIndex}-${option.id}`,
      label: option.label,
      value: `auto-research:step:${stepIndex}:pick:${option.id}`,
      rationale: option.rationale,
    })),
    allowCustomInput: false,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex,
    totalSteps: total,
    answerKey: "auto-research-step-choice",
  };
}
