// 短剧创作项目类型定义
import { generateId } from "@/lib/generate-id";
import type { VideoStyleLock, VideoWorldModel } from "@/types/project";

/** 题材顶层分类（合并展示，避免过细） */
export type GenreCategory =
  | "情感与生活"
  | "古风与幻想"
  | "都市与热血"
  | "悬疑与罪案"
  | "科幻与未来";

export const GENRES = [
  // 国内市场
  { value: "都市言情", label: "都市言情", desc: "都市背景下的情感关系与现实抉择", audience: "女频", category: "情感与生活", markets: ["cn", "kr", "sea"] },
  { value: "豪门婚恋", label: "豪门婚恋", desc: "豪门阶层、利益纠葛与婚恋博弈", audience: "女频", category: "情感与生活", markets: ["cn", "kr", "sea"] },
  { value: "古风权谋", label: "古风权谋", desc: "朝堂权斗、家国格局与生存策略", audience: "男女通吃", category: "古风与幻想", markets: ["cn"] },
  { value: "宫廷宅斗", label: "宫廷宅斗", desc: "宫廷与高门体系中的智斗与布局", audience: "女频", category: "古风与幻想", markets: ["cn"] },
  { value: "古风仙侠", label: "古风仙侠", desc: "仙门因果、宿命羁绊与三界争衡", audience: "男女通吃", category: "古风与幻想", markets: ["cn"] },
  { value: "都市爽文", label: "都市爽文", desc: "身份反转、打脸升级与高密度爽点", audience: "男频", category: "都市与热血", markets: ["cn"] },
  { value: "战神强者", label: "战神强者", desc: "顶级强者回归后的秩序重塑", audience: "男频", category: "都市与热血", markets: ["cn"] },
  { value: "悬疑刑侦", label: "悬疑刑侦", desc: "线索追踪、案件博弈与真相揭示", audience: "男女通吃", category: "悬疑与罪案", markets: ["cn", "west", "kr"] },
  { value: "武侠江湖", label: "武侠江湖", desc: "门派恩怨、江湖道义与侠义成长", audience: "男频", category: "古风与幻想", markets: ["cn"] },
  { value: "历史架空", label: "历史架空", desc: "架空王朝、制度重构与权谋博弈", audience: "男女通吃", category: "古风与幻想", markets: ["cn"] },
  { value: "种田基建", label: "种田基建", desc: "从零经营、资源积累与势力扩张", audience: "男女通吃", category: "都市与热血", markets: ["cn", "sea"] },
  { value: "娱乐圈星光", label: "娱乐圈星光", desc: "艺人成长、舆论场与名利博弈", audience: "女频", category: "都市与热血", markets: ["cn", "kr"] },
  { value: "无限副本", label: "无限副本", desc: "规则关卡、团队协作与生死闯关", audience: "男女通吃", category: "古风与幻想", markets: ["cn", "jp"] },
  { value: "快穿任务", label: "快穿任务", desc: "多世界任务链与身份切换推进主线", audience: "女频", category: "古风与幻想", markets: ["cn"] },
  { value: "末世废土", label: "末世废土", desc: "秩序崩塌后的掠夺、据点与生存法则", audience: "男频", category: "科幻与未来", markets: ["cn", "west"] },
  { value: "赛博近未来", label: "赛博近未来", desc: "义体、数据监控与底层反抗叙事", audience: "男女通吃", category: "科幻与未来", markets: ["cn", "west", "jp"] },
  { value: "民俗灵异", label: "民俗灵异", desc: "地方禁忌、灵异事件与人性试探", audience: "男女通吃", category: "悬疑与罪案", markets: ["cn"] },
  { value: "直播网红", label: "直播网红", desc: "流量经济、人设博弈与舆论反转", audience: "男女通吃", category: "都市与热血", markets: ["cn"] },
  { value: "美食治愈", label: "美食治愈", desc: "料理技艺、味觉记忆与关系修复", audience: "全龄", category: "情感与生活", markets: ["cn", "jp"] },
  { value: "谍战潜伏", label: "谍战潜伏", desc: "身份伪装、情报传递与阵营抉择", audience: "男频", category: "悬疑与罪案", markets: ["cn", "kr"] },
  { value: "电竞直播", label: "电竞直播", desc: "战队荣誉、直播舆论与职业成长", audience: "男频", category: "都市与热血", markets: ["cn", "kr"] },
  { value: "星际机甲", label: "星际机甲", desc: "机甲对抗、舰队战术与边疆冲突", audience: "男频", category: "科幻与未来", markets: ["west", "cn"] },
  { value: "人工智能伦理", label: "人工智能伦理", desc: "意识边界、人机关系与制度失控", audience: "男女通吃", category: "科幻与未来", markets: ["west", "cn"] },
  { value: "时间循环", label: "时间循环", desc: "同一时间轴重复中的破局与救赎", audience: "男女通吃", category: "悬疑与罪案", markets: ["west", "jp", "kr"] },
  { value: "赘婿逆袭", label: "赘婿逆袭", desc: "身份压制下的隐忍爆发与家族翻盘", audience: "男频", category: "都市与热血", markets: ["cn"] },
  { value: "神医流", label: "神医流", desc: "医术破局、奇症救治与势力拉拢", audience: "男频", category: "都市与热血", markets: ["cn"] },
  { value: "洪荒神话", label: "洪荒神话", desc: "上古神魔、量劫因果与证道争锋", audience: "男频", category: "古风与幻想", markets: ["cn"] },
  { value: "盗墓探险", label: "盗墓探险", desc: "古墓机关、历史谜团与夺宝求生", audience: "男频", category: "悬疑与罪案", markets: ["cn"] },
  { value: "鉴宝捡漏", label: "鉴宝捡漏", desc: "古玩眼力、江湖骗局与财富翻盘", audience: "男频", category: "都市与热血", markets: ["cn"] },

  // 日本市场
  { value: "日式治愈", label: "日式治愈", desc: "细腻日常中的情绪修复与温柔成长", audience: "全龄", category: "情感与生活", markets: ["jp"] },
  { value: "校园群像", label: "校园群像", desc: "多角色青春成长与关系交织", audience: "女频", category: "情感与生活", markets: ["jp"] },
  { value: "纯爱青春", label: "纯爱青春", desc: "克制情感与心动日常并行推进", audience: "女频", category: "情感与生活", markets: ["jp"] },
  { value: "职人匠心", label: "职人匠心", desc: "围绕职业精神与细节打磨的成长线", audience: "全龄", category: "情感与生活", markets: ["jp"] },
  { value: "家族羁绊", label: "家族羁绊", desc: "家族关系修复与代际情感和解", audience: "全龄", category: "情感与生活", markets: ["jp"] },
  { value: "轻小说奇想", label: "轻小说奇想", desc: "轻设定幻想与人物羁绊并重", audience: "男女通吃", category: "古风与幻想", markets: ["jp"] },
  { value: "异世界冒险", label: "异世界冒险", desc: "穿越异世界后的任务成长与伙伴协作", audience: "男女通吃", category: "古风与幻想", markets: ["jp", "west"] },
  { value: "校园超能力", label: "校园超能力", desc: "校园日常中嵌入能力设定与社交冲突", audience: "男女通吃", category: "古风与幻想", markets: ["jp"] },
  { value: "妖怪奇谈", label: "妖怪奇谈", desc: "民俗怪谈与温情治愈结合的奇谈线", audience: "男女通吃", category: "古风与幻想", markets: ["jp"] },
  { value: "本格推理", label: "本格推理", desc: "强调诡计与逻辑链条的推理叙事", audience: "男女通吃", category: "悬疑与罪案", markets: ["jp"] },
  { value: "社会派推理", label: "社会派推理", desc: "案件背后的社会议题与人性剖面", audience: "男女通吃", category: "悬疑与罪案", markets: ["jp"] },
  { value: "萌宠治愈", label: "萌宠治愈", desc: "人与动物陪伴中的情绪修复与日常", audience: "全龄", category: "情感与生活", markets: ["jp"] },
  { value: "美食职人", label: "美食职人", desc: "料理技艺、店铺传承与顾客羁绊", audience: "全龄", category: "情感与生活", markets: ["jp"] },
  { value: "推理漫画风", label: "推理漫画风", desc: "快节奏线索拼图与夸张反转的叙事", audience: "男女通吃", category: "悬疑与罪案", markets: ["jp"] },
  { value: "克苏鲁恐怖", label: "克苏鲁恐怖", desc: "未知恐惧、认知崩溃与禁忌真相", audience: "男女通吃", category: "悬疑与罪案", markets: ["jp", "west"] },
  { value: "机甲学院", label: "机甲学院", desc: "校园制度下的机甲训练与团队对抗", audience: "男频", category: "科幻与未来", markets: ["jp"] },
  { value: "慢生活田园", label: "慢生活田园", desc: "乡村节奏、人际温度与自我疗愈", audience: "全龄", category: "情感与生活", markets: ["jp"] },
  { value: "偶像养成", label: "偶像养成", desc: "练习生制度、舞台竞争与粉丝关系", audience: "女频", category: "都市与热血", markets: ["jp"] },
  { value: "警察搭档", label: "警察搭档", desc: "双主角刑侦、风格互补与案件推进", audience: "男女通吃", category: "悬疑与罪案", markets: ["jp"] },
  { value: "王道热血", label: "王道热血", desc: "友情羁绊、成长试炼与正义宣言", audience: "男频", category: "都市与热血", markets: ["jp"] },
  { value: "少女战斗", label: "少女战斗", desc: "少女主角与战斗设定结合的成长叙事", audience: "女频", category: "古风与幻想", markets: ["jp"] },
  { value: "虚拟现实", label: "虚拟现实", desc: "虚拟世界规则、身份与真实边界", audience: "男女通吃", category: "科幻与未来", markets: ["jp", "west"] },

  // 欧美市场
  { value: "高概念科幻", label: "高概念科幻", desc: "明确设定驱动的科技冲突与价值博弈", audience: "男女通吃", category: "科幻与未来", markets: ["west"] },
  { value: "超级英雄", label: "超级英雄", desc: "能力觉醒、责任命题与团队对抗", audience: "男女通吃", category: "科幻与未来", markets: ["west"] },
  { value: "末日生存", label: "末日生存", desc: "灾变世界中的资源争夺与人性考验", audience: "男女通吃", category: "科幻与未来", markets: ["west", "cn"] },
  { value: "太空歌剧", label: "太空歌剧", desc: "星际文明冲突与史诗级阵营对抗", audience: "男女通吃", category: "科幻与未来", markets: ["west"] },
  { value: "奇幻史诗", label: "奇幻史诗", desc: "宏大世界观下的王权与命运战争", audience: "男女通吃", category: "古风与幻想", markets: ["west"] },
  { value: "犯罪惊悚", label: "犯罪惊悚", desc: "高压节奏、连环危机与反转追凶", audience: "男女通吃", category: "悬疑与罪案", markets: ["west"] },
  { value: "法律博弈", label: "法律博弈", desc: "法庭攻防、证据反转与正义困境", audience: "男女通吃", category: "悬疑与罪案", markets: ["west"] },
  { value: "政治惊悚", label: "政治惊悚", desc: "权力斗争、舆论操控与制度危机", audience: "男女通吃", category: "悬疑与罪案", markets: ["west"] },
  { value: "公路冒险", label: "公路冒险", desc: "旅途结构中的人物关系与自我救赎", audience: "全龄", category: "情感与生活", markets: ["west"] },
  { value: "黑色幽默", label: "黑色幽默", desc: "荒诞处境中的讽刺喜剧表达", audience: "全龄", category: "情感与生活", markets: ["west"] },
  { value: "家庭喜剧", label: "家庭喜剧", desc: "家庭关系冲突中的温情与幽默节奏", audience: "全龄", category: "情感与生活", markets: ["west"] },
  { value: "蒸汽朋克", label: "蒸汽朋克", desc: "维多利亚美学、机械奇观与阶级反抗", audience: "男女通吃", category: "科幻与未来", markets: ["west"] },
  { value: "西部拓荒", label: "西部拓荒", desc: "边疆秩序、赏金与正义的灰色地带", audience: "男频", category: "都市与热血", markets: ["west"] },
  { value: "惬意推理", label: "惬意推理", desc: "小镇日常、温和推理与社群关系", audience: "全龄", category: "悬疑与罪案", markets: ["west"] },
  { value: "军事战争", label: "军事战争", desc: "战场部署、兄弟情谊与家国命题", audience: "男频", category: "都市与热血", markets: ["west", "cn"] },
  { value: "冷战谍影", label: "冷战谍影", desc: "情报战、双面身份与意识形态对峙", audience: "男频", category: "悬疑与罪案", markets: ["west"] },
  { value: "浪漫喜剧", label: "浪漫喜剧", desc: "误会迭起、欢喜冤家式的高糖节奏", audience: "女频", category: "情感与生活", markets: ["west", "kr"] },
  { value: "平行宇宙", label: "平行宇宙", desc: "分支世界、身份置换与因果连锁", audience: "男女通吃", category: "科幻与未来", markets: ["west", "jp"] },
  { value: "移民叙事", label: "移民叙事", desc: "跨文化身份、离散与第二代归属", audience: "全龄", category: "情感与生活", markets: ["west", "sea"] },
  { value: "灾难求生", label: "灾难求生", desc: "突发灾难中的逃生、互助与人性考验", audience: "男女通吃", category: "悬疑与罪案", markets: ["west", "kr", "jp"] },
  { value: "黑暗奇幻", label: "黑暗奇幻", desc: "道德灰度、残酷世界与宿命对抗", audience: "男频", category: "古风与幻想", markets: ["west"] },
  { value: "数值化冒险", label: "数值化冒险", desc: "等级面板、副本规则与成长数值博弈", audience: "男频", category: "科幻与未来", markets: ["west", "jp"] },

  // 韩国市场
  { value: "韩式复仇", label: "韩式复仇", desc: "身份落差、精密复仇与情感反噬", audience: "男女通吃", category: "情感与生活", markets: ["kr"] },
  { value: "财阀博弈", label: "财阀博弈", desc: "财阀家族权力斗争与阶层对抗", audience: "男女通吃", category: "情感与生活", markets: ["kr"] },
  { value: "命运爱情", label: "命运爱情", desc: "命运错位与高强度情感拉扯", audience: "女频", category: "情感与生活", markets: ["kr"] },
  { value: "医疗群像", label: "医疗群像", desc: "医院多角色叙事中的职业与情感抉择", audience: "全龄", category: "情感与生活", markets: ["kr"] },
  { value: "检察法政", label: "检察法政", desc: "权力系统内的法政博弈与反腐追查", audience: "男女通吃", category: "悬疑与罪案", markets: ["kr"] },
  { value: "悬爱反转", label: "悬爱反转", desc: "恋爱线与悬疑线交织的连续反转结构", audience: "女频", category: "情感与生活", markets: ["kr"] },
  { value: "职场现实", label: "职场现实", desc: "职场压迫、成长蜕变与关系修复", audience: "男女通吃", category: "情感与生活", markets: ["kr", "jp", "cn"] },
  { value: "邻里温情", label: "邻里温情", desc: "社区关系中的日常治愈与群像成长", audience: "全龄", category: "情感与生活", markets: ["kr"] },
  { value: "校园救赎", label: "校园救赎", desc: "校园暴力与创伤后的修复与和解", audience: "全龄", category: "情感与生活", markets: ["kr"] },
  { value: "检察追凶", label: "检察追凶", desc: "检察体系内连环案件与体制黑幕", audience: "男女通吃", category: "悬疑与罪案", markets: ["kr"] },
  { value: "财阀继承", label: "财阀继承", desc: "继承权争夺、家族信托与权力让渡", audience: "男女通吃", category: "情感与生活", markets: ["kr"] },
  { value: "韩剧轻喜", label: "韩剧轻喜", desc: "强设定误会与高密度喜剧节奏", audience: "女频", category: "情感与生活", markets: ["kr"] },
  { value: "特工谍战", label: "特工谍战", desc: "跨国行动、身份伪装与任务伦理", audience: "男频", category: "悬疑与罪案", markets: ["kr"] },

  // 东南亚市场
  { value: "家族恩怨", label: "家族恩怨", desc: "家族关系、代际冲突与利益对抗", audience: "全龄", category: "情感与生活", markets: ["sea"] },
  { value: "乡土逆袭", label: "乡土逆袭", desc: "基层环境中个人崛起与身份跃迁", audience: "男女通吃", category: "都市与热血", markets: ["sea"] },
  { value: "婚姻伦理", label: "婚姻伦理", desc: "婚姻关系中的忠诚考验与价值冲突", audience: "全龄", category: "情感与生活", markets: ["sea"] },
  { value: "跨代亲情", label: "跨代亲情", desc: "长辈与子女观念碰撞下的情感修复", audience: "全龄", category: "情感与生活", markets: ["sea"] },
  { value: "宗教民俗", label: "宗教民俗", desc: "地方信仰与民俗禁忌驱动的冲突故事", audience: "男女通吃", category: "情感与生活", markets: ["sea"] },
  { value: "都市轻喜", label: "都市轻喜", desc: "都市节奏下的恋爱与喜剧冲突", audience: "全龄", category: "情感与生活", markets: ["sea", "cn"] },
  { value: "青春竞技", label: "青春竞技", desc: "青春成长与赛事挑战并行推进", audience: "男女通吃", category: "都市与热血", markets: ["sea", "cn", "west"] },
  { value: "创业逆风", label: "创业逆风", desc: "小人物创业中的资源博弈与情义选择", audience: "男女通吃", category: "都市与热血", markets: ["sea"] },
  { value: "音乐舞台", label: "音乐舞台", desc: "音乐梦想、舞台竞争与团队关系成长", audience: "男女通吃", category: "都市与热血", markets: ["sea", "kr"] },
  { value: "海港秘事", label: "海港秘事", desc: "港口城市、走私链与跨国势力纠缠", audience: "男女通吃", category: "悬疑与罪案", markets: ["sea"] },
  { value: "离散族群", label: "离散族群", desc: "移民二代、族群认同与文化冲突", audience: "全龄", category: "情感与生活", markets: ["sea"] },
  { value: "雨林探险", label: "雨林探险", desc: "热带探险、生态危机与生存挑战", audience: "男频", category: "都市与热血", markets: ["sea"] },
  { value: "热带悬疑", label: "热带悬疑", desc: "湿热气候下的连环谜案与本土传说", audience: "男女通吃", category: "悬疑与罪案", markets: ["sea"] },
  { value: "群岛物语", label: "群岛物语", desc: "岛屿社群、海洋生计与世代传承", audience: "全龄", category: "情感与生活", markets: ["sea"] },
] as const;

export const AUDIENCES = [
  { value: "女频", label: "女频", desc: "更强调情感拉扯、关系推进和人物心绪起伏。" },
  { value: "男频", label: "男频", desc: "更强调目标升级、反击爽感和外部冲突推进。" },
  { value: "全龄", label: "全龄", desc: "尽量兼顾更宽的人群接受度和普适情绪共鸣。" },
] as const;

export const TONES = [
  { value: "甜", label: "甜", desc: "主打高糖关系、轻盈节奏和正向情绪回报。" },
  { value: "虐", label: "虐", desc: "主打压抑拉扯、情绪撕裂和强烈代入感。" },
  { value: "甜虐", label: "甜虐", desc: "在高糖和高虐之间切换，利于情绪起伏和追更。" },
  { value: "爽", label: "爽", desc: "强调打脸、逆袭和连续兑现的爽点节奏。" },
  { value: "燃", label: "燃", desc: "强调目标、信念和高动能推进的热血感。" },
  { value: "搞笑", label: "搞笑", desc: "强调反差笑点、轻快表达和可传播桥段。" },
] as const;

export const ENDINGS = [
  { value: "HE", label: "HE（好结局）", desc: "以关系修复、目标达成或命运和解来收口。" },
  { value: "BE", label: "BE（坏结局）", desc: "以失去、错过或代价兑现强化情绪冲击。" },
  { value: "OE", label: "OE（开放结局）", desc: "保留余味和讨论空间，让结尾继续发酵。" },
] as const;

export const TARGET_MARKETS = [
  {
    value: "cn",
    label: "国内（中文）",
    desc: "中文创作，符合国内短剧平台的节奏与审美",
  },
  {
    value: "jp",
    label: "日本（日文）",
    desc: "日文创作，物哀·幽玄·寂的审美，内向细腻的情感描绘",
  },
  {
    value: "west",
    label: "欧美（英文）",
    desc: "英文创作，好莱坞高概念风格，强悬疑爽感与直接的情节推动",
  },
  {
    value: "kr",
    label: "韩国（韩文）",
    desc: "韩文创作，韩剧式情感节奏，细腻人物关系与命运反转",
  },
  {
    value: "sea",
    label: "东南亚（英文）",
    desc: "英文创作，融合家庭伦理与社会阶层冲突，浓烈情感表达",
  },
] as const;

export const EPISODE_COUNTS = [
  { value: 40, label: "40集（紧凑）" },
  { value: 60, label: "60集（标准）" },
  { value: 80, label: "80集（长线）" },
  { value: 100, label: "100集（超长）" },
  { value: -1, label: "自定义" },
] as const;

export type DramaMode = "traditional" | "adaptation";

export type DramaStep =
  | "setup" | "creative-plan" | "characters"
  | "reference-script" | "structure-transform" | "character-transform"
  | "directory" | "outlines" | "episodes" | "compliance" | "export";

export const DRAMA_STEP_LABELS: Record<DramaStep, string> = {
  setup: "选题立项",
  "creative-plan": "创作方案",
  characters: "角色开发",
  "reference-script": "参考剧本",
  "structure-transform": "结构转换",
  "character-transform": "角色转换",
  directory: "分集目录",
  outlines: "单集细纲",
  episodes: "分集撰写",
  compliance: "合规审核",
  export: "导出",
};

export const DRAMA_STEPS: DramaStep[] = [
  "setup",
  "creative-plan",
  "characters",
  "directory",
  "outlines",
  "episodes",
  "compliance",
  "export",
];

export const ADAPTATION_STEPS: DramaStep[] = [
  "reference-script",
  "structure-transform",
  "character-transform",
  "directory",
  "outlines",
  "episodes",
  "compliance",
  "export",
];

export const FRAMEWORK_STYLES = [
  { value: "东方玄幻", label: "东方玄幻", desc: "仙侠修真、灵气法术、飞升渡劫", category: "古代风格", markets: ["cn"] },
  { value: "古装宫廷", label: "古装宫廷", desc: "深宫权谋、后妃争斗、皇权博弈", category: "古代风格", markets: ["cn"] },
  { value: "武侠江湖", label: "武侠江湖", desc: "江湖恩怨、武林争霸、侠骨柔情", category: "古代风格", markets: ["cn"] },
  { value: "古风言情", label: "古风言情", desc: "古代背景、浪漫爱情、情深缘浅", category: "古代风格", markets: ["cn"] },
  { value: "历史演义", label: "历史演义", desc: "王朝更迭、英雄辈出、历史风云", category: "古代风格", markets: ["cn"] },
  { value: "西方奇幻", label: "西方奇幻", desc: "魔法世界、骑士冒险、龙与精灵", category: "幻想风格", markets: ["west", "cn"] },
  { value: "科幻未来", label: "科幻未来", desc: "星际探索、AI时代、赛博朋克", category: "幻想风格", markets: ["west", "cn", "jp"] },
  { value: "末日废土", label: "末日废土", desc: "末世求生、废土冒险、人性考验", category: "幻想风格", markets: ["west", "cn"] },
  { value: "灵异恐怖", label: "灵异恐怖", desc: "鬼怪传说、惊悚悬疑、心理恐怖", category: "幻想风格", markets: ["cn", "jp", "west"] },
  { value: "穿越时空", label: "穿越时空", desc: "时空穿梭、古今交错、命运改变", category: "幻想风格", markets: ["cn", "jp", "west", "kr"] },
  { value: "现代都市", label: "现代都市", desc: "都市职场、商战情感、现代生活", category: "现代风格", markets: ["cn", "kr", "sea"] },
  { value: "校园青春", label: "校园青春", desc: "校园恋爱、青春成长、友情热血", category: "现代风格", markets: ["cn", "jp", "kr", "west"] },
  { value: "都市情感", label: "都市情感", desc: "婚恋家庭、情感纠葛、现实题材", category: "现代风格", markets: ["cn", "kr", "sea"] },
  { value: "职场商战", label: "职场商战", desc: "职场风云、商场博弈、逆袭成长", category: "现代风格", markets: ["cn", "kr", "west"] },
  { value: "悬疑推理", label: "悬疑推理", desc: "烧脑破案、逻辑推理、真相大白", category: "现代风格", markets: ["cn", "jp", "west", "kr"] },
  { value: "民国谍战", label: "民国谍战", desc: "乱世风云、谍影重重、家国情怀", category: "特殊风格", markets: ["cn"] },
  { value: "军旅战争", label: "军旅战争", desc: "铁血军魂、战场烽火、热血报国", category: "特殊风格", markets: ["cn", "west"] },
  { value: "游戏竞技", label: "游戏竞技", desc: "电竞网游、虚拟世界、巅峰对决", category: "特殊风格", markets: ["cn", "jp", "west"] },
  { value: "体育竞技", label: "体育竞技", desc: "运动赛场、挥洒汗水、超越自我", category: "特殊风格", markets: ["cn", "jp", "west", "kr"] },
  { value: "乡村乡土", label: "乡村乡土", desc: "田园生活、乡土风情、邻里故事", category: "特殊风格", markets: ["cn", "jp", "sea"] },
  // 日本市场专属风格
  { value: "物哀治愈", label: "物哀治愈", desc: "细腻日常中的情绪修复与温柔成长", category: "日式风格", markets: ["jp"] },
  { value: "职人匠心", label: "职人匠心", desc: "围绕职业精神与细节打磨的成长线", category: "日式风格", markets: ["jp"] },
  { value: "异世界冒险", label: "异世界冒险", desc: "穿越异世界后的任务成长与伙伴协作", category: "日式风格", markets: ["jp", "west", "cn"] },
  { value: "妖怪奇谈", label: "妖怪奇谈", desc: "民俗怪谈与温情治愈结合的奇谈线", category: "日式风格", markets: ["jp"] },
  { value: "王道热血", label: "王道热血", desc: "友情羁绊、成长试炼与正义宣言", category: "日式风格", markets: ["jp", "cn", "west"] },
  // 欧美市场专属风格
  { value: "超级英雄", label: "超级英雄", desc: "能力觉醒、责任命题与团队对抗", category: "欧美风格", markets: ["west"] },
  { value: "太空歌剧", label: "太空歌剧", desc: "星际文明冲突与史诗级阵营对抗", category: "欧美风格", markets: ["west"] },
  { value: "奇幻史诗", label: "奇幻史诗", desc: "宏大世界观下的王权与命运战争", category: "欧美风格", markets: ["west"] },
  { value: "犯罪惊悚", label: "犯罪惊悚", desc: "高压节奏、连环危机与反转追凶", category: "欧美风格", markets: ["west"] },
  { value: "黑色幽默", label: "黑色幽默", desc: "荒诞处境中的讽刺喜剧表达", category: "欧美风格", markets: ["west"] },
  { value: "浪漫喜剧", label: "浪漫喜剧", desc: "误会迭起、欢喜冤家式的高糖节奏", category: "欧美风格", markets: ["west", "kr"] },
  { value: "蒸汽朋克", label: "蒸汽朋克", desc: "维多利亚美学、机械奇观与阶级反抗", category: "欧美风格", markets: ["west", "cn"] },
  // 韩国市场专属风格
  { value: "韩式复仇", label: "韩式复仇", desc: "身份落差、精密复仇与情感反噬", category: "韩式风格", markets: ["kr"] },
  { value: "财阀博弈", label: "财阀博弈", desc: "财阀家族权力斗争与阶层对抗", category: "韩式风格", markets: ["kr", "cn"] },
  { value: "命运爱情", label: "命运爱情", desc: "命运错位与高强度情感拉扯", category: "韩式风格", markets: ["kr"] },
  { value: "悬爱反转", label: "悬爱反转", desc: "恋爱线与悬疑线交织的连续反转结构", category: "韩式风格", markets: ["kr"] },
  // 东南亚市场专属风格
  { value: "家族恩怨", label: "家族恩怨", desc: "家族关系、代际冲突与利益对抗", category: "东南亚风格", markets: ["sea", "cn"] },
  { value: "乡土逆袭", label: "乡土逆袭", desc: "基层环境中个人崛起与身份跃迁", category: "东南亚风格", markets: ["sea", "cn"] },
  { value: "宗教民俗", label: "宗教民俗", desc: "地方信仰与民俗禁忌驱动的冲突故事", category: "东南亚风格", markets: ["sea"] },
] as const;

export type SetupMode = "topic" | "creative";

export interface DramaSetup {
  genres: string[]; // max 2
  audience: string;
  tone: string;
  ending: string;
  totalEpisodes: number;
  targetMarket: string; // "cn" | "jp" | "west" | "kr" | "sea"
  customTopic?: string; // user's additional description
  setupMode?: SetupMode; // "topic" = genre-based, "creative" = free-form idea
  creativeInput?: string; // free-form creative idea text
}

export interface DramaCharacter {
  name: string;
  age: string;
  identity: string;
  personality: string[];
  motivation: string;
  arc: string;
  catchphrase: string;
  villainLevel?: number; // 1-4 for villain hierarchy
}

export interface EpisodeEntry {
  number: number;
  title: string;
  summary: string;
  hookType: string;
  isKey: boolean;      // 🔥
  isClimax: boolean;   // ⚡ 高潮卡点
  isPaywall: boolean;  // 💰 付费卡点
  emotionLevel?: number; // 1-5 情绪强度
  outline?: string;    // 单集细纲（约300字）
}

export interface EpisodeVersion {
  content: string;
  wordCount: number;
  timestamp: string;
  label?: string; // e.g. "场次二重写" or "整集重写"
}

export interface EpisodeScript {
  number: number;
  title: string;
  summary?: string;
  content: string;
  wordCount: number;
  history?: EpisodeVersion[]; // previous versions
}

export interface CharacterStateCard {
  id: string;
  name: string;
  role: string;
  coreConflict: string;
  desire: string;
  riskNote: string;
  relationshipAxis: string[];
  stageFocus: string;
  status: "pending" | "locked";
}

export interface StoryBeatPacket {
  id: string;
  episodeNumber: number;
  title: string;
  beatSummary: string;
  hook: string;
  payoff: string;
  sourceOutline?: string;
  status: "pending" | "drafted" | "locked";
}

export interface ComplianceRevisionPacket {
  id: string;
  issueTitle: string;
  riskLevel: "high" | "medium" | "low";
  recommendation: string;
  affectedEpisodeNumbers?: number[];
  sourceQuote?: string;
  status: "pending" | "resolved";
  workspaceRiskId?: string;
  replacement?: string;
  segmentIndex?: number;
  originalSnippet?: string;
}

export type ComplianceReviewMode = "text" | "script";
export type ComplianceStrictness = "standard" | "strict" | "extreme";
export type ComplianceRiskLevel = "red" | "high" | "info";
export type ComplianceWorkspaceModel =
  | "gemini-3.1-pro-preview"
  | "gemini-3-pro-preview"
  | "gemini-3-flash-preview";

export interface ComplianceWorkspaceTableSnapshot {
  headers: string[];
  rows: (string | number | null)[][];
  fileName: string;
  sheetName?: string;
  originalData: (string | number | null)[][];
}

export interface ComplianceWorkspaceRiskPhrase {
  id: string;
  level: ComplianceRiskLevel;
  text: string;
  reason: string;
  segmentIndex: number;
  replacement?: string;
  status: "pending" | "resolved";
  normalizedText?: string;
  sourceStart?: number;
  sourceEnd?: number;
}

export interface ComplianceWorkspaceRiskSpan {
  start: number;
  end: number;
  level: ComplianceRiskLevel;
}

export interface ComplianceWorkspaceSegment {
  index: number;
  content: string;
  report: string;
  status: "pending" | "processing" | "done" | "failed";
  reviewedAt?: string | null;
  riskCount?: number;
}

export interface ComplianceWorkspaceProgress {
  current: number;
  total: number;
  completed: number;
  failed: number;
  status: "idle" | "processing" | "done" | "failed";
  updatedAt?: string | null;
}

export interface ComplianceWorkspaceReviewMeta {
  reviewedAt: string;
  segmentCount: number;
  sourceLength: number;
  reportLength: number;
  skippedAt?: string | null;
}

export interface ComplianceWorkspaceExportMeta {
  lastExportedAt?: string | null;
  lastExportFormat?: "xlsx" | "docx" | null;
  lastExportFileName?: string | null;
}

export interface ComplianceWorkspace {
  sourceText: string;
  paletteText: string;
  reviewBaselineSourceText: string;
  reviewBaselineReviewedAt?: string | null;
  reviewMode: ComplianceReviewMode;
  strictness: ComplianceStrictness;
  model: ComplianceWorkspaceModel;
  tableSnapshot: ComplianceWorkspaceTableSnapshot | null;
  riskPhrases: ComplianceWorkspaceRiskPhrase[];
  riskSpans: ComplianceWorkspaceRiskSpan[];
  phraseReplacements: Record<string, string>;
  segments: ComplianceWorkspaceSegment[];
  progress: ComplianceWorkspaceProgress | null;
  latestReview: ComplianceWorkspaceReviewMeta | null;
  exportMeta: ComplianceWorkspaceExportMeta | null;
  history: string[];
  historyIndex: number;
  dialogueReviewEnabled: boolean;
  dialogueOverLimitLineIndexes: number[];
  lastImportedFileName?: string | null;
  lastImportedAt?: string | null;
}

export interface OutlineBatchStatus {
  index: number;
  label: string;
  startEp: number;
  endEp: number;
  status: "pending" | "processing" | "done" | "failed";
  error?: string;
}

export interface EpisodeGenerationStatus {
  episodeNumber: number;
  title: string;
  status: "pending" | "processing" | "done" | "failed";
  error?: string;
}

export interface EpisodeQualityReviewScore {
  score: number;
  comment: string;
}

export interface EpisodeQualityReviewIssue {
  level: string;
  description: string;
}

export interface EpisodeQualityReviewResult {
  scores: {
    rhythm: EpisodeQualityReviewScore;
    satisfaction: EpisodeQualityReviewScore;
    dialogue: EpisodeQualityReviewScore;
    format: EpisodeQualityReviewScore;
    continuity: EpisodeQualityReviewScore;
  };
  total: number;
  grade: string;
  highlights: string[];
  issues: EpisodeQualityReviewIssue[];
  suggestions: string[];
}

export interface EpisodeQualityReviewPacket {
  id: string;
  episodeNumber: number;
  title: string;
  reviewedAt: string;
  rewriteInstruction: string;
  result: EpisodeQualityReviewResult;
}

export type EpisodeQualityReviewBatchMode = "default-count" | "custom-count" | "episodes";

export interface EpisodeQualityReviewBatch {
  mode: EpisodeQualityReviewBatchMode;
  episodeNumbers: number[];
  reviewedAt: string;
  requestedCount?: number | null;
}

export interface ExportPatchPlanAction {
  label: string;
  value: string;
}

export interface ExportPatchPlanEntry {
  id: string;
  kind:
    | "missing-outline"
    | "missing-episode"
    | "episode-review"
    | "compliance"
    | "export-refresh";
  title: string;
  priority: "high" | "medium" | "low";
  summary: string;
  episodeNumbers?: number[];
  action?: ExportPatchPlanAction;
}

export interface ExportPatchPlan {
  generatedAt: string;
  signature: string;
  readyForExport: boolean;
  summary: string;
  counts: {
    high: number;
    medium: number;
    low: number;
  };
  recommendedAction?: ExportPatchPlanAction;
  entries: ExportPatchPlanEntry[];
}

export interface DramaProjectArtifactPreferences {
  relationshipDiagramCollapsed?: boolean;
  diagramMode?: "simple" | "detailed";
}

export function createEmptyComplianceWorkspace(): ComplianceWorkspace {
  return {
    sourceText: "",
    paletteText: "",
    reviewBaselineSourceText: "",
    reviewBaselineReviewedAt: null,
    reviewMode: "text",
    strictness: "standard",
    model: "gemini-3.1-pro-preview",
    tableSnapshot: null,
    riskPhrases: [],
    riskSpans: [],
    phraseReplacements: {},
    segments: [],
    progress: null,
    latestReview: null,
    exportMeta: null,
    history: [],
    historyIndex: -1,
    dialogueReviewEnabled: false,
    dialogueOverLimitLineIndexes: [],
    lastImportedFileName: null,
    lastImportedAt: null,
  };
}

export interface DramaProject {
  id: string;
  mode: DramaMode;
  setup: DramaSetup | null;
  creativePlan: string;
  characters: string;
  directory: EpisodeEntry[];
  directoryRaw: string;
  episodes: EpisodeScript[];
  complianceReport: string;
  currentStep: DramaStep | string;
  dramaTitle: string;
  createdAt: string;
  updatedAt: string;
  // Adaptation mode fields
  referenceScript?: string;
  referenceStructure?: string; // Extracted structure from reference script
  frameworkStyle?: string;
  structureTransform?: string;
  characterTransform?: string;
  adaptationEpisodeCountConfirmed?: boolean;
  adaptationTargetMarketConfirmed?: boolean;
  adaptationGenresConfirmed?: boolean;
  exportDocument?: string;
  styleLock?: VideoStyleLock | null;
  worldModel?: VideoWorldModel | null;
  characterStateCards?: CharacterStateCard[];
  storyBeatPackets?: StoryBeatPacket[];
  complianceRevisionPackets?: ComplianceRevisionPacket[];
  outlineBatchStatuses?: OutlineBatchStatus[];
  episodeGenerationStatuses?: EpisodeGenerationStatus[];
  preferredEpisodeDurationSeconds?: number | null;
  complianceReviewMode?: ComplianceReviewMode;
  complianceWorkspace?: ComplianceWorkspace;
  complianceSkippedAt?: string | null;
  episodeQualityReviewPackets?: EpisodeQualityReviewPacket[];
  lastEpisodeQualityReviewBatch?: EpisodeQualityReviewBatch | null;
  exportPatchPlan?: ExportPatchPlan | null;
  artifactPreferences?: DramaProjectArtifactPreferences;
}

export function createEmptyDramaProject(mode: DramaMode = "traditional"): DramaProject {
  return {
    id: generateId(),
    mode,
    setup: null,
    creativePlan: "",
    characters: "",
    directory: [],
    directoryRaw: "",
    episodes: [],
    complianceReport: "",
    currentStep: mode === "traditional" ? "setup" : "reference-script",
    dramaTitle: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    referenceScript: "",
    referenceStructure: "",
    frameworkStyle: "",
    structureTransform: "",
    characterTransform: "",
    adaptationEpisodeCountConfirmed: false,
    adaptationTargetMarketConfirmed: false,
    adaptationGenresConfirmed: false,
    exportDocument: "",
    styleLock: null,
    worldModel: null,
    characterStateCards: [],
    storyBeatPackets: [],
    complianceRevisionPackets: [],
    outlineBatchStatuses: [],
    episodeGenerationStatuses: [],
    preferredEpisodeDurationSeconds: null,
    complianceReviewMode: "text",
    complianceWorkspace: createEmptyComplianceWorkspace(),
    complianceSkippedAt: null,
    episodeQualityReviewPackets: [],
    lastEpisodeQualityReviewBatch: null,
    exportPatchPlan: null,
    artifactPreferences: {
      relationshipDiagramCollapsed: false,
    },
  };
}
