# InFinio 项目规格文档 (v0.4.3 / next-chapter_0.4.3)

> 最后更新：2026-04-07  
> 项目定位：一站式 AI 驱动短剧创作与视频生产平台（桌面应用）

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | React 18.3.1 + React Router 6.30.1 |
| 构建工具 | Vite 5.4.19 + TypeScript 5.8.3 |
| UI 组件库 | shadcn/ui + Radix UI（75+ 组件） |
| 样式 | Tailwind CSS 3.4.17 |
| 动画 | Framer Motion 12.34.0 |
| 状态管理 | TanStack React Query 5.91.3 |
| 表单 | React Hook Form 7.61.1 + Zod |
| AI SDK | @anthropic-ai/sdk 0.81.0 |
| 桌面应用 | Electron 28.0.0 + electron-builder |
| 浏览器自动化 | Playwright 1.58.2 |
| 文档处理 | docx / xlsx / exceljs / pdfjs-dist / mammoth |
| 图表 | Recharts 2.15.4 + Mermaid 11.13.0 |
| 数据持久化 | localStorage（本地优先） |

---

## 已实现功能

### 1. 短剧创作工作流

#### 1.1 传统模式（Traditional Mode）
完整步骤链：`setup → creative-plan → characters → directory → outlines → episodes → compliance → export`

#### 1.2 改编模式（Adaptation Mode）
完整步骤链：`reference-script → structure-transform → character-transform → directory → outlines → episodes → compliance → export`

#### 1.3 题材与市场
- **目标市场**：国内(cn)、日本(jp)、欧美(west)、韩国(kr)、东南亚(sea)
- **题材库**：100+ 种分类（情感、古风、都市、悬疑、科幻等）
- **创作参数**：集数(40/60/80/100/自定义)、情感基调(甜/虐/爽/燃)、结局类型(HE/BE/OE)

### 2. 视频生成与制作

- **艺术风格**：live-action / hyper-cg / 3d-cartoon / 2.5d-stylized / anime-3d / cel-animation / retro-comic / custom
- **视频模型**：seedance-1.5-pro / seedance-2.0 / seedance-2.0-fast / sora-2
- **角色管理**：角色卡、服装系统、三视图参考（front/side/back/closeUp）
- **场景管理**：场景设置、时间变体（TimeVariant）
- **故事板**：故事板规划与生成
- **视频提示批处理**：批量生成视频 Prompt
- **世界模型（World Model）**：连贯性规则、角色状态、场景描述
- **风格锁定（Style Lock）**：视觉风格一致性保障
- **镜头包（Shot Packet）**：摄影机参数、角色/背景参考
- **视频审核**：pending / approved / redo 状态流转
- **视频历史**：每个场景保留完整生成历史

### 3. 生产资产管理

- **资产类型**：character-reference / costume-reference / scene-reference / time-variant / storyboard-frame / video-segment
- **资产状态**：ready / needs-review / failed
- **生产资产清单（ProductionAssetManifest）**

### 4. AI 智能体引擎

- **对话模式**：idle / active / recovering / maintenance-review
- **项目记忆系统**：项目摘要、对话摘要、工件（Artifact）、维护报告、技能草稿
- **语义搜索与压缩**：对话内容语义压缩与摘要
- **工作流引擎**：自定义工作流动作、异步执行与结果追踪
- **MCP 协议支持**：Model Context Protocol 客户端
- **快捷方式执行器**：workflow-shortcut-runner

### 5. 工具系统（Agent Tools）

| 工具 | 功能 |
|------|------|
| bash | 执行 Shell 命令 |
| file-read / file-write / file-edit | 文件操作 |
| glob / grep | 文件搜索 |
| ask-user-question | 向用户提问 |
| send-message | 发送消息 |
| sleep | 延迟等待 |
| web-fetch | 网页获取 |
| studio-workflow | 工作室工作流 |
| task-tools (getAllTasks) | 任务管理 |

### 6. 多 AI 提供商支持

| 提供商 | 用途 |
|--------|------|
| Gemini (Google) | 文本生成、图像理解 |
| GPT (OpenAI) | 文本生成 |
| Claude (Anthropic) | 文本生成 |
| Grok (xAI) | 文本生成 |
| Seedream / Jimeng（即梦） | 视频生成 |
| Tuzi（兔子） | 图像生成 |

- 支持自定义 API 端点、API Key 管理、模型映射
- Jimeng 支持 API 和 CLI 两种执行模式

### 7. 文档导出

- Word 文档导出（.docx）
- Excel 表格导出（.xlsx）
- 技能草稿导出（skill-draft-export）
- 生产状态导出（production-state-export）
- PDF 阅读与处理
- Markdown 渲染与导出

### 8. UI 与交互

- 深色/浅色主题切换（next-themes）
- 响应式设计（桌面 + 移动端）
- 可折叠侧边栏 + 移动端 Sheet
- Toast 通知系统（Sonner）
- 多种对话框类型（Alert / Confirm / Modal / Drawer）
- 数据可视化（Recharts）
- 图表绘制（Mermaid）
- 可调整面板（React Resizable Panels）

### 9. 桌面应用（Electron）

- Electron 28 打包为独立桌面应用
- 图标同步脚本
- 开发/生产双模式启动

### 10. 测试覆盖

- 测试框架：Vitest 3.2.4 + Testing Library
- 20+ 个 `.spec.ts` / `.spec.tsx` 测试文件
- 覆盖：项目存储、会话管理、对话记忆、工作流动作、查询引擎等

---

## 待实现 / 待完善功能

| 优先级 | 功能 | 说明 |
|--------|------|------|
| 中 | 聊天记录导入/导出与媒体回填 | 本轮实现：支持当前活动项目直接导出、结构化导入/导出错误提示、导入去重，并可定位最近一次导出的聊天记录文件 |
| 高 | 更多视频模型集成 | 扩展支持更多视频生成服务 |
| 高 | 合规审查完善 | complianceReport 字段已有，功能需深化 |
| 中 | 离线模式 | 当前完全依赖外部 API，无离线降级 |
| 中 | 多语言 UI | 代码中大量中文硬编码，需 i18n 支持 |
| 中 | 性能优化 | invoke-with-key.ts (104KB) 需代码分割 |
| 低 | 实时协作 | 多人同时编辑项目 |
| 低 | 高级分析统计 | 创作数据统计与可视化 |
| 低 | 插件系统 | 第三方工具/模型插件扩展 |

---

## 核心数据模型

### DramaProject（短剧项目）
```typescript
interface DramaProject {
  id: string;
  mode: "traditional" | "adaptation";
  setup: DramaSetup | null;
  creativePlan: string;
  characters: string;
  directory: EpisodeEntry[];
  episodes: EpisodeScript[];
  complianceReport: string;
  currentStep: DramaStep;
  dramaTitle: string;
  // 改编模式
  referenceScript?: string;
  structureTransform?: string;
  characterTransform?: string;
  // 视频生产
  styleLock?: VideoStyleLock | null;
  worldModel?: VideoWorldModel | null;
  characterStateCards?: CharacterStateCard[];
  storyBeatPackets?: StoryBeatPacket[];
  complianceRevisionPackets?: ComplianceRevisionPacket[];
}
```

### Scene（场景）
```typescript
interface Scene {
  id: string;
  sceneNumber: number;
  sceneName: string;
  description: string;
  characters: string[];
  dialogue: string;
  videoUrl?: string;
  videoStatus?: "queued" | "processing" | "completed" | "failed";
  videoHistory?: VideoHistoryEntry[];
}
```

### ConversationArtifact（对话工件）
```typescript
interface ConversationArtifact {
  id: string;
  kind: ArtifactKind; // setup, plan, characters, episode, compliance 等
  label: string;
  summary: string;
  content?: string;
  updatedAt: string;
}
```

---

## 本地存储键

| 键名 | 内容 |
|------|------|
| `storyforge_drama_projects` | 短剧项目列表 |
| `storyforge-skill-drafts-v1` | 技能草稿 |
| `storyforge-maintenance-reports-v1` | 维护报告 |
| `storyforge-home-agent-project-meta-v1` | 项目元数据 |

---

## 页面路由

| 路由 | 页面 | 功能 |
|------|------|------|
| `/` | Home | 主工作室（HomeAgentStudio） |
| `/settings` | Settings | API 配置、主题、Dreamina CLI 登录 |
| `*` | NotFound | 404 页面 |

---

## 与 v0.2.6 的主要差异

| 方面 | v0.2.6 | v0.4.3 |
|------|--------|--------|
| UI 组件数量 | 40+ | 75+ |
| 测试文件 | 40 个 | 20+ 个（重构后） |
| 工具系统 | 基础工具 | 新增 sleep、task-tools |
| 导出功能 | 基础导出 | 新增 skill-draft / production-state 导出 |
| 工作流 | 基础工作流 | 新增 shortcut-runner |
| 视频服务 | 基础视频服务 | 独立 video-workflow-service |
