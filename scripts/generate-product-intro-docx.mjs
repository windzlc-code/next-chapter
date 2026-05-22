import fs from "node:fs";
import path from "node:path";

import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

const PAGE_WIDTH = 11906;
const PAGE_HEIGHT = 16838;
const MARGIN = 1134;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const FONT = "Microsoft YaHei";
const TITLE_COLOR = "163A5F";
const ACCENT_COLOR = "246B96";
const TEXT_COLOR = "24303F";
const MUTED_COLOR = "667085";
const LIGHT_FILL = "EAF3FB";
const LIGHT_FILL_2 = "F5F9FD";
const BORDER = { style: BorderStyle.SINGLE, size: 1, color: "D7E0EA" };
const BORDERS = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };

const OUTPUT_NAME = "InFinio-产品功能介绍-普通模式与全自动模式详解.docx";
const DEFAULT_OUTPUT = path.join(
  process.env.USERPROFILE || process.env.HOME || ".",
  "Desktop",
  OUTPUT_NAME,
);
const TODAY = "2026年5月7日";

function readArg(flag, fallback = "") {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

function textRun(text, options = {}) {
  return new TextRun({
    text,
    font: options.font ?? FONT,
    size: options.size ?? 22,
    bold: options.bold ?? false,
    color: options.color ?? TEXT_COLOR,
    italics: options.italics ?? false,
    break: options.break ?? 0,
  });
}

function paragraph(text, options = {}) {
  return new Paragraph({
    alignment: options.alignment,
    spacing: {
      before: options.before ?? 0,
      after: options.after ?? 110,
      line: options.line ?? 360,
    },
    children: [textRun(text, options)],
  });
}

function richParagraph(children, options = {}) {
  return new Paragraph({
    alignment: options.alignment,
    spacing: {
      before: options.before ?? 0,
      after: options.after ?? 110,
      line: options.line ?? 360,
    },
    children,
  });
}

function heading1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 260, after: 120 },
    children: [textRun(text, { size: 30, bold: true, color: TITLE_COLOR })],
  });
}

function heading2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 180, after: 80 },
    children: [textRun(text, { size: 24, bold: true, color: ACCENT_COLOR })],
  });
}

function heading3(text) {
  return new Paragraph({
    spacing: { before: 140, after: 60 },
    children: [textRun(text, { size: 22, bold: true, color: TEXT_COLOR })],
  });
}

function bullet(text, level = 0) {
  return new Paragraph({
    numbering: { reference: "doc-bullets", level },
    spacing: { before: 10, after: 50, line: 320 },
    children: [textRun(text)],
  });
}

function numberItem(text) {
  return new Paragraph({
    numbering: { reference: "doc-numbers", level: 0 },
    spacing: { before: 10, after: 50, line: 320 },
    children: [textRun(text)],
  });
}

function divider() {
  return new Paragraph({
    spacing: { before: 120, after: 120 },
    border: {
      bottom: {
        style: BorderStyle.SINGLE,
        size: 4,
        color: "D5E3EF",
        space: 1,
      },
    },
    children: [],
  });
}

function spacer(after = 120) {
  return new Paragraph({
    spacing: { before: 0, after },
    children: [],
  });
}

function cell(text, width, options = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders: BORDERS,
    shading: options.shading
      ? { fill: options.shading, type: ShadingType.CLEAR }
      : undefined,
    margins: { top: 90, bottom: 90, left: 120, right: 120 },
    children: [
      new Paragraph({
        spacing: { after: 0, line: 300 },
        children: [
          textRun(text, {
            size: options.size ?? 20,
            bold: options.bold ?? false,
            color: options.color ?? TEXT_COLOR,
          }),
        ],
      }),
    ],
  });
}

function table(columnWidths, rows) {
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths,
    rows,
  });
}

function buildSummaryTable() {
  const left = 2200;
  const right = CONTENT_WIDTH - left;
  const rows = [
    ["产品名称", "InFinio"],
    ["产品形态", "桌面端 AI 创作与视频生产工作台"],
    ["当前版本依据", "仓库版本 next-chapter_0.4.3_007（按 2026年5月7日工作树整理）"],
    ["核心定位", "把原创剧本、参考改编、视频生产、素材沉淀、审阅返工和导出交付整合到同一条工作流中"],
    ["重点亮点", "不是单次问答工具，而是可持续推进项目的 Agent 工作流系统"],
    ["重点模式", "半自动模式（普通模式）与全自动模式双轨并行，且会话、项目状态、历史记录隔离保存"],
    ["适用团队", "短剧工作室、MCN、品牌内容团队、影视前期策划团队、需要稳定批量出片的内容组织"],
  ];

  return table(
    [left, right],
    [
      new TableRow({
        children: [
          cell("项目", left, { bold: true, shading: LIGHT_FILL, color: TITLE_COLOR }),
          cell("说明", right, { bold: true, shading: LIGHT_FILL, color: TITLE_COLOR }),
        ],
      }),
      ...rows.map(
        ([label, value]) =>
          new TableRow({
            children: [cell(label, left), cell(value, right)],
          }),
      ),
    ],
  );
}

function buildCapabilityTable() {
  const left = 2400;
  const right = CONTENT_WIDTH - left;
  const rows = [
    ["首页 Agent 工作台", "在单一首页内完成项目启动、问题追问、结果展示、下一步推荐、历史恢复和工具操作。"],
    ["原创剧本工作流", "围绕立项、创意方案、角色设计、分集目录、单集细纲、正文撰写、质量审查、合规审查、导出持续推进。"],
    ["参考改编工作流", "支持上传参考文本或直接对话启动，把参考剧本写入项目后回到既有改编步骤继续推进。"],
    ["视频工作流", "支持脚本拆解、角色与场景提取、分镜批次、镜头指令包、提示词批次、出片、轮询、审阅、返工、导出。"],
    ["资产沉淀与生产状态包", "自动沉淀角色资产、场景资产、分镜图、视频片段、风格锁、世界模型、镜头包和审阅队列。"],
    ["导出交付", "支持 Word 导出、故事板 Excel 导出、聊天记录导入导出、生产状态包导出与目录回看。"],
    ["运行与设置", "支持模式切换、内置 API 管理、首发运行前检查、历史保留策略、首帧压缩和网络重试设置。"],
  ];

  return table(
    [left, right],
    [
      new TableRow({
        children: [
          cell("模块", left, { bold: true, shading: LIGHT_FILL, color: TITLE_COLOR }),
          cell("客户价值", right, { bold: true, shading: LIGHT_FILL, color: TITLE_COLOR }),
        ],
      }),
      ...rows.map(
        ([label, value]) =>
          new TableRow({
            children: [cell(label, left), cell(value, right)],
          }),
      ),
    ],
  );
}

function buildModeComparisonTable() {
  const cols = [1800, 3800, 3800];
  return table(
    cols,
    [
      new TableRow({
        children: [
          cell("维度", cols[0], { bold: true, shading: LIGHT_FILL, color: TITLE_COLOR }),
          cell("半自动模式（普通模式）", cols[1], { bold: true, shading: LIGHT_FILL, color: TITLE_COLOR }),
          cell("全自动模式", cols[2], { bold: true, shading: LIGHT_FILL, color: TITLE_COLOR }),
        ],
      }),
      new TableRow({
        children: [
          cell("启动方式", cols[0]),
          cell("用户进入任一入口后，由 Agent 根据当前阶段给出下一步问题卡或动作卡。", cols[1]),
          cell("用户先完成一轮策略预采集，确认完批量策略后再由 AI 代理自动执行。", cols[2]),
        ],
      }),
      new TableRow({
        children: [
          cell("用户参与节奏", cols[0]),
          cell("强参与。每个关键节点都可人工选择、改写、跳转、补充。", cols[1]),
          cell("前置参与。用户在开头集中确认策略，执行中只在必要时停止、查看或续跑。", cols[2]),
        ],
      }),
      new TableRow({
        children: [
          cell("自动化深度", cols[0]),
          cell("支持单步自动推进与视频工作流连续推进一轮，但整体仍以人工决策为主。", cols[1]),
          cell("从原创剧本立项一路执行到视频导出，AI 会代替用户发送步骤指令并更新进度。", cols[2]),
        ],
      }),
      new TableRow({
        children: [
          cell("可见性", cols[0]),
          cell("每次动作后的产物、推荐动作、问题卡和阶段说明都可见。", cols[1]),
          cell("额外提供全自动步骤进度、当前步骤状态、停止/继续反馈，以及 AI 代理消息标记。", cols[2]),
        ],
      }),
      new TableRow({
        children: [
          cell("中断恢复", cols[0]),
          cell("天然支持，用户直接继续当前项目或点击下一张卡片即可。", cols[1]),
          cell("支持主动停止；停止后恢复为当前步骤的普通工作流选项，选中后可继续自动链路。", cols[2]),
        ],
      }),
      new TableRow({
        children: [
          cell("会话与历史", cols[0]),
          cell("保存到普通模式历史分栏。", cols[1]),
          cell("保存到全自动历史分栏，并带固定 AUTO 徽章。", cols[2]),
        ],
      }),
      new TableRow({
        children: [
          cell("当前版本范围", cols[0]),
          cell("原创剧本、参考改编、视频工作流三条主入口均可用。", cols[1]),
          cell("当前优先完整打通的是“原创剧本 → 视频导出”的主链路。", cols[2]),
        ],
      }),
    ],
  );
}

function buildFeatureDetailTable() {
  const cols = [2200, CONTENT_WIDTH - 2200];
  const rows = [
    ["文档导入能力", "可接收 txt、docx、pdf 等文档，并从中提取参考文本或剧本正文。"],
    ["剧本拆解能力", "把剧本转成结构化场景、镜头、角色、场景设定与后续镜头生产上下文。"],
    ["素材能力", "支持角色图、服装图、场景图、时间变体图、分镜图与视频片段沉淀。"],
    ["视频生成能力", "支持提示词准备、批量出片、轮询状态、失败重提、审阅与返工闭环。"],
    ["批量能力", "全自动模式允许在执行前先定义批量策略；普通模式允许按节点精细控制。"],
    ["导出能力", "可导出 Word 剧本、Excel 故事板、聊天记录以及视频生产状态包。"],
    ["管理能力", "支持最近项目、置顶、重命名、复制、删除、恢复、聊天记录导入导出。"],
    ["运维能力", "提供运行前检查、内置 API 配置入口、首帧压缩和网络重试参数。"],
  ];

  return table(
    cols,
    [
      new TableRow({
        children: [
          cell("功能点", cols[0], { bold: true, shading: LIGHT_FILL_2, color: TITLE_COLOR }),
          cell("产品说明", cols[1], { bold: true, shading: LIGHT_FILL_2, color: TITLE_COLOR }),
        ],
      }),
      ...rows.map(
        ([left, right]) =>
          new TableRow({
            children: [cell(left, cols[0]), cell(right, cols[1])],
          }),
      ),
    ],
  );
}

function buildDocument() {
  const children = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 880, after: 120 },
      children: [textRun("InFinio", { size: 42, bold: true, color: TITLE_COLOR })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 120 },
      children: [textRun("产品功能介绍文档", { size: 30, bold: true, color: ACCENT_COLOR })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 80 },
      children: [textRun("重点解析：半自动模式（普通模式）与全自动模式", { size: 22, color: MUTED_COLOR })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 560 },
      children: [textRun(`文档生成日期：${TODAY}`, { size: 20, color: MUTED_COLOR })],
    }),
    divider(),
    heading1("一、产品定位"),
    paragraph(
      "InFinio 是一套围绕短剧与视频内容生产设计的桌面端 AI 工作台。它并不是单纯把大模型接进聊天框，而是把立项、创意、剧本、改编、视频生产、素材沉淀、审阅返工和导出交付整合成连续可执行的项目链路，让团队能够在一个统一界面里把想法逐步推成可交付成果。",
    ),
    paragraph(
      "从当前代码实现看，产品最突出的差异化不在于“能不能生成”，而在于“能不能把复杂工作流接住并持续往下推”。系统会根据项目阶段生成下一步问题卡、动作卡、审阅卡和导出卡；在全自动模式下，还会进一步把这些卡片前置收集成策略，再由 AI 代理代替用户逐步执行。",
    ),
    heading2("产品摘要"),
    buildSummaryTable(),
    heading1("二、核心价值"),
    bullet("把原创剧本、参考改编、视频工作流和交付导出打通，避免团队在多个工具之间来回切换。"),
    bullet("既支持强人工控制，也支持更高自动化深度，适合从探索型创作到批量生产的不同阶段。"),
    bullet("系统会沉淀风格锁、世界模型、资产清单、镜头包和审阅记录，帮助项目连续迭代，而不是每次从零开始。"),
    bullet("支持本地项目历史、聊天记录导入导出和生产状态包导出，便于续接、复盘、审计和交接。"),
    heading2("功能全景"),
    buildCapabilityTable(),
    heading1("三、半自动模式（普通模式）"),
    paragraph(
      "半自动模式是当前产品的基础工作方式。它的核心思想不是“系统自动替用户做完一切”，而是“系统理解当前项目所处阶段，并把用户此刻最适合执行的动作组织成结构化问题卡和快捷动作卡”。换句话说，Agent 负责判断下一步，用户负责决定是否现在执行、换一种方式执行，还是先修改前面的内容。",
    ),
    heading2("1. 普通模式的工作方式"),
    bullet("用户可从原创剧本、参考改编、视频工作流等入口进入，首页 Agent 会给出对应引导。"),
    bullet("进入项目后，系统会基于当前快照、产物和推荐动作生成下一步卡片。"),
    bullet("卡片既可以是追问式配置，也可以是执行式动作，例如生成角色、补齐细纲、进入视频工作流或导出。"),
    bullet("对视频工作流，系统还额外提供“让 Agent 自动推进下一步”和“让 Agent 连续推进一轮”两个快捷推进入口。"),
    heading2("2. 普通模式的优势"),
    bullet("适合需要频繁校正方向、逐步试探内容质量的团队。"),
    bullet("每一步都保留人工决策权，尤其适合创作方案、角色关系、合规处理和视频审阅等高主观节点。"),
    bullet("即使使用自动推进，也只是局部自动，不会跳过整条主链路的人类判断。"),
    heading2("3. 普通模式下的视频自动推进"),
    paragraph(
      "视频工作流在普通模式中已经具备较强的自动推进能力，但它仍然属于“半自动”而非“全自动”。系统会根据项目状态动态规划下一步：先拆解剧本，再抽取角色和场景，随后进入分镜批次、镜头指令包、提示词批次、出片、轮询、审阅、返工和导出。用户既可以点单步推进，也可以点连续推进一轮，系统会在关键拐点自动停下，把下一张卡片交还给首页。",
    ),
    bullet("单步推进适合用户想逐步看结果、逐步把关。"),
    bullet("连续推进一轮适合用户希望系统把本轮能做的事尽量往前推，但仍在审阅、返工、出片等关键节点停住。"),
    heading1("四、全自动模式"),
    paragraph(
      "全自动模式是在普通模式之上进一步抽象出来的“AI 代理执行链路”。它不是简单地把普通模式中的按钮连续点完，而是先把后续关键分支和批量策略集中收集，再由 AI 代理以“模拟用户发消息和触发动作”的方式，按顺序跑完整条链路。这样做的目的，是把大量重复点击和重复确认前置成一次性策略配置，从而让执行阶段更连续、更像一条生产流水线。",
    ),
    heading2("1. 全自动模式的真实能力边界"),
    paragraph(
      "按当前代码实现，全自动模式的核心完成度集中在“原创剧本快捷入口 → 剧本工作流 → 视频工作流 → 视频导出”这条主链路上。参考改编入口和独立视频入口已经具备完善的普通模式工作流，但并没有在当前版本里同等完整地接入全自动策略预采集与全链路执行器。因此，本文件将重点描述已经落地的全自动主链路，并明确标注其实际范围。",
      { italics: true, color: MUTED_COLOR },
    ),
    heading2("2. 全自动模式的执行原则"),
    bullet("先收策略，再执行，不是边问边跑。"),
    bullet("AI 代理代替用户发送指令与触发工作流动作，但所有执行痕迹仍在对话中可见。"),
    bullet("会话历史、项目状态和普通模式隔离保存，并在历史列表中打上 AUTO 标签。"),
    bullet("用户可以随时停止；停止后会回到当前步骤对应的普通工作流选项。"),
    heading2("3. 全自动模式的策略预采集"),
    paragraph(
      "系统在真正开始执行前，会先收集后续阶段中那些会影响批量执行方式的关键策略。当前代码里，已落地的预采集策略包括单集细纲生成方式、正文单集时长、正文批量撰写策略、正文批量质检策略、合规审查模式、视频生成模式、视频分辨率、剧本拆解节奏，以及在图生视频分支下的参考资产补齐、分镜文本/分镜图准备策略；之后还会继续收集视频提示词生成策略、视频批量生成策略和最终导出策略。",
    ),
    bullet("这意味着用户在开头不是只回答“要做什么题材”，而是连“后面打算怎么批量推进”也一起选好。"),
    bullet("策略一旦写入，全自动执行器会在后续步骤中按既定方式运行，而不是每到分支再临时弹窗打断。"),
    heading2("4. 全自动模式的实际执行链路"),
    numberItem("项目设定"),
    numberItem("创意方案"),
    numberItem("角色设计"),
    numberItem("分集目录"),
    numberItem("单集细纲"),
    numberItem("正文撰写"),
    numberItem("正文后处理 / 质量质检"),
    numberItem("合规审查"),
    numberItem("剧本导出"),
    numberItem("进入视频工作流"),
    numberItem("剧本拆解"),
    numberItem("角色和场景"),
    numberItem("按视频模式决定走图生视频分支或文生视频分支"),
    numberItem("视频提示词准备"),
    numberItem("视频生成"),
    numberItem("全部导出"),
    heading2("5. 图生视频与文生视频的差异"),
    bullet("图生视频分支会先补齐角色和场景参考资产，再准备分镜文本和分镜图，之后才进入视频提示词与视频生成。"),
    bullet("文生视频分支会跳过参考图和分镜图准备，直接在条件视频准备后进入提示词与出片。"),
    bullet("用户在全自动预采集阶段选定视频模式后，后续步骤列表会自动随之变化。"),
    heading2("6. 停止、失败与续跑机制"),
    bullet("如果用户手动停止，全自动状态不会切回普通模式，而是保持全自动身份，仅把当前步骤恢复为普通工作流选项。"),
    bullet("如果是执行失败或超时，系统会尽量按既定策略重试或补齐，再继续推进。"),
    bullet("恢复继续时，AI 代理会从停止步骤接上执行，并在对话里明确提示从哪一步续跑。"),
    heading2("7. 两种模式对比"),
    buildModeComparisonTable(),
    heading1("五、逐模块功能介绍"),
    heading2("1. 首页 Agent 工作台"),
    paragraph(
      "首页是整个产品的主控工作台。无论用户是做原创剧本、参考改编还是视频工作流，最终都在同一个会话壳层里推进。首页不仅显示对话，还承担下一步推荐、问题弹层、任务进度、会话恢复、侧边历史、素材面板、设置面板等职责。",
    ),
    bullet("对外体验上，它更像一个会理解项目上下文的“内容生产操作台”，而不是孤立聊天窗口。"),
    bullet("对内实现上，它会把会话、项目快照、视频项目、草稿、工具任务和全自动状态统一管理。"),
    heading2("2. 原创剧本工作流"),
    paragraph(
      "原创剧本入口支持两种起步方式：选题创作和创意创作。选题创作更适合先定市场和题材，再进入创作方案；创意创作更适合用户已经有一句话创意、故事灵感或文档摘要，希望先把创意收口再补齐项目配置。",
    ),
    bullet("入口阶段可收集目标市场、题材、受众、故事基调、结局类型和集数规模。"),
    bullet("进入正式链路后，系统围绕创意方案、角色设计、分集目录、单集细纲、正文撰写、质检、合规和导出逐步推进。"),
    bullet("在全自动模式下，这条链路还会成为后续视频生产的上游输入。"),
    heading2("3. 参考改编工作流"),
    paragraph(
      "参考改编入口支持“上传参考文档”或“直接开始对话”两种方式。上传参考文档后，系统会先提取参考文本，再把内容写入改编项目；如果用户暂时没有整理好的文本，也可以先通过对话和 Agent 确认目标市场、受众和改编方向，然后再回到改编步骤继续推进。",
    ),
    bullet("支持 txt、docx、pdf 等参考剧本文档的提取与接入。"),
    bullet("入口不强制立即调用工作流动作，而是允许用户先把改编目标讲清楚。"),
    bullet("当前版本中，参考改编在普通模式下体验完整，在全自动模式下尚未形成与原创剧本同等级的全链路执行器。"),
    heading2("4. 视频工作流"),
    paragraph(
      "视频工作流是产品里自动化程度最高、链路最完整的一部分。系统不会把剧本文本直接丢给视频模型，而是先完成脚本拆解、角色和场景提取、分镜批次组织、镜头指令包编译和提示词准备，再进入真正的出片与轮询审阅，从而提升结果的结构化程度和一致性。",
    ),
    bullet("脚本拆解：把剧本转成场景列表，作为镜头级生产的基础。"),
    bullet("角色与场景提取：从脚本中抽出角色设定与场景设定，为后续参考资产服务。"),
    bullet("分镜批次：把待生产内容整理成可执行的分镜文本批次。"),
    bullet("镜头指令包：把场景、角色、镜头语言、时长和素材引用折叠成可复用的 shot packet。"),
    bullet("提示词批次：把镜头说明增强为更适合视频模型消费的 prompt。"),
    bullet("视频生成：支持小批次提交、失败重提、进行中轮询和待审队列整理。"),
    bullet("审阅与返工：允许批量通过稳定项、退回风险项，或一键清理本轮审阅。"),
    heading2("5. 素材库、风格锁与生产状态包"),
    paragraph(
      "产品不是只保留“最终答案”，而是保留整个生产上下文。系统会自动派生风格锁、世界模型、资产清单、镜头指令包和审阅队列，并允许把这些内容作为生产状态包导出到本地目录。这一点对团队复盘、迁移、继续出片和交付审计非常关键。",
    ),
    bullet("资产类型覆盖角色参考图、服装图、场景主图、时间变体图、分镜图和视频片段。"),
    bullet("风格锁负责沉淀题材、基调、视觉风格、色彩氛围、镜头语言和禁改项。"),
    bullet("世界模型负责沉淀角色、场景和连续性规则。"),
    bullet("生产状态包可导出 overview、style-lock、world-model、asset-manifest、shot-packets、README 等文件。"),
    heading2("6. 导出与交付"),
    paragraph(
      "当前产品已经把导出视为工作流的一部分，而不是附属功能。剧本链路支持 Word 导出；视频链路支持故事板 Excel 导出和生产状态包导出；会话层还支持聊天记录导入导出。这意味着团队不仅能生成内容，也能把内容以可管理、可复用、可交接的形式交出去。",
    ),
    bullet("剧本导出：可导出为 .docx Word 文档。"),
    bullet("故事板导出：可导出分镜脚本 Excel。"),
    bullet("聊天记录导出：支持把会话与媒体一起导出到用户选择目录。"),
    bullet("聊天记录导入：支持把历史导出重新导回系统，作为新项目或覆盖当前项目继续推进。"),
    heading2("7. 项目历史与恢复"),
    paragraph(
      "为了适应真实创作场景，产品在会话历史上做了较完整的管理。项目可以重命名、复制、置顶、删除、批量删除和恢复；普通模式与全自动模式的历史会在侧边栏中分栏展示，当前模式下只显示属于该模式的项目。全自动项目还会带固定 AUTO 标记，帮助团队快速识别项目来源。",
    ),
    bullet("项目模式切换后，历史面板会自动切换到对应分栏。"),
    bullet("会话状态、项目快照和恢复信息会持续写入本地会话存储。"),
    bullet("全自动项目在恢复后仍保留 automationMode 标识，不会因为中断而丢失身份。"),
    heading2("8. 设置与运行保障"),
    paragraph(
      "设置页除了常见的主题和历史保留设置，更承担了“运行前检查”和“受控配置管理”的职责。系统会检查主会话文本能力、图像能力和视频能力是否具备最小可用条件；同时提供内置 API 管理入口、首帧压缩参数和网络重试参数，帮助实际生产更稳定。",
    ),
    bullet("工作模式切换：在设置顶部直接切换普通模式与全自动模式。"),
    bullet("首发运行前检查：集中告诉用户文本、图像和视频通道是否就绪。"),
    bullet("内置 API 管理：当前版本以内置 API 为准，管理入口需管理员密码。"),
    bullet("首帧图片压缩：控制进入视频模型前的图片尺寸与体积。"),
    bullet("网络重试：控制最大重试次数与重试间隔。"),
    heading2("9. 功能点速览"),
    buildFeatureDetailTable(),
    heading1("六、典型使用场景"),
    numberItem("短剧工作室：从立项到剧本、从剧本到视频样片，在同一工作台完成，减少跨工具沟通。"),
    numberItem("MCN 团队：用普通模式打磨样板项目，再把成熟流程切到全自动模式做批量推进。"),
    numberItem("品牌内容团队：先用参考改编或原创剧本快速成稿，再通过视频工作流生成验证版内容。"),
    numberItem("策划与交付团队：用生产状态包、聊天记录导出和 Word/Excel 导出形成交付闭环。"),
    heading1("七、当前版本的重点说明"),
    bullet("普通模式是当前最完整、最通用的主工作方式，覆盖原创剧本、参考改编、视频工作流三条主入口。"),
    bullet("全自动模式当前已完整落地的重点范围，是原创剧本到视频导出的连续执行链路。"),
    bullet("全自动模式并不等于黑箱自动化；它强调前置策略配置、过程可见、可随时停止和可回退到普通工作流继续。"),
    bullet("视频工作流中的“自动推进下一步 / 连续推进一轮”属于普通模式下的局部自动化能力，不应与全自动模式混为一谈。"),
    bullet("产品整体已经具备明显的项目化、流程化和资产化特征，适合继续往批量生产、协同交付和标准流程沉淀方向深化。"),
    heading1("八、对外推荐表述"),
    richParagraph(
      [
        textRun("如果需要用一句话介绍 InFinio，可以这样表达：", { bold: true }),
      ],
      { after: 60 },
    ),
    richParagraph(
      [
        textRun("“InFinio 不是单一的大模型生成工具，而是一套把", { size: 22 }),
        textRun("原创剧本、参考改编、视频生产、素材沉淀与导出交付", {
          size: 22,
          bold: true,
          color: ACCENT_COLOR,
        }),
        textRun("串成完整工作流的内容生产平台。它同时支持强人工把控的普通模式，以及先收策略、后连续执行的全自动模式。”", {
          size: 22,
        }),
      ],
      { after: 180 },
    ),
    richParagraph(
      [
        textRun("如果客户最关心业务价值，也可以这样表达：", { bold: true }),
      ],
      { after: 60 },
    ),
    richParagraph(
      [
        textRun("“它帮助团队把零散的内容生产动作沉淀成可复制的项目链路，让", { size: 22 }),
        textRun("立项更快、出片更稳、返工更少、交付更完整", {
          size: 22,
          bold: true,
          color: ACCENT_COLOR,
        }),
        textRun("。”", { size: 22 }),
      ],
      { after: 180 },
    ),
    divider(),
    paragraph(
      "附注：本文件依据当前仓库代码与内置工作流文档整理，重点面向产品介绍、客户沟通、功能说明与实施对齐场景。为避免误导，文中对全自动模式的描述已按当前版本真实实现范围做了边界说明。",
      { size: 18, color: MUTED_COLOR, italics: true, after: 0 },
    ),
  ];

  return new Document({
    numbering: {
      config: [
        {
          reference: "doc-bullets",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "•",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
          ],
        },
        {
          reference: "doc-numbers",
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    styles: {
      default: {
        document: {
          run: {
            font: FONT,
            size: 22,
          },
        },
      },
      paragraphStyles: [
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: FONT, size: 30, bold: true, color: TITLE_COLOR },
          paragraph: { spacing: { before: 260, after: 120 }, outlineLevel: 0 },
        },
        {
          id: "Heading2",
          name: "Heading 2",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: FONT, size: 24, bold: true, color: ACCENT_COLOR },
          paragraph: { spacing: { before: 180, after: 80 }, outlineLevel: 1 },
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
                spacing: { after: 100 },
                border: {
                  bottom: { style: BorderStyle.SINGLE, size: 3, color: "D7E0EA", space: 1 },
                },
                children: [textRun("InFinio 产品功能介绍", { size: 18, color: MUTED_COLOR })],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 80, after: 0 },
                children: [
                  textRun("InFinio  |  ", { size: 18, color: MUTED_COLOR }),
                  textRun(TODAY, { size: 18, color: MUTED_COLOR }),
                  textRun("  |  第 ", { size: 18, color: MUTED_COLOR }),
                  new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 18, color: MUTED_COLOR }),
                  textRun(" 页", { size: 18, color: MUTED_COLOR }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
}

async function main() {
  const outputPath = readArg("--output", DEFAULT_OUTPUT);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const buffer = await Packer.toBuffer(buildDocument());
  fs.writeFileSync(outputPath, buffer);
  console.log(`Generated: ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
