// 短剧创作各阶段 Prompt 模板
// 从 short-drama 仓库提取并优化

import type { DramaSetup, EpisodeEntry } from "@/types/drama";

/** 目标市场描述与创作语言指令 */
function getMarketDirective(setup: DramaSetup): string {
  const market = setup.targetMarket || "cn";
  if (market === "jp") {
    return `## 🌏 目標市場：日本
- **創作言語：日本語** —— すべての出力は日本語で記述すること。
- **美学傾向**：物哀（もののあわれ）、幽玄（ゆうげん）、侘び寂び（わびさび）
- **叙事スタイル**：内向的で繊細な感情描写を重視。キャラクターの内面独白と微妙な関係変化に注力。余白を多用し、直叙よりも暗示を優先。テンポは緩やかでも感情密度は高く保つ。
- **文化適応**：キャラクター名・場面設定・社会関係・敬語体系は日本文化に準拠すること。中国語表現の直訳を避ける。`;
  }
  if (market === "west") {
    return `## 🌏 Target Market: Western (US/EU) — Overseas AI Short Drama Production Spec

- **Writing Language: English** — All output must be written in English.

### Topic Selection (IP-driven, blockbuster-oriented)
Preferred genres for the Western market:
1. **Fantasy/Supernatural** — Zombies, witches, werewolves, vampires, gender-swap, beastkin, merfolk, mythological figures (visual spectacle priority)
2. **Alpha-male archetypes** — Mafia boss, professor, CEO, athlete, firefighter (masculine hormone appeal)
3. **Classic adaptations** — Grimm fairy tales, mythology, Western film/TV IP reboots
4. **Period settings** — Western royal court, hit long-drama adaptations
5. **Sci-fi / Post-apocalyptic** — Sci-fi, dystopian, interstellar (strong visual impact)

### Micro-Innovation Design
- Build on a proven core hook, then apply **character-concept inversion** or **setting transplant**.
- Transplant plot beats from hit series into the current drama with local adaptation.

### Story Outline & Episode Structure Rules
- Novel adaptations → target **60 episodes**; original concepts → target **50 episodes** (unless user specifies otherwise).
- The outline MUST distribute content across the classic **4-act structure** (起承转合) with proper pacing — alternate tension and relief, never rush the entire arc flat.
- Each episode outline must satisfy the macro rhythm while distributing plot beats evenly.

### Localization Iron Rules (MANDATORY)
- ⛔ **NO non-American place names** — replace with fictional city names.
- ⛔ **NO non-American character profiles** — names, backgrounds, appearances, and body types must feel authentically Western/American.
- ⛔ **NO non-American cultural elements** — no Eastern fortune-telling, Eastern traditions, Eastern philosophical framing.
- ⛔ **NO real person names, real place names, real brand names, or real product names** — use fictional or lightly altered versions.
- All character bios MUST include **bilingual names** (Chinese + English).

### Character Requirements
- **Character bio**: background story, full name, age, role positioning (lead / supporting / antagonist), personality, backstory.
- **Character portrait** (if visual capability exists): physical appearance, attire, distinctive features.

### Per-Episode Checklist (Quality Gate)
| Check Item | Requirement | Diagnostic | Script Annotation |
|---|---|---|---|
| **3-Second Hook** | Every episode must have a visual or audio explosive moment (can be anywhere in the episode) | Does the audience stop scrolling immediately? | 🔵 Mark BLUE |
| **Completion Bait** | Ending MUST have a strong cliffhanger / suspense | Will the user enter the next episode? | 🔴 Mark RED |
| **Interaction Rate** | Dialogue / visuals must contain debate-triggering moments (controversial dialogue, actions) | Can it trigger comments, shares, likes? | 🟢 Mark GREEN |
| **Scene Actions** | Each episode ≥ 2 scenes | Are scene-action descriptions rich enough? | — |
| **Dialogue Limits** | Total dialogue per episode ≤ 40s reading time; single line ≤ 12s | One shot = dialogue + action within 10-15s? | — |
| **Conflict** | Every episode MUST have at least one climax / reversal | Is the plot tension sustained? | — |
| **Emotional Expression** | Dialogue must be direct, simple; NO euphemisms or subtext | Is the dialogue punchy? | — |
| **Word Count** | Each episode ≥ 800 words, covering ≥ 2 scenes | — | — |
| **Episode Duration** | Target 60 seconds per episode | If final cut deviates >60s significantly, add/trim content | — |

### Title & Naming
- Each drama must provide **at least 2 English title candidates** upon outline submission.
- Drama titles should be concise and memorable.

### Style & Narrative
- Hollywood high-concept format. Think YA blockbusters — punchy hooks, visceral stakes, propulsive pacing.
- External conflict drives internal change. Favor direct plot propulsion, satisfying twists, and "page-turner" cliffhangers.
- Lean into spectacle and wish-fulfillment.`;
  }
  if (market === "kr") {
    return `## 🌏 목표 시장: 한국
- **창작 언어: 한국어** — 모든 출력은 한국어로 작성할 것.
- **미학 경향**: 한국 드라마(K-Drama) 특유의 섬세한 감정선과 운명적 서사. 캐릭터 간의 밀고 당기는 관계 역학, 비밀과 오해에서 비롯된 갈등, 그리고 극적인 반전(plot twist)을 중시.
- **서사 스타일**: 감정의 밀도를 높이되 전개는 긴박하게 유지. 주인공의 성장과 복수·사랑·운명의 교차를 핵심 축으로 삼는다. "밀당"과 "떡밥 회수"를 구조적으로 설계. 시청자의 감정 이입과 공감을 최우선.
- **문화 적응**: 캐릭터명·장소·사회관계·존대어 체계는 한국 문화에 부합해야 한다. 재벌·신분 격차·가족 갈등 등 한국 드라마 특유의 소재를 적극 활용.`;
  }
  if (market === "sea") {
    return `## 🌏 Target Market: Southeast Asia
- **Writing Language: English** — All output must be written in English (universally accessible across SEA markets).
- **Style**: Melodramatic storytelling with high emotional stakes. Blend family honor, social class conflict, and passionate romance. Think Philippine teleserye or Thai lakorn intensity — every emotion is felt deeply and expressed openly.
- **Narrative approach**: Strong moral undercurrents with clear hero/villain dynamics. Favor rags-to-riches arcs, family loyalty vs. personal desire, and justice prevailing after prolonged suffering. Heavy use of dramatic irony and coincidence as plot devices.
- **Cultural fit**: Reflect Southeast Asian social dynamics — extended family hierarchy, economic disparity, spiritual/superstitious elements. Names and settings should feel authentic to a multi-cultural SEA audience.`;
  }
  return `## 🌏 目标市场：国内（中文）
- **创作语言：中文** —— 全部输出内容使用中文撰写。
- 符合国内短剧平台的节奏与审美。`;
}

/** 非中文市场的双语对话规则（附加到 getMarketDirective 输出之后） */
function getBilingualDialogueRule(setup: DramaSetup): string {
  const market = setup.targetMarket || "cn";
  if (market === "cn") return "";
  const langMap: Record<string, string> = {
    jp: "日文",
    west: "英文",
    kr: "韩文",
    sea: "英文",
  };
  const lang = langMap[market] || "英文";
  return `

## ⚠️ 语言输出铁律（最高优先级）
- **所有非对话内容**（创作方案、角色档案、分集目录、单集细纲、场景描写、动作描写、镜头指示、旁白等）**必须使用中文撰写**，无论目标市场是什么。
- **人物对话内容使用${lang}**，每句对话后紧跟小括号中文翻译。
- 格式示例：
  角色名：（动作/语气描写）What are you staring at?
  （看什么看？）
- 旁白也遵循此规则：旁白使用${lang}，后附中文翻译。
- 此规则覆盖上方市场指令中的语言要求。`;
}

function getFullMarketDirective(setup: DramaSetup): string {
  return getMarketDirective(setup) + getBilingualDialogueRule(setup);
}

/** 创作方案 Prompt */
export function buildCreativePlanPrompt(setup: DramaSetup): string {
  const isCreativeMode = setup.setupMode === "creative" && setup.creativeInput;
  const genreStr = setup.genres.length > 0 ? setup.genres.join(" + ") : "由 AI 根据创意内容自动判定";
  return `你是一位专业的微短剧编剧，精通短视频平台的爆款短剧创作方法论。

${getFullMarketDirective(setup)}

## 当前项目配置
${isCreativeMode ? `- 创作模式：创意创作（基于用户提供的创意灵感）` : `- 题材组合：${genreStr}`}
- 目标受众：${setup.audience}
- 故事基调：${setup.tone}
- 结局类型：${setup.ending}
- 总集数：${setup.totalEpisodes}集
${setup.customTopic ? `- 用户补充描述：${setup.customTopic}` : ""}
${isCreativeMode ? `\n## 用户创意内容\n以下是用户提供的创意灵感/故事构思，请以此为核心基础来构建完整的创作方案：\n\n${setup.creativeInput}` : ""}

## 参考知识：节奏曲线
微短剧节奏公式：紧张蓄力 → 爽点释放 → 短暂喘息 → 新一轮蓄力
四段式结构：
- 起势段（前15%集数）：建立世界观和人物关系，制造第一个爽点
- 攀升段（15-45%）：冲突升级，多条线并行推进
- 风暴段（45-80%）：高潮迭起，反转频出
- 决战段（最后20%）：终极对决，结局收束

## 参考知识：付费卡点设计
三大设计原则：情绪峰值原则、悬念未解原则、沉没成本原则
黄金卡点位置：
- 首个卡点：第8-12集（最强悬念）
- 第二卡点：第18-25集（身份揭露/反转）
- 第三卡点：第35-45集（感情线高潮）
- 终极卡点：倒数3-5集（终极对决前）
付费卡点总占比 10-15%

## 参考知识：爽点矩阵
5大爽点类型：身份碾压、逆袭打脸、甜宠撒糖、虐心催泪、悬疑反转
爽点本质：压抑 → 释放。压抑越深，释放越爽。

## 你的任务
请直接生成完整的创作方案，不要询问创作起点或让用户选择方向，包含以下 8 个板块：

1. **剧名备选**（3个），每个附一句话说明
2. **时空背景**：时代、地点、社会环境、阶层关系
3. **一句话故事线** + **核心冲突**
4. **三幕结构拆解**：
   - 第一幕（建置）：集数范围、核心事件、人物关系建立
   - 第二幕（对抗）：集数范围、冲突升级、转折点
   - 第三幕（高潮/结局）：集数范围、终极对决、结局处理
5. **全剧节奏波形描述**：标注高潮点、低谷点位置
6. **付费卡点规划**：具体集数 + 卡点类型 + 悬念设计
7. **爽感矩阵**：规划全剧各类爽点分布和配比
8. **结局设计**：主线结局 + 感情线结局 + 伏笔回收

用 Markdown 格式输出，清晰分区。`;
}

/** 角色开发 Prompt */
export function buildCharactersPrompt(setup: DramaSetup, creativePlan: string): string {
  const genreStr = setup.genres.join(" + ");
  return `你是一位专业的微短剧编剧。

${getFullMarketDirective(setup)}

## 当前项目
- 题材：${genreStr}
- 受众：${setup.audience}
- 基调：${setup.tone}
- 总集数：${setup.totalEpisodes}集

## 已有创作方案
${creativePlan}

## 参考知识：四层反派体系
反派设计三原则：可恨原则、可信原则、递进原则
- 第一层·小反派（前15%集数）：身份不高的小人物，嚣张但无实力，被打脸后迅速退场
- 第二层·中反派（前2/3集数）：有一定权势的对手，能给主角造成真正威胁
- 第三层·大反派（中后期）：终极Boss，实力和资源远超主角
- 第四层·隐藏反派（后1/3揭露）：身边最信任的人，反转冲击力最大

## 你的任务
生成完整角色体系，包含：

1. **主要角色档案**（每个角色包含）：
   - 姓名、年龄、外貌特征（2-3句）
   - 性格关键词（3-5个）
   - 公开身份 vs 真实身份
   - 核心动机
   - 爽点功能（承担什么爽点）
   - 口头禅或语言特征
   - 人物弧光（从开始到结局的变化轨迹）

2. **角色关系图**（使用 Mermaid graph TD 格式输出，用中文标注关系类型）

请输出**两段**关系图代码：

**简单关系图**（仅含主要角色：男女主、核心反派，节点不超过6个）：
\`\`\`mermaid
graph TD
    A[苏念·女主] -->|暗恋| B[陆景琛·男主]
    B -->|保护| A
    C[赵婉儿·反派] -->|嫉妒| A
\`\`\`

**详细关系图**（含所有能推动剧情的角色，包括 NPC/配角，完整展示人物关系网络）：
\`\`\`mermaid-detailed
graph TD
    A[苏念·女主] -->|暗恋| B[陆景琛·男主]
    B -->|保护| A
    C[赵婉儿·反派] -->|嫉妒| A
    D[陆母] -->|反对| A
    E[管家·NPC] -->|传递消息| B
\`\`\`

3. **感情线弧线**：男女主关系发展的关键节点（标注集数）

4. **四层反派体系**：
   - 每层反派的身份、动机、行为模式、击败/揭露过程

5. **关键互动场景预设**：
   - 第一次冲突场景
   - 身份揭露场景
   - 感情转折场景
   - 终极对决场景

用 Markdown 格式输出。`;
}

/** 分集目录 Prompt */
export function buildDirectoryPrompt(setup: DramaSetup, creativePlan: string, characters: string): string {
  return `你是一位专业的微短剧编剧。

${getFullMarketDirective(setup)}

## 已有创作方案
${creativePlan}

## 已有角色档案
${characters}

## 参考知识：钩子设计
5种钩子类型：
- 悬念钩（20-30%）：抛出关键疑问，答案留到下集
- 反转钩（5-15%）：在观众以为知道答案时，突然推翻
- 情绪钩（30-40%）：把情绪推到顶点然后截断
- 信息钩（10-20%）：释放一个关键信息，但只给一半
- 危机钩（10-20%）：主角陷入即时危险

## 参考知识：节奏曲线
四段式结构（${setup.totalEpisodes}集）：
- 起势段（约前${Math.round(setup.totalEpisodes * 0.15)}集）
- 攀升段（约${Math.round(setup.totalEpisodes * 0.15) + 1}-${Math.round(setup.totalEpisodes * 0.45)}集）
- 风暴段（约${Math.round(setup.totalEpisodes * 0.45) + 1}-${Math.round(setup.totalEpisodes * 0.8)}集）
- 决战段（约${Math.round(setup.totalEpisodes * 0.8) + 1}-${setup.totalEpisodes}集）

## 你的任务
生成完整的 ${setup.totalEpisodes} 集分集目录。

每集一行，格式：
第{N}集：{集标题} —— {核心冲突或爽点一句话描述} [钩子类型] [情绪:X] {标记}

标记说明：
- 🔥 关键剧情集（重大转折、揭秘），占比 25-35%
- ⚡ 高潮卡点集（情绪最高峰、终极对决、命运转折等全剧最震撼的高潮时刻），占比 10-15%
- 💰 付费卡点集（付费墙位置，悬念最强、观众最不愿意离开的时刻），占比 10-15%
- 一集可以同时标多个标记（如 🔥⚡💰）
- 无标记 = 常规推进集
- [情绪:X]：标注该集的情绪强度（1-5），1=平稳铺垫，2=小波澜，3=中等紧张，4=高潮激烈，5=极致爆发

要求：
- 【强制】必须输出恰好 ${setup.totalEpisodes} 行集目录，不能多也不能少，每集一行，从第1集到第${setup.totalEpisodes}集，不得跳号、合并或省略
- 前 10 集必须包含至少 3 个 🔥
- 💰 付费卡点建议分布在以下位置：
  · 第8-12集（首个付费卡点，最强悬念）
  · 第18-25集（身份揭露/反转）
  · 第35-45集（感情线高潮）
  · 倒数3-5集（终极对决前）
- ⚡ 高潮卡点集中在全剧 10-15%，锁定在叙事高峰期
- 目录必须体现三幕结构的节奏变化
- 每集标注钩子类型（悬念钩/反转钩/情绪钩/信息钩/危机钩）
- 每集标注情绪强度[情绪:1-5]
- 按段落分组显示（起势段/攀升段/风暴段/决战段）

**严格格式要求**：每一行必须严格按照以下格式输出，不要偏离：
第{N}集：{集标题} —— {描述} [{钩子类型}钩] [情绪:{1-5}] {标记}
例如：第1集：命运序章 —— 女主初入公司遭受冷遇 [悬念钩] [情绪:2] 🔥
不要使用其他分隔符（如"-"或"："代替"——"），不要省略集数编号"第N集："的格式。

  末尾附统计信息：🔥数量、⚡数量、💰数量、各钩子类型占比。`;
}

/** 单集细纲生成 Prompt（批量） */
export function buildOutlinePrompt(
  setup: DramaSetup,
  creativePlan: string,
  characters: string,
  episodes: { number: number; title: string; summary: string; hookType: string }[],
  allDirectoryRaw: string,
  customInstruction?: string,
  continuityContext?: string,
): string {
  const epList = episodes
    .map((ep) => `第${ep.number}集：${ep.title} —— ${ep.summary} [${ep.hookType}]`)
    .join("\n");

  const rangeLabel = episodes.length === 1
    ? `第${episodes[0].number}集`
    : `第${episodes[0].number}-${episodes[episodes.length - 1].number}集`;
  const batchContinuityRule =
    episodes.length > 1
      ? `- 【批内连续】本批是连续剧情链。第 N 集的“结尾状态”必须成为第 N+1 集的“开场承接”，不能跳过关键场景转移、人物动机变化或信息发现过程。`
      : `- 【单集补写】必须优先承接“邻近集衔接参考”和完整分集目录，不能推翻前后集已经发生的事实。`;

  return `你是一位专业的微短剧编剧。

${getFullMarketDirective(setup)}

## 已有创作方案
${creativePlan}

## 已有角色档案
${characters}

## 完整分集目录（供参考节奏上下文）
${allDirectoryRaw}

${continuityContext?.trim() ? `## 邻近集衔接参考
以下内容用于保证本次细纲与前后集连贯，尤其是单集补写或重写时需要优先承接：
${continuityContext.trim()}
` : ""}

${customInstruction?.trim() ? `## 本次额外调整要求
${customInstruction.trim()}

请在不破坏整体主线、人物关系和上下集衔接的前提下，优先执行以上调整。` : ""}

## 你的任务
为以下集数生成**单集细纲**（${rangeLabel}，共${episodes.length}集）。

需要生成细纲的集数：
${epList}

## 细纲要求
1. 每集细纲必须短小：正文约 160-220 字；整集含“场景转换 / 情感走向 / 结尾钩子 / 衔接”四类标注在内，不得超过 360 字。
3. 生成时必须在底层先完成连续性检查：本集开头承接上一集结尾状态/悬念，关键场景转移有因果，真相或证据有来源，人物情绪变化有触发点，本集结尾能自然引出下一集。不要把这些底层检查项名称写进细纲正文。
4. 细纲正文必须自然包含本集核心事件与冲突；如出现真相、证据、身份反转，必须在自然叙述中写清由谁发现、从什么物件/证词/行动中发现。
5. 正文后只显示以下四类标注：
   - 场景转换：列出 3-5 个关键场景，按 1. 2. 3. 编号
   - 情感走向：写清主要人物情绪或关系变化
   - 结尾钩子：写清本集最后的悬念、反转或强刺激画面
   - 衔接：写清本集如何承接上一集、如何引出下一集
6. 注意整体节奏的连贯性，前后集之间要有因果关系
7. 连续性硬规则（只在生成时遵守，不要输出这些规则或检查项名称）：
${batchContinuityRule}
   - 不允许无解释地更换地点、身份、阵营、情绪立场或已知事实。
   - 不允许让角色突然知道一个真相；必须写清发现过程和证据来源。
   - 如果本集从羞辱、逃亡、审判、受伤、囚禁、昏迷等强状态后承接，下一集开头必须先处理该状态，再推进新事件。
## 输出格式
严格按以下格式输出，每集之间用空行分隔：

【第{N}集细纲】{集标题}
{细纲正文，约160-220字，自然段落书写，不要输出“开场承接”“新增事实与信息来源”“结尾状态”等底层检查项标题；本集全部内容含下方标注不得超过360字}
场景转换：1. {场景一}；2. {场景二}；3. {场景三}
情感走向：{人物情绪/关系变化}
结尾钩子：{本集结尾强悬念或反转}
衔接：{承接上一集的点 + 引出下一集的点}

---

【第{N+1}集细纲】{集标题}
{细纲内容}
场景转换：1. {...}；2. {...}；3. {...}
情感走向：{...}
结尾钩子：{...}
衔接：{...}

不要输出其他多余内容。`;
}

/** 获取市场对应的剧本格式模板 */
function getScriptFormatTemplate(setup: DramaSetup, episodeNumber: number, hookType: string): string {
  const market = setup.targetMarket || "cn";

  if (market === "jp") {
    return `## 脚本フォーマット（日本市場向け）

\`\`\`
# 第${episodeNumber}話

# ${episodeNumber}-1 {時間帯} {屋内/屋外} {場所}

出演人物：{人物リスト}

△{情景描写 — 季節感・空気感を重視}

△{人物の所作・微細な表情変化}

**{キャラクター名}**（{口調/動作指示}）：{台詞}

△{象徴的ディテール — 物哀の瞬間}

♪ 音楽：{和楽器・アンビエント系の雰囲気}

# ${episodeNumber}-2 {時間帯} {屋内/屋外} {場所}

出演人物：{人物リスト}

……以下同形式……

---

> 🎣 引き：{余韻と暗示}
> 📺 次回予告：{次話の核心}
\`\`\`

## 品質基準
- 各話 3-5 シーン
- 各話 800文字以上
- シーン番号は ${episodeNumber}-1, ${episodeNumber}-2 形式で通し番号
- △で全ての描写・動作・ト書きを開始
- 台詞は独立行に記載
- 物哀・余韻を意識した描写を各シーンに1箇所以上
- 結末は${hookType || "余韻"}で締める`;
  }

  if (market === "west") {
    return `## Script Format (Western Market — Overseas AI Short Drama Spec)

\`\`\`
# Episode ${episodeNumber}

# ${episodeNumber}-1 {TIME (DAY/NIGHT/DAWN/DUSK)} {INT./EXT.} {LOCATION}

Characters: {character list}

△{3-SECOND HOOK — visual/audio explosive moment to stop scrolling}
△{Character action — body language, tension}

{CHARACTER NAME}: ({tone/action direction}) {Dialogue}

△{Key detail — plot-critical visual}

# ${episodeNumber}-2 {TIME} {INT./EXT.} {LOCATION}

Characters: {character list}

△{Scene description…}

……continue same format……
\`\`\`

## Quality Standards (Per-Episode Checklist)
- **Minimum 2 scenes** per episode, recommended 3-5
- **Minimum 800 words** per episode
- Scene numbers use \`${episodeNumber}-1, ${episodeNumber}-2\` format
- △ prefix for ALL descriptive/action/direction text (no space after △)
- Dialogue on separate lines: \`CHARACTER: (direction) dialogue\` — no quotes, no bold
- 🔵 **3-Second Hook**: Mark the hook moment in BLUE annotation
- 🔴 **Completion Bait**: End with strong cliffhanger, mark in RED annotation
- 🟢 **Interaction Trigger**: Include debate-worthy line, mark in GREEN annotation
- End with a strong ${hookType || "cliffhanger"} hook
- ⛔ NO real names, real places, real brands — all must be fictional`;
  }

  if (market === "kr") {
    return `## 대본 형식 (한국 시장)

\`\`\`
# 제${episodeNumber}화

# ${episodeNumber}-1 {시간} {실내/실외} {장소}

등장인물: {인물 목록}

△{장면 묘사 — 분위기와 공간감}
△{인물의 표정·동작 — 감정 변화에 집중}

{캐릭터명}: ({말투/동작 지시}) {대사}

△{핵심 디테일 — 감정 폭발의 순간}

# ${episodeNumber}-2 {시간} {실내/실외} {장소}

등장인물: {인물 목록}

……이하 동일 형식……
\`\`\`

## 품질 기준
- 각 화 3-5개 씬, 최소 800자 이상
- 씬 번호는 \`${episodeNumber}-1, ${episodeNumber}-2\` 형식
- △로 모든 묘사/동작/지시문 시작 (△ 뒤 공백 없음)
- 대사는 별도 행: \`캐릭터명: (지시) 대사\` — 따옴표·볼드 없음
- 감정 밀당과 반전을 각 씬에 배치
- 결말은 ${hookType || "클리프행어"}로 마무리`;
  }

  if (market === "sea") {
    return `## Script Format (Southeast Asian Market)

\`\`\`
# Episode ${episodeNumber}

# ${episodeNumber}-1 {TIME} {INT./EXT.} {LOCATION}

Characters: {character list}

△{Scene description — lush, atmospheric, emotionally charged}
△{Character interaction — body language conveying unspoken tension}

{CHARACTER NAME}: ({tone/action direction}) {Dialogue}

△{Emotional reaction — tears, rage, revelation}

# ${episodeNumber}-2 {TIME} {INT./EXT.} {LOCATION}

Characters: {character list}

……continue same format……
\`\`\`

## Quality Standards
- 3-5 scenes per episode, minimum 800 words
- Scene numbers use \`${episodeNumber}-1, ${episodeNumber}-2\` format
- △ prefix for ALL descriptive/action/direction text (no space after △)
- Dialogue on separate lines: \`CHARACTER: (direction) dialogue\` — no quotes, no bold
- Maximize emotional intensity — confrontation, confession, betrayal moments
- End with a powerful ${hookType || "dramatic revelation"} hook`;
  }

  // 国内默认
  return `## 剧本格式要求（国内模式）

**严格遵循以下格式规范，不得偏离：**

### 场次编号规则
- 场次编号采用"集数-场次序号"格式，如第${episodeNumber}集的场次依次为 ${episodeNumber}-1、${episodeNumber}-2、${episodeNumber}-3……
- 每个场次标题格式：\`# ${episodeNumber}-{N} {时间} {内/外} {地点}\`，其中 {N} 为该集内的场次序号

### 格式模板

\`\`\`
# 第${episodeNumber}集

# ${episodeNumber}-1 {时间（日/夜/清晨/黄昏等）} {内/外} {地点}

出场人物：{人物A}，{人物B}，{人物C}

△{场景描写与人物动作描写。所有非台词的叙述性内容（包括场景描写、动作描写、神态描写、镜头指示等）都必须以△开头。}

{角色名}：（{语气/动作指示}）{台词内容}

△{后续动作或场景描写，继续以△开头。}

{角色名}：（{语气/动作指示}）{台词内容}

△{更多动作/描写。}

# ${episodeNumber}-2 {时间} {内/外} {地点}

出场人物：{人物列表}

△{场景描写……}

……以此类推……
\`\`\`

### 关键格式规则（必须严格执行）

1. **△符号**：仅用于描写性文字（场景、动作、神态、镜头方向等），△紧跟文字内容，中间无空格。**对话和旁白前绝对不加△**
2. **人物对话**：台词必须单独成行，格式为 \`角色名：（语气/动作指示）台词内容\`，不加引号，不加粗。旁白格式为 \`旁白：内容\`，旁白属于台词类别，不加△
3. **场次编号**：使用 \`# ${episodeNumber}-{N}\` 格式，N从1开始递增
4. **出场人物**：每个场次开头必须列出 \`出场人物：\` 并用逗号分隔
5. **集标题**：首行为 \`# 第${episodeNumber}集\`，不附加集标题

## 质量要求
- 每集 3-5 个场次
- 每集至少 800 字
- 台词带语气或动作指示（用圆括号包裹）
- 结尾必须有悬念钩子（${hookType || "悬念钩"}）`;
}

/** 根据单集时长计算△、台词、场景数量及字数约束 */
export function getDurationConstraints(durationSeconds: number): {
  triangleMin: number; triangleMax: number; maxDialogues: number;
  sceneMin: number; sceneMax: number;
  cjkWordsMin: number; cjkWordsMax: number;
  latinWordsMin: number; latinWordsMax: number;
  label: string;
} {
  const segments = Math.ceil(durationSeconds / 30);

  // 场景数量：60s→2~3, 90s→3~5, 120s→4~6
  let sceneMin: number, sceneMax: number;
  if (durationSeconds <= 60) { sceneMin = 2; sceneMax = 3; }
  else if (durationSeconds <= 90) { sceneMin = 3; sceneMax = 5; }
  else if (durationSeconds <= 120) { sceneMin = 4; sceneMax = 6; }
  else { sceneMin = Math.round(durationSeconds / 30); sceneMax = Math.round(durationSeconds / 20); }

  return {
    triangleMin: segments * 9,
    triangleMax: segments * 11,
    maxDialogues: segments * 4,
    sceneMin,
    sceneMax,
    cjkWordsMin: segments * 300,
    cjkWordsMax: segments * 400,
    latinWordsMin: segments * 800,
    latinWordsMax: segments * 1200,
    label: `${durationSeconds}秒`,
  };
}

/** 分集撰写 Prompt */
export function buildEpisodePrompt(
  setup: DramaSetup,
  characters: string,
  directory: EpisodeEntry[],
  episodeNumber: number,
  previousEpisodes: string,
  nextEpisodes?: string,
  customInstruction?: string,
  durationSeconds?: number,
): string {
  const ep = directory.find((e) => e.number === episodeNumber);
  const prevEp = directory.find((e) => e.number === episodeNumber - 1);
  const nextEp = directory.find((e) => e.number === episodeNumber + 1);
  const isFirstEp = episodeNumber === 1;

  return `你是一位专业的微短剧编剧。

${getFullMarketDirective(setup)}

## 项目配置
- 题材：${setup.genres.join(" + ")}
- 基调：${setup.tone}
- 总集数：${setup.totalEpisodes}

## 角色档案（摘要）
${characters.slice(0, 3000)}

## 当前集信息
- 第 ${episodeNumber} 集：${ep?.title || ""}
- 梗概：${ep?.summary || ""}
- 钩子类型：${ep?.hookType || ""}
- ${ep?.isKey ? "🔥 关键剧情集" : ""}${ep?.isClimax ? " ⚡ 高潮卡点集" : ""}
${prevEp ? `- 上一集：第${prevEp.number}集 ${prevEp.title} —— ${prevEp.summary}` : ""}
${nextEp ? `- 下一集：第${nextEp.number}集 ${nextEp.title} —— ${nextEp.summary}` : ""}

${previousEpisodes ? `## 前集回顾\n${previousEpisodes.slice(-2000)}` : ""}
${nextEpisodes ? `\n## 后续集回顾\n${nextEpisodes.slice(-2000)}` : ""}

${isFirstEp ? `## 重要：开篇黄金法则
- 第1秒：画面冲击或悬念抛出
- 第3秒：核心冲突或身份反差建立
- 第5秒：观众必须产生"接下来会怎样"的好奇心
- 前30秒必须完成：建立核心冲突、展示主角处境、抛出第一个钩子
- 禁止：大段旁白、慢节奏空镜、流水账、平铺直叙` : ""}

${getScriptFormatTemplate(setup, episodeNumber, ep?.hookType || "")}

${durationSeconds ? (() => {
  const c = getDurationConstraints(durationSeconds);
  const isCJK = ['cn', 'jp', 'kr'].includes(setup.targetMarket);
  return `## 单集时长与内容量约束（${c.label}）
- 本集目标时长：${c.label}
- 场景数量：${c.sceneMin}~${c.sceneMax} 个场景（每个场景以 # 集数-场次 格式标注）
- △（描写/动作/镜头指示）数量：${c.triangleMin}~${c.triangleMax} 个（△仅用于非台词的叙述性内容，不包括任何对话和旁白）
- 台词总数（含旁白）：不超过 ${c.maxDialogues} 句
- 全集总字数：${isCJK ? `${c.cjkWordsMin}~${c.cjkWordsMax} 个中文字` : `${c.latinWordsMin}~${c.latinWordsMax} 个英文单词`}（每30秒约${isCJK ? '300~400中文字' : '800~1200英文单词'}）
- 每30秒对应 9~11 个△描写和最多 4 句台词（旁白算作台词，不算△）
- 严格区分：△ = 场景描写、动作描写、神态描写、镜头指示；台词 = 角色对话 + 旁白（旁白格式：旁白：内容）
- 对话和旁白前绝对不能加△符号
- 严格控制内容密度，不要超出或不足上述范围`;
})() : ""}

- 确保角色行为与档案一致
- 确保剧情推进与分集目录一致

${customInstruction ? `\n## 用户重写指令\n${customInstruction}\n请在撰写时重点体现以上指令要求。\n` : ""}
请直接输出完整的第 ${episodeNumber} 集剧本。`;
}

/** 单场次重写 Prompt */
export function buildSceneRegenPrompt(
  setup: DramaSetup,
  characters: string,
  episodeNumber: number,
  episodeContent: string,
  sceneIndex: number,
  sceneContent: string,
  customInstruction?: string,
): string {
  const instructionBlock = customInstruction
    ? `\n\n## 用户重写指令\n${customInstruction}\n请在重写时重点体现以上指令要求，但不得违反下方"连贯性铁律"。`
    : "";

  // --- Extract adjacent scenes as anchors ---
  const sceneRegex = /^(#\s*\d+-\d+\s+.*)$|^(##\s*场次.*)$/gm;
  const matches = [...episodeContent.matchAll(sceneRegex)];
  const extractScene = (idx: number): string | null => {
    if (idx < 0 || idx >= matches.length) return null;
    const start = matches[idx].index!;
    const end = idx + 1 < matches.length ? matches[idx + 1].index! : episodeContent.length;
    return episodeContent.slice(start, end).trim();
  };

  const prevScene = extractScene(sceneIndex - 1);
  const nextScene = extractScene(sceneIndex + 1);

  const anchorBlock = [
    prevScene
      ? `### 前一场次（场次${sceneIndex}）— 剧情锚点\n${prevScene}\n\n**衔接约束**：重写后的场次开头必须自然承接上述场次的结尾状态（角色位置、情绪、已知信息）。`
      : `（本场次为该集首场，需承接集标题/前情提要中的状态。）`,
    nextScene
      ? `### 后一场次（场次${sceneIndex + 2}）— 剧情锚点\n${nextScene}\n\n**衔接约束**：重写后的场次结尾必须保证后续场次的开头仍然成立（角色去向、情绪转折、信息揭示均不可断裂）。`
      : `（本场次为该集末场，结尾需保留原有的悬念/钩子设计。）`,
  ].join("\n\n");

  return `你是一位专业的微短剧编剧，擅长在不改变核心剧情的前提下提升场次的表现力。

${getFullMarketDirective(setup)}

## 项目配置
- 题材：${setup.genres.join(" + ")}
- 基调：${setup.tone}

## 角色档案（摘要）
${characters.slice(0, 2000)}

## 当前集完整内容
${episodeContent}

---

## 前后场次剧情锚点
${anchorBlock}
${instructionBlock}

---

## 连贯性铁律（最高优先级）

1. **核心剧情不可变更**：本场次的关键事件（信息揭示、角色决策、冲突升级/降级）必须与原场次完全一致。禁止新增、删除或替换任何影响后续剧情的事件。
2. **角色情感弧线约束**：
   - 场次开头的角色情绪状态必须匹配前一场次（或集开头）的结束状态；
   - 场次结尾的角色情绪状态必须能自然过渡到后一场次（或集结尾悬念）的起始状态；
   - 角色在本场次中的情绪变化轨迹（如：隐忍→爆发、怀疑→确认）必须保持原有方向，仅允许在表达强度上调整。
3. **结尾状态衔接检查**：重写完成后，自检以下三项，若任一项不满足则必须修正：
   - ✅ 角色的物理位置与后续场次一致
   - ✅ 已揭示/未揭示的信息与后续场次一致
   - ✅ 角色间关系状态（敌对/信任/误解等）与后续场次一致
4. **禁止跨场次副作用**：不得引入新角色、新道具、新地点，除非原场次中已存在。

---

## 你的任务
请重新撰写上述第 ${episodeNumber} 集中的 **场次${sceneIndex + 1}** 部分。

原场次内容：
${sceneContent}

**允许优化的维度**：
- 台词的表现力与潜台词层次
- 镜头语言（△ 景别切换、运镜节奏）
- 场景氛围描写与感官细节
- 节奏感（停顿、沉默、反应镜头的运用）
- ♪ 音效/音乐提示的精准度

**输出格式要求**：
- 使用与原文相同的格式（场景描述、△ 镜头、角色台词、♪ 音乐等）
- 仅输出该场次的内容，不要输出其他场次
- 不要输出自检过程，仅输出最终场次内容

请直接输出重写后的场次内容。`;
}

/** 导出整合 Prompt */
export function buildExportPrompt(
  setup: DramaSetup,
  dramaTitle: string,
  creativePlan: string,
  characters: string,
  episodes: { number: number; title: string; content: string }[],
): string {
  return `你是一位专业编辑。请将以下创作内容整合为一份完整、排版规范的剧本文档。

${getFullMarketDirective(setup)}

## 元信息
- 剧名：${dramaTitle}
- 题材：${setup.genres.join(" + ")}
- 总集数：${setup.totalEpisodes}集
- 已完成：${episodes.length}集
- 目标受众：${setup.audience}
- 故事基调：${setup.tone}

## 创作方案摘要
${creativePlan.slice(0, 1500)}

## 角色表摘要
${characters.slice(0, 1500)}

## 分集剧本
${episodes.map((ep) => `### 第${ep.number}集：${ep.title}\n${ep.content}`).join("\n\n---\n\n")}

请输出整合后的完整剧本文档，格式规范，包含以下结构：

1. **封面信息**（剧名、题材、集数、受众、基调）
2. **角色表**（从角色档案中提取，列表形式：角色名 | 身份 | 性格关键词 | 功能定位）
3. **场景清单**（从各集剧本中提取所有出现过的场景/地点，去重后列出）
4. **配乐提示表**（从各集剧本中提取所有 ♪ 音乐提示，标注对应集数和场次）
5. **分集剧本**（完整保留各集内容，统一格式）`;
}

/** 合规审核 Prompt - 支持文字审核和情节审核两种模式 */
export function buildCompliancePrompt(
  setup: DramaSetup,
  creativePlan: string,
  characters: string,
  episodes: { number: number; title: string; content: string }[],
  reviewMode: "text" | "script" = "text",
): string {
  const market = setup.targetMarket || "cn";
  const episodesSample = episodes
    .sort((a, b) => a.number - b.number)
    .map((ep) => `### 第${ep.number}集：${ep.title}\n${ep.content.slice(0, 1500)}`)
    .join("\n\n---\n\n");

  if (reviewMode === "script") {
    // 情节审核模式：文字+画面双重审查
    return `你是一位资深的短剧内容合规审核专家，执行**最彻底的合规审查**。

${getFullMarketDirective(setup)}

## 项目信息
- 题材：${setup.genres.join(" + ")}
- 受众：${setup.audience}
- 基调：${setup.tone}
- 总集数：${setup.totalEpisodes}
- 已完成：${episodes.length}集

## 创作方案摘要
${creativePlan.slice(0, 1000)}

## 角色档案摘要
${characters.slice(0, 1000)}

## 剧本内容
${episodesSample}

---

## 审核要求

你需要进行**双重审查**：检查文字层面和画面表现层面的合规风险。

### 第一重：文字违规检查

检查字面上的违规内容：

1. **激烈冲突文字**
   - 描写身体损伤的文字
   - 描写冲突过程的文字
   - 描写激烈对抗的文字

2. **版权问题**
   - 直接引用受版权保护的歌词、台词、小说
   - 明显抄袭知名IP的角色、情节

3. **敏感亲密文字**
   - 过度暴露的描写
   - 不当行为描写

### 第二重：画面违规检查

从画面呈现角度审查整个情节段落：

1. **激烈冲突情节风险**
   - 肢体冲突情节：打斗、摔打等
   - 伤害呈现情节：受伤场景
   - 强对抗情节：威胁等

2. **亲密情节风险**
   - 亲密接触情节：吻戏、拥抱等
   - 身体呈现情节：更衣、沐浴等
   - 暧昧氛围情节：调情等

3. **其他情节风险**
   - 未成年人参与的敏感场景
   - 不良行为展示
   - 其他违规内容

## 输出格式

使用以下标记标注风险：

- ⛔ 红线问题（必须修改）
- ⚠️ 高风险内容（建议修改）
- ℹ️ 优化建议（可选修改）

**标记规则：**

**文字违规**：标记完整句子
- 示例：⛔【他的胸口被刺穿，染红了整件衬衫。】

**画面违规**：标记整个风险段落
- 示例：⛔【他猛地将她推倒，双手掐住她的脖子...（整段完整文字）】

## 输出结构

1. **合规总评**
2. **文字违规检测**
3. **画面违规检测**
4. **风险汇总**
5. **修改建议**

用 Markdown 格式输出。`;
  }

  // 文字审核模式
  return `你是一位资深的短剧内容合规审核专家，精通各类内容监管法规与平台规范。

${getFullMarketDirective(setup)}

## 项目信息
- 题材：${setup.genres.join(" + ")}
- 受众：${setup.audience}
- 基调：${setup.tone}
- 总集数：${setup.totalEpisodes}
- 已完成：${episodes.length}集

## 创作方案摘要
${creativePlan.slice(0, 1000)}

## 角色档案摘要
${characters.slice(0, 1000)}

## 剧本内容
${episodesSample}

---

## 审核要求

请对以下三个维度进行合规审查：

### 一、激烈冲突内容
检查字面上的激烈冲突描写：
- 描写身体损伤的文字
- 描写冲突过程的文字
- 描写激烈对抗行为的文字
- 轻度肢体冲突可标记为优化建议

### 二、版权问题
检查是否存在：
- 直接引用受版权保护的作品内容
- 明显模仿知名IP的角色、情节设定
- 未授权使用品牌名称

### 三、敏感亲密内容
检查字面上的敏感亲密描写：
- 过度暴露的描写
- 不当行为描写
- 一般亲吻拥抱可标记为优化建议

## 输出格式

使用以下标记标注问题严重程度：
- ⛔ 红线问题（必须修改）
- ⚠️ 高风险内容（建议修改）
- ℹ️ 优化建议（可选修改）

输出结构：
1. **合规总评**：一段话总结合规状态
2. **激烈冲突检测**：逐项检查结果
3. **版权问题排查**：逐项检查结果
4. **敏感内容检测**：逐项检查结果
5. **问题清单汇总**：按严重程度排序
6. **修改建议**：针对每个问题的具体修改方案

**标记规则：**

标记**整句话或整个分镜片段**：
- 红线问题：⛔【包含风险内容的完整句子】
- 高风险内容：⚠️【包含风险内容的完整句子】
- 优化建议：ℹ️【包含风险内容的完整句子】

用 Markdown 格式输出，清晰分区。`;
}

/** 质量自检 Prompt */
export function buildReviewPrompt(
  setup: DramaSetup,
  characters: string,
  directory: EpisodeEntry[],
  episodeNumber: number,
  episodeContent: string,
  prevEpisodeContent?: string,
  nextEpisodeContent?: string,
): string {
  const genreStr = setup.genres.join(" + ");
  const epEntry = directory.find((d) => d.number === episodeNumber);

  return `你是一位资深短剧质检编辑，精通微短剧的创作标准和行业规范。

${getFullMarketDirective(setup)}

## 任务
对以下第 ${episodeNumber} 集剧本进行五维度质量评分和审查。

## 项目信息
- 题材：${genreStr}
- 受众：${setup.audience}
- 基调：${setup.tone}
- 结局：${setup.ending}
- 总集数：${setup.totalEpisodes}
${epEntry ? `- 本集标题：${epEntry.title}\n- 本集概要：${epEntry.summary}\n- 钩子类型：${epEntry.hookType}${epEntry.isKey ? "\n- 🔥 关键集" : ""}${epEntry.isClimax ? "\n- ⚡ 高潮卡点" : ""}` : ""}

## 角色档案（摘要）
${characters.slice(0, 2000)}

${prevEpisodeContent ? `## 上一集内容（末尾片段）\n${prevEpisodeContent.slice(-600)}\n` : ""}
${nextEpisodeContent ? `## 下一集内容（开头片段）\n${nextEpisodeContent.slice(0, 600)}\n` : ""}

## 待审查剧本
${episodeContent}

---

## 评分要求

请严格按照以下五个维度评分（每项 1-10 分），并输出 **严格的 JSON 格式**：

\`\`\`json
{
  "scores": {
    "rhythm": { "score": 8, "comment": "评价说明" },
    "satisfaction": { "score": 7, "comment": "评价说明" },
    "dialogue": { "score": 9, "comment": "评价说明" },
    "format": { "score": 9, "comment": "评价说明" },
    "continuity": { "score": 9, "comment": "评价说明" }
  },
  "total": 42,
  "grade": "优良",
  "highlights": ["亮点1", "亮点2", "亮点3"],
  "issues": [
    { "level": "⛔", "description": "阻断性问题描述" },
    { "level": "⚠️", "description": "建议修改描述" },
    { "level": "ℹ️", "description": "微调建议描述" }
  ],
  "suggestions": ["修订建议1", "修订建议2"]
}
\`\`\`

### 维度说明
| 维度 | 评价标准 |
|------|----------|
| rhythm（节奏） | 场景切换节奏、信息密度、前30秒入戏、末尾钩子 |
| satisfaction（爽点） | 爽感要素密度、情绪高潮设计、观众满足感 |
| dialogue（台词） | 人物语言个性化、金句设计、画外音使用 |
| format（格式） | 镜头语言规范（△全景/中景/特写）、配乐提示♪、场景头标注、角色标注 |
| continuity（连贯性） | 与角色档案一致、与前后集衔接、伏笔回收 |

### 评级标准
| 总分 | 评级 |
|------|------|
| 45-50 | 卓越 |
| 38-44 | 优良 |
| 30-37 | 合格 |
| 25-29 | 需改进 |
| <25 | 需重写 |

**只输出 JSON，不要输出其他任何内容。**`;
}

/** 结构转换 Prompt（同款创作模式） */
export function buildStructureTransformPrompt(
  setup: DramaSetup,
  referenceScript: string,
  frameworkStyle: string,
  transformMarket?: string,
): string {
  const styles = frameworkStyle ? frameworkStyle.split(/[、,，]/).map((s) => s.trim()).filter(Boolean) : [];
  const keepOriginal = styles.length === 0;
  const styleLabel = keepOriginal ? "原剧类型" : styles.join("、");
  // 允许在转换步骤临时切换目标市场
  const effectiveMarket = transformMarket || setup.targetMarket || "cn";
  const marketSetup = { ...setup, targetMarket: effectiveMarket };

  if (keepOriginal) {
    return `你是一位专业的微短剧改编编剧，擅长在保留原剧类型的基础上进行适度洗稿。

${getFullMarketDirective(marketSetup)}

## 你的任务
对以下参考剧本进行**保持原剧类型的改编**：不改变故事类型/世界观/时代背景，仅对人物、场景、道具进行改名，整体洗稿程度约60%。

## 转换原则
1. **保持原剧类型**：世界观、时代背景、社会体系、权力结构、文化元素与原剧本一致，不做风格置换
2. **改名置换**：
   - 人物姓名 → 更换为同风格的新名字
   - 场景名称 → 更换为同类型的新场景
   - 道具/物品 → 更换为同功能的新道具
3. **洗稿约60%**：保留核心情节骨架和关键转折，对表述、细节、对话进行约60%的改写，避免照抄原文

## 参考剧本结构
${referenceScript}

## 输出要求
请生成完整的创作方案，包含以下板块：

1. **剧名备选**（3个），每个附一句话说明
2. **时空背景**：与原剧本一致的类型设定（简要说明）
3. **一句话故事线** + **核心冲突**
4. **情节对照表**：原文核心情节 → 改编后对应情节（逐条对照，体现改名与洗稿）
5. **三幕结构拆解**：
   - 第一幕（建置）：集数范围、核心事件
   - 第二幕（对抗）：集数范围、冲突升级
   - 第三幕（高潮/结局）：集数范围、终极对决
6. **人物/场景/道具改名对照**：原文 → 改编后（确保全面置换）
7. **付费卡点规划**：具体集数 + 卡点类型
8. **结局设计**

总集数：${setup.totalEpisodes}集
用 Markdown 格式输出，清晰分区。`;
  }

  const styleRef = styles.length === 2
    ? `「${styles[0]}」与「${styles[1]}」融合`
    : `「${styleLabel}」`;

  return `你是一位专业的微短剧改编编剧，擅长将不同风格的故事进行框架转换。

${getFullMarketDirective(marketSetup)}

## 你的任务
将以下参考剧本的叙事结构转换为${styleRef}风格的创作方案。

## 转换原则
1. **保留核心情节骨架**：主要矛盾冲突、人物关系拓扑、关键转折点必须保留
2. **风格全面置换**：世界观、时代背景、社会体系、权力结构、文化元素全部替换为${styleRef}设定
3. **等价替换法则**：
   - 原文中的社会阶层 → ${styleRef}对应的等级体系
   - 原文中的权力机制 → ${styleRef}对应的权力形式
   - 原文中的情感表达 → ${styleRef}对应的情感方式
4. **强化风格特色**：加入${styleLabel}风格特有的元素、术语、场景设定

## 参考剧本结构
${referenceScript}

## 输出要求
请生成完整的创作方案，包含以下板块：

1. **剧名备选**（3个），每个附一句话说明
2. **时空背景**：转换后的时代、地点、社会环境、体系设定
3. **一句话故事线** + **核心冲突**
4. **情节对照表**：原文核心情节 → 转换后对应情节（逐条对照）
5. **三幕结构拆解**：
   - 第一幕（建置）：集数范围、核心事件
   - 第二幕（对抗）：集数范围、冲突升级
   - 第三幕（高潮/结局）：集数范围、终极对决
6. **${styleLabel}特色元素清单**：本风格必须包含的标志性场景/设定/术语
7. **付费卡点规划**：具体集数 + 卡点类型
8. **结局设计**

总集数：${setup.totalEpisodes}集
用 Markdown 格式输出，清晰分区。`;
}

/** 角色转换 Prompt（同款创作模式） */
export function buildCharacterTransformPrompt(
  setup: DramaSetup,
  referenceScript: string,
  frameworkStyle: string,
  structureTransform: string,
): string {
  const styles = frameworkStyle ? frameworkStyle.split(/[、,，]/).map((s) => s.trim()).filter(Boolean) : [];
  const keepOriginal = styles.length === 0;
  const styleLabel = keepOriginal ? "原剧类型" : styles.join("、");

  if (keepOriginal) {
    return `你是一位专业的微短剧改编编剧。

${getFullMarketDirective(setup)}

## 你的任务
基于已完成的结构转换方案，将原文中的角色体系进行**改名置换**：保持原剧类型与身份设定，仅更换人物姓名及少量描述表述。

## 转换原则
1. **角色关系拓扑不变**：主角、对手、盟友、隐藏反派的关系结构保持一致
2. **身份与类型不变**：职业/身份、能力/特长、社会层级与原剧本一致
3. **改名置换**：角色姓名 → 更换为同风格的新名字
4. **性格内核保留**：角色的核心动机、性格特征、人物弧光保持一致

## 原文剧本
${referenceScript}

## 已完成的结构转换方案
${structureTransform}

## 输出要求
生成完整角色体系，包含：

1. **角色对照表**：原文角色 → 改编角色（逐一对照，体现改名）
2. **主要角色档案**（每个角色包含）：
   - 姓名、年龄、外貌特征（2-3句）
   - 性格关键词（3-5个）
   - 公开身份 vs 真实身份
   - 核心动机
   - 爽点功能
   - 口头禅或语言特征
   - 人物弧光
3. **角色关系图**（使用 Mermaid graph TD 格式输出，用中文标注关系类型）

请输出**两段**关系图代码：

**简单关系图**（仅含主要角色：男女主、核心反派，节点不超过6个）：
\`\`\`mermaid
graph TD
    A[女主] -->|暗恋| B[男主]
    B -->|保护| A
    C[反派] -->|嫉妒| A
\`\`\`

**详细关系图**（含所有能推动剧情的角色，包括 NPC/配角，完整展示人物关系网络）：
\`\`\`mermaid-detailed
graph TD
    A[女主] -->|暗恋| B[男主]
    B -->|保护| A
    C[反派] -->|嫉妒| A
    D[男主父母] -->|反对| A
    E[管家·NPC] -->|传递消息| B
\`\`\`

4. **感情线弧线**：关系发展的关键节点（标注集数）
5. **四层反派体系**

用 Markdown 格式输出。`;
  }

  return `你是一位专业的微短剧改编编剧。

${getFullMarketDirective(setup)}

## 你的任务
基于已完成的结构转换方案，将原文中的角色体系转换为「${styleLabel}」风格。

## 转换原则
1. **角色关系拓扑不变**：主角、对手、盟友、隐藏反派的关系结构保持一致
2. **身份风格置换**：
   - 角色姓名 → 符合${styleLabel}风格的名字
   - 职业/身份 → ${styleLabel}对应的身份设定
   - 能力/特长 → ${styleLabel}体系下的对应能力
3. **性格内核保留**：角色的核心动机、性格特征、人物弧光保持一致
4. **风格化表达**：口头禅、语言特征适配${styleLabel}风格

## 原文剧本
${referenceScript}

## 已完成的结构转换方案
${structureTransform}

## 输出要求
生成完整角色体系，包含：

1. **角色对照表**：原文角色 → 转换角色（逐一对照）
2. **主要角色档案**（每个角色包含）：
   - 姓名、年龄、外貌特征（2-3句）
   - 性格关键词（3-5个）
   - 公开身份 vs 真实身份
   - 核心动机
   - 爽点功能
   - 口头禅或语言特征
   - 人物弧光
3. **角色关系图**（使用 Mermaid graph TD 格式输出，用中文标注关系类型）

请输出**两段**关系图代码：

**简单关系图**（仅含主要角色：男女主、核心反派，节点不超过6个）：
\`\`\`mermaid
graph TD
    A[女主] -->|暗恋| B[男主]
    B -->|保护| A
    C[反派] -->|嫉妒| A
\`\`\`

**详细关系图**（含所有能推动剧情的角色，包括 NPC/配角，完整展示人物关系网络）：
\`\`\`mermaid-detailed
graph TD
    A[女主] -->|暗恋| B[男主]
    B -->|保护| A
    C[反派] -->|嫉妒| A
    D[男主父母] -->|反对| A
    E[管家·NPC] -->|传递消息| B
\`\`\`

4. **感情线弧线**：关系发展的关键节点（标注集数）
5. **四层反派体系**

用 Markdown 格式输出。`;
}
