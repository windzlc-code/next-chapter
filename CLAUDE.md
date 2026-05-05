# CLAUDE.md — next-chapter_0.4.3 (InFinio v0.4.3)

每次启动新会话时，自动加载以下文件以获取项目上下文：

```
@SPEC.md
```

## 项目概述

InFinio 是一站式 AI 驱动短剧创作与视频生产平台（桌面应用）。

- **技术栈**：Vite + React 18 + TypeScript + Electron + shadcn/ui
- **核心功能**：短剧创作工作流（传统/改编两种模式）、视频生成、多 AI 提供商支持
- **数据存储**：localStorage 本地优先
- **规格文档**：详见 [SPEC.md](SPEC.md)

## 开发规范

- 使用中文注释和提交信息
- 组件放在 `src/components/`，工具库放在 `src/lib/`
- 类型定义放在 `src/types/`
- 测试文件与源文件同目录，命名为 `*.spec.ts(x)`
- 新功能开发前先更新 SPEC.md 中的"待实现功能"状态

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
