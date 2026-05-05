# 视频创作模块源码分析

> 适用版本：当前仓库工作树  
> 最后核对：2026-04-11  
> 目标：把首页 Home Agent 的视频创作模块、工作流步骤、内联按键、实现逻辑、模型接口和状态结构整理成一份可直接给开发/维护人员使用的技术文档。

---

## 1. 模块总览

视频创作模块不是单一页面，而是一条从首页会话直接驱动的视频生产链路。整体分成 6 层：

1. 问题卡片层  
   `src/components/home-agent/home-agent-project-questions.ts`  
   负责根据项目当前阶段生成“你下一步要做什么”的内联选项。

2. 选择处理层  
   `src/components/home-agent/home-agent-video-choice-handlers.ts`  
   负责把内联按钮的 `value` 映射成具体 workflow action、链式 action，或弹出下一层列表。

3. 快捷执行层  
   `src/components/home-agent/use-home-agent-workflow-shortcuts.ts`  
   `src/lib/home-agent/workflow-shortcut-runner.ts`  
   负责把用户点击变成一次 workflow 调度，更新运行时、推送 assistant 总结、刷新下一张问题卡。

4. 动作注册层  
   `src/lib/home-agent/workflow-actions.ts`  
   负责把字符串 action kind 绑定到具体实现函数。

5. 视频工作流服务层  
   `src/lib/home-agent/services/video-workflow-service.ts`  
   负责视频项目创建、脚本拆解、实体提取、分镜批次、镜头包、提示词批次、出片、轮询、审阅、返工、自动推进。

6. 生产状态派生层  
   `src/lib/home-agent/video-production-memory.ts`  
   负责把角色、场景、分镜、视频结果派生成风格锁、世界模型、资产清单、镜头包、审阅队列。

一句话概括：  
“问题卡片决定展示什么按钮，choice handler 决定按钮点下去干什么，workflow service 决定真正怎么推进视频生产。”

---

## 2. 主调用链

首页一次视频内联点击的真实调用链如下：

1. `home-agent-project-questions.ts` 生成 `ComposerQuestion`
2. 用户点击某个 option
3. `home-agent-video-choice-handlers.ts` 根据 `value` 判断：
   - 直接执行 action
   - 打开二级弹层
   - 执行链式 action
   - 发送一段普通自然语言提示给 Agent
4. `use-home-agent-workflow-shortcuts.ts` 调用：
   - `runWorkflowActionShortcut()`
   - 或 `runWorkflowActionShortcutChain()`
5. `workflow-shortcut-runner.ts`：
   - 推送用户气泡
   - 执行 workflow action
   - 合并 runtime delta
   - 记录产物变更
   - 推送 assistant 总结
   - 刷新下一张建议卡
6. `workflow-actions.ts` 把 action kind 路由到 `video-workflow-service.ts`
7. `video-workflow-service.ts` 更新 `PersistedVideoProject`
8. `saveVideoProject()` 统一调用 `synchronizeVideoProductionState()` 后写回存储

关键结论：

- 内联按钮本身不直接改数据，它只触发 workflow action。
- 真正的数据写入发生在 `video-workflow-service.ts` 的 action 内。
- 单步 shortcut 不会再自动偷偷执行下一个 action；`resolveAutoWorkflowFollowupAction()` 当前固定返回 `null`。真正的多步推进只有两种：
  - 显式链式动作 `runWorkflowActionShortcutChain()`
  - `advance_video_workflow_round`

---

## 3. 视频工作流步骤规划

步骤规划函数：  
`planVideoWorkflowContinuation()`  
位置：`src/lib/home-agent/services/video-workflow-service.ts:290`

它根据当前项目状态动态给出“下一步最合理动作”。实际顺序如下：

| 顺序 | policy | actionKind | 触发条件 | 默认批次 |
|---|---|---|---|---|
| 1 | `bootstrap-analysis` | `analyze_script_for_video` | `project.scenes.length === 0` | 全量脚本 |
| 2 | `bootstrap-entities` | `extract_video_entities` | 角色或场景为空 | 全量脚本 |
| 3 | `bootstrap-storyboard` | `prepare_storyboard_batch` | `storyboardPlan` 为空 | 6 个镜头 |
| 4 | `bootstrap-shot-packets` | `compile_video_shot_packets` | `shotPackets` 为空 | 全量镜头 |
| 5 | `bootstrap-prompt-batch` | `prepare_video_prompt_batch` | `videoPromptBatch` 为空 | 4 个镜头 |
| 6 | `refresh-running` | `refresh_video_assets` | 有进行中的 `videoTaskId` | 最多 6 条 |
| 7 | `review-ready` | `review_video_assets` | 有待审或待返工项 | 最多 6 条 |
| 8 | `repair-failed` | `generate_video_assets` | 有失败镜头 | 最多 3 条 |
| 9 | `generate-next-batch` | `generate_video_assets` | 有可继续出片镜头 | 最多 3 条 |
| 10 | `bridge-summary` | `create_video_bridge_artifact` | 前面都不满足 | 汇总 |

### 3.1 连续推进一轮的停止条件

`advanceVideoWorkflowRoundAction()` 会循环执行上面的规划，默认最多跑 6 步，最大 8 步。  
停止策略定义在：

- `src/lib/home-agent/services/video-workflow-service.ts:70`
- `VIDEO_ROUND_TERMINAL_POLICIES`

命中以下 policy 就会停：

- `refresh-running`
- `review-ready`
- `repair-failed`
- `generate-next-batch`
- `bridge-summary`

这意味着“连续推进一轮”不是无限跑，而是会在这些关键拐点停下来，把下一张卡片交还给首页。

---

## 4. 阶段面板与内联按键

问题卡片生成文件：  
`src/components/home-agent/home-agent-project-questions.ts`

### 4.1 通用推进按钮

定义：

- `buildVideoAdvanceOption()` `:37`
- `buildVideoAdvanceRoundOption()` `:47`

对应按钮：

| 按钮 | value | 作用 |
|---|---|---|
| 让 Agent 自动推进下一步 | `video:advance` | 执行单步规划，调用 `advance_video_workflow` |
| 让 Agent 连续推进一轮 | `video:advance-round` | 连续推进直到终端策略，调用 `advance_video_workflow_round` |

这两个按钮几乎会被插到所有视频阶段面板里，属于“全局快捷推进”。

### 4.2 脚本桥接阶段

构建函数：`buildVideoBridgeQuestion()`  
位置：`src/components/home-agent/home-agent-project-questions.ts:214`

它根据 `snapshot.derivedStage` 决定显示哪一组桥接按钮。

#### 阶段 A：脚本拆解

条件：`derivedStage === "脚本拆解"`

按钮：

| 标签 | value | 作用 |
|---|---|---|
| 梳理脚本拆解结果 / 先完成第一轮镜头拆解 | `video:bridge:analyze` | 触发脚本拆镜 |
| 继续提取角色与场景 | `video:bridge:entities` | 从脚本抽角色/场景 |
| 补充平台和镜头偏好 | `video:bridge:platform` | 不走 workflow，直接发一条自然语言指令给 Agent |
| 让 Agent 自动推进下一步 | `video:advance` | 单步推进 |
| 让 Agent 连续推进一轮 | `video:advance-round` | 连续推进 |

#### 阶段 B：角色与场景

条件：`derivedStage === "角色与场景"`

按钮：

| 标签 | value | 作用 |
|---|---|---|
| 先整理角色和场景资产 | `video:bridge:entities` | 重新抽实体、收口设定 |
| 继续整理分镜批次 / 开始整理分镜批次 | `video:bridge:storyboard` | 生成分镜批次文本 |
| 让 Agent 自动推进下一步 | `video:advance` | 单步推进 |
| 让 Agent 连续推进一轮 | `video:advance-round` | 连续推进 |

#### 阶段 C：分镜批次

条件：`derivedStage === "分镜批次"`

按钮：

| 标签 | value | 作用 |
|---|---|---|
| 继续补齐分镜批次 / 继续生成分镜批次 | `video:bridge:storyboard` | 更新 `storyboardPlan` |
| 更新镜头指令包 / 编译镜头指令包 | `video:bridge:shots` | 生成 `shotPackets` |
| 让 Agent 自动推进下一步 | `video:advance` | 单步推进 |
| 让 Agent 连续推进一轮 | `video:advance-round` | 连续推进 |

#### 阶段 D：镜头指令包

条件：`derivedStage === "镜头指令包"`

按钮：

| 标签 | value | 作用 |
|---|---|---|
| 复核 N 个镜头指令包 / 编译镜头指令包 | `video:bridge:shots` | 重新编译 shot packets |
| 准备视频提示词批次 | `video:bridge:prompts` | 批量增强视频 prompt |
| 让 Agent 自动推进下一步 | `video:advance` | 单步推进 |
| 让 Agent 连续推进一轮 | `video:advance-round` | 连续推进 |
| 导出生产状态包 | 动态推荐动作 | 导出状态包 |
| 预览生产状态摘要 | 动态推荐动作 | 预览 bundle |
| 打开生产状态目录 | 动态推荐动作 | 打开本地目录 |

### 4.3 出片阶段

构建函数：`buildVideoGenerationQuestion()`  
位置：`src/components/home-agent/home-agent-project-questions.ts:307`

条件：存在可生成镜头 `listGeneratableVideoScenes(project)`

按钮：

| 标签 | value | 作用 |
|---|---|---|
| 先生成前 N 条镜头 / 直接生成某条镜头 | `video:generate:first` | 取前 3 条或更少，直接出片 |
| 补发 N 条失败镜头 | `video:generate:failed` | 对失败镜头强制重提 |
| 指定镜头出片 | `video:generate:list` | 打开二级列表，只打一小批 |
| 让 Agent 自动推进下一步 | `video:advance` | 单步推进 |
| 让 Agent 连续推进一轮 | `video:advance-round` | 连续推进 |
| 导出生产状态包 | 动态推荐动作 | 导出 bundle |
| 预览生产状态摘要 | 动态推荐动作 | 预览 bundle |
| 打开生产状态目录 | 动态推荐动作 | 打开目录 |

二级列表函数：`buildVideoGenerationSceneListQuestion()` `:328`

列表项 value 格式：

- `video:generate:scene:${scene.id}`

只展示前 5 条可生成镜头。

### 4.4 轮询阶段

构建函数：`buildVideoRefreshQuestion()`  
位置：`src/components/home-agent/home-agent-project-questions.ts:334`

条件：存在进行中镜头 `listRunningVideoScenes(project)`

按钮：

| 标签 | value | 作用 |
|---|---|---|
| 刷新某条 / 刷新全部进行中镜头 | `video:refresh:all` | 轮询状态 |
| 指定镜头查看结果 | `video:refresh:list` | 打开二级列表轮询单条 |
| 检查已生成的 N 条视频资产 | `video:review:generated` | 直接切去审阅动作 |
| 让 Agent 自动推进下一步 | `video:advance` | 单步推进 |
| 让 Agent 连续推进一轮 | `video:advance-round` | 连续推进 |
| 导出生产状态包 | 动态推荐动作 | 导出 bundle |
| 预览生产状态摘要 | 动态推荐动作 | 预览 bundle |
| 打开生产状态目录 | 动态推荐动作 | 打开目录 |

二级列表函数：`buildVideoRefreshSceneListQuestion()` `:354`

列表项 value 格式：

- `video:refresh:scene:${scene.id}`

### 4.5 审阅阶段

构建函数：

- `buildReviewQuestion()` `:57`
- `buildReviewListQuestion()` `:369`
- `buildReviewDecisionQuestion()` `:375`

主面板按钮：

| 标签 | value | 作用 |
|---|---|---|
| 整理待审阅项 | `review:queue` | 重新同步并构建审阅队列 |
| 通过稳定项 | `review:approve-stable` | 批量通过 `pending` 项 |
| 只重做风险项 | `review:redo-risk` | 批量退回 `redo` 项 |
| 一键清理本轮审阅 | `review:cleanup-round` | 链式执行“通过稳定项 + 退回风险项 + 强制补发风险镜头” |
| 逐条审阅 | `review:list` | 打开审阅列表 |
| 让 Agent 自动推进下一步 | `video:advance` | 单步推进 |
| 让 Agent 连续推进一轮 | `video:advance-round` | 连续推进 |
| 导出生产状态包 | 动态推荐动作 | 导出 bundle |
| 预览生产状态摘要 | 动态推荐动作 | 预览 bundle |
| 打开生产状态目录 | 动态推荐动作 | 打开目录 |

逐条列表项：

- `review:item:${reviewId}`

单条决策按钮：

| 标签 | value | 作用 |
|---|---|---|
| 通过这条素材 | `review:item-approve:${reviewId}` | 批准对应 targetIds |
| 标记这条重做 | `review:item-redo:${reviewId}` | 退回对应 targetIds |

### 4.6 修复阶段

构建函数：

- `buildVideoRepairQuestion()` `:96`
- `buildVideoRepairListQuestion()` `:125`

主面板按钮：

| 标签 | value | 作用 |
|---|---|---|
| 直接重做这条镜头 / 重做全部退回镜头 | `video:repair:all` | 链式执行退回 + 强制重生 |
| 指定镜头重做 | `video:repair:list` | 打开返工列表 |
| 先复核重做原因 | `video:repair:review` | 打开同一列表，但语义是先看原因 |
| 让 Agent 自动推进下一步 | `video:advance` | 单步推进 |
| 让 Agent 连续推进一轮 | `video:advance-round` | 连续推进 |
| 导出生产状态包 | 动态推荐动作 | 导出 bundle |
| 预览生产状态摘要 | 动态推荐动作 | 预览 bundle |
| 打开生产状态目录 | 动态推荐动作 | 打开目录 |

列表项 value：

- `video:repair:item:${reviewId}`

---

## 5. 内联按钮到实现逻辑的映射

处理文件：  
`src/components/home-agent/home-agent-video-choice-handlers.ts`

### 5.1 项目级 handler

函数：`createVideoProjectChoiceHandler()`  
位置：`src/components/home-agent/home-agent-video-choice-handlers.ts:98`

主要映射：

| value / 标签 | 执行方式 | 最终动作 |
|---|---|---|
| `video:bridge:analyze` | `runWorkflowActionShortcut` | `analyze_script_for_video` |
| `video:bridge:entities` | `runWorkflowActionShortcut` | `extract_video_entities` |
| `video:bridge:storyboard` | `runWorkflowActionShortcut` | `prepare_storyboard_batch` |
| `video:bridge:shots` | `runWorkflowActionShortcut` | `compile_video_shot_packets` |
| `video:bridge:prompts` | `runWorkflowActionShortcut` | `prepare_video_prompt_batch` |
| `video:bridge:platform` | `send()` | 发自然语言请求，让 Agent 帮用户补平台/风格/出片目标 |
| `video:advance` | `runWorkflowActionShortcut` | `advance_video_workflow` |
| `video:advance-round` | `runWorkflowActionShortcut` | `advance_video_workflow_round` |
| `开始第一轮出片` | 可能先弹列表 | `generate_video_assets` |
| `轮询当前出片结果` | 可能先弹列表 | `refresh_video_assets` |
| `整理待审阅项` | 直接执行 | `review_video_assets` |
| `检查已生成的 N 条视频资产` | 直接执行 | `review_video_assets` |
| `处理 N 条待审阅项` | 先弹审阅列表 | `review_video_assets` |
| `对需要重做的镜头发起修复` | 先弹修复列表 | 不直接执行，先进入 repair 选镜头 |
| `导出生产状态包` | 直接执行 | `export_video_production_bundle` |
| `预览生产状态摘要` | 直接执行 | `preview_video_production_bundle` |
| `打开生产状态目录` | 直接执行 | `open_video_production_bundle_directory` |

这里有一个重要区别：

- `video:*` 这种值通常是“系统内部 value”
- “开始第一轮出片”“导出生产状态包”这类中文标签，是从 `recommendedActions` 动态透传过来的推荐动作

### 5.2 审阅级 handler

函数：`createVideoReviewChoiceHandler()`  
位置：`src/components/home-agent/home-agent-video-choice-handlers.ts:217`

关键逻辑：

- `review:approve-stable`
  - 先用 `collectReviewTargetIds(snapshot, "stable")`
  - 如果没有目标，弹出审阅列表
  - 否则执行 `approve_video_assets`

- `review:redo-risk`
  - 先收集风险项 targetIds
  - 否则执行 `redo_video_assets`

- `review:cleanup-round`
  - 先整理稳定项和风险项
  - 再链式执行：
    1. `approve_video_assets`
    2. `redo_video_assets`
    3. `generate_video_assets` with `forceRegenerate: true`

- `review:item:*`
  - 先弹出单条决策弹层

- `review:item-approve:*`
  - 单条通过

- `review:item-redo:*`
  - 单条退回

### 5.3 资产级 handler

函数：`createVideoAssetChoiceHandler()`  
位置：`src/components/home-agent/home-agent-video-choice-handlers.ts:364`

关键逻辑：

- `video:generate:first`
  - 取可生成镜头的前 3 条
  - 调用 `generate_video_assets`

- `video:generate:failed`
  - 取全部失败镜头
  - 用 `forceRegenerate: true` 重提

- `video:generate:list`
  - 打开“指定镜头出片”二级弹层

- `video:generate:scene:${sceneId}`
  - 只提交该镜头

- `video:refresh:all`
  - 刷新全部在跑镜头

- `video:refresh:list`
  - 打开“指定镜头查看结果”二级弹层

- `video:refresh:scene:${sceneId}`
  - 只刷新指定镜头

- `video:review:generated`
  - 直接进入 `review_video_assets`

- `video:repair:all`
  - 链式执行：
    1. `redo_video_assets`
    2. `generate_video_assets` with `forceRegenerate: true`

- `video:repair:list` / `video:repair:review`
  - 打开返工列表

- `video:repair:item:${reviewId}`
  - 对对应 review item 执行退回 + 强制重生链

---

## 6. 具体 workflow action 实现

文件：`src/lib/home-agent/services/video-workflow-service.ts`

### 6.1 接管视频上下文

函数：`prepareVideoGenerationAction()`  
位置：`:782`

作用：

- 确保当前有 `PersistedVideoProject`
- 从 runtime / input / 剧本项目里回填标题、脚本、来源项目
- 把项目接到首页 Home Agent 运行时

这是所有视频 action 的前置准备动作。

### 6.2 脚本拆镜

函数：`analyzeScriptForVideoAction()`  
位置：`:807`

调用：

- `invokeFunction("script-decompose", { script, videoPace, segmentsPerEpisode, systemPrompt, model })`

结果：

- 生成 `Scene[]`
- 写入 `project.scenes`
- 生成 `analysisSummary`

参数特点：

- `videoPace` 默认 `medium`
- `segmentsPerEpisode` 默认 `5`
- `systemPrompt` 可传
- `model` 可传

### 6.3 角色与场景提取

函数：`extractVideoEntitiesAction()`  
位置：`:852`

调用：

- `invokeFunction("extract-characters-scenes", { script, model })`

结果：

- 生成 `CharacterSetting[]`
- 生成 `SceneSetting[]`
- 更新 `currentStep = 2`

### 6.4 分镜批次

函数：`prepareStoryboardBatchAction()`  
位置：`:894`

实现特点：

- 默认取 `sceneStart ~ sceneEnd`
- 若未传，默认从首镜头起取 6 条
- 只生成文字版 `storyboardPlan`
- 不直接生成分镜图

换句话说，它是“分镜批次说明文本”而不是图片生产。

### 6.5 镜头指令包

函数：`compileVideoShotPacketsAction()`  
位置：`:936`

实现特点：

- 先 `synchronizeVideoProductionState(project)`
- 再 `deriveVideoShotPackets()`
- 再 `deriveVideoReviewQueue()`

这里是把场景、角色、场景设定、已有素材折叠成可复用的 shot packet。

### 6.6 视频提示词批次

函数：`prepareVideoPromptBatchAction()`  
位置：`:977`

实现特点：

- 默认批次 4 条镜头
- 对每条镜头调用 `enhance-video-prompt`
- 更新 `scene.recommendedDuration`
- 汇总成 `videoPromptBatch`

这里不是提交出片，只是把“适合视频模型吃的 prompt 批次”整理出来。

### 6.7 出片提交

函数：`generateVideoAssetsAction()`  
位置：`:1050`

核心流程：

1. `resolveGenerationScenes()` 决定本轮要打哪些镜头
2. `ensureVideoGenerationTransport()` 决定走哪个 provider
3. 并发 2 路执行每个镜头：
   - `buildSceneVideoPrompt()`
   - `findSceneReferenceImage()`
   - `invokeFunction("generate-video", {...})`
4. 回写每条 scene：
   - `videoTaskId`
   - `videoProvider`
   - `videoStatus`
   - `videoFailure`
   - `recommendedDuration`

默认参数：

- `aspectRatio = "16:9"`
- `resolution = "720p"`
- 并发数 `2`

`resolveGenerationScenes()` 的规则：

- 若传 `targetIds`，按目标精确匹配
- 若传 `sceneStart / sceneEnd`，按区间取
- 否则默认取可生成镜头前 3 条
- `forceRegenerate = true` 时允许跳过“已有视频 URL”的限制
- `batchSize` 最大 8，默认 3

### 6.8 轮询出片状态

函数：`refreshVideoAssetsAction()`  
位置：`:1149`

核心流程：

1. 选出有 `videoTaskId` 的目标镜头
2. 并发 4 路调用  
   `invokeFunction("generate-video", { action: "status", taskId, provider })`
3. 按结果更新：
   - 完成：写 `videoUrl`，状态改 `completed`
   - 失败：写 `videoFailure`
   - 其他：状态保留为 `queued/processing`

默认并发数：`4`

### 6.9 审阅、通过、退回

函数：

- `reviewVideoAssetsAction()` `:1275`
- `approveVideoAssetsAction()` `:1305`
- `redoVideoAssetsAction()` `:1345`

实现特点：

- `reviewVideoAssetsAction()`
  - 先 `synchronizeVideoProductionState()`
  - 再 `deriveVideoReviewQueue()`
  - 只负责整理待审项，不做判决

- `approveVideoAssetsAction()`
  - 把匹配到的 review item 标成 `approved`
  - 同步把对应 `shotPackets[].reviewStatus` 标成 `approved`

- `redoVideoAssetsAction()`
  - 把匹配到的 review item 标成 `redo`
  - 记录 `reason`
  - 同步把 `shotPackets[].reviewStatus` 标成 `redo`

### 6.10 自动推进

函数：

- `advanceVideoWorkflowAction()` `:1482`
- `advanceVideoWorkflowRoundAction()` `:1521`

区别：

- `advance_video_workflow`
  - 只跑一步规划

- `advance_video_workflow_round`
  - 循环“规划 -> 执行”
  - 默认最多 6 步
  - 命中终端 policy 后停止

### 6.11 桥接摘要

函数：`createVideoBridgeArtifactAction()`

作用：

- 生成一个轻量汇总字符串
- 包含项目名、脚本长度、镜头数、角色数、场景数、阶段等
- 用于首页会话的桥接/恢复说明

---

## 7. 生产状态派生逻辑

文件：`src/lib/home-agent/video-production-memory.ts`

### 7.1 `deriveVideoStyleLock()`

位置：`:65`

用途：

- 从标题、脚本、产出目标、备注中推断题材
- 生成 tone / visualStyle / colorMood / cinematography / forbidden
- 作为后续镜头连续性约束的静态锁

### 7.2 `deriveVideoAssetManifest()`

位置：`:103`

会把以下内容折叠成统一资产表：

- 角色主参考图
- 角色三视图
- 服装图
- 场景主参考图
- 时间变体图
- 分镜图
- 视频片段

资产类型：

- `character-reference`
- `costume-reference`
- `scene-reference`
- `time-variant`
- `storyboard-frame`
- `video-segment`

### 7.3 `deriveVideoShotPackets()`

位置：`:254`

一个 `VideoShotPacket` 会整合：

- scene 基本信息
- duration
- 镜头语言
- 角色引用与必须保留项
- 背景引用
- sourceAssetIds
- promptSeed
- forbiddenChanges
- `renderMode`

`renderMode` 判定规则：

- 有 storyboard / 背景图 / 角色资产时：`img2video`
- 否则：`text2video`

### 7.4 `deriveVideoWorldModel()`

位置：`:330`

用途：

- 生成项目级世界模型
- 整理 continuity rules
- 把角色和场景变成结构化世界知识

### 7.5 `deriveVideoReviewQueue()`

位置：`:375`

实现特点：

- 基于 `shotPackets` 派生 review item
- 每个 item 的 `targetIds` 会收拢 packet 和相关资产
- scene 失败时默认状态为 `redo`
- 当前只取前 `12` 个 packets 进入审阅队列

这个“最多 12 条”的限制是维护时需要特别注意的行为。

### 7.6 `synchronizeVideoProductionState()`

位置：`:406`

统一补齐：

- `assetManifest`
- `styleLock`
- `worldModel`
- `reviewQueue`

所有最终写盘前都会走这一步。

---

## 8. 模型接口与 provider 路由

### 8.1 workflow service 调用的 AI 函数

这些函数最终都走 `invokeFunction()`：

| 函数名 | 用途 | 主要输入 | 主要输出 |
|---|---|---|---|
| `script-decompose` | 脚本拆镜 | `script`, `videoPace`, `segmentsPerEpisode`, `systemPrompt`, `model` | `scenes[]` |
| `extract-characters-scenes` | 抽角色与场景 | `script`, `model` | `characters[]`, `sceneSettings[]` |
| `enhance-video-prompt` | 增强视频 prompt | `description`, `characters`, `cameraDirection`, `sceneName`, `dialogue`, `style`, `characterDescriptions`, `sceneDescription` | `enhanced`, `duration`, `durationReason` |
| `generate-video` | 提交视频生成任务 | `prompt`, `imageUrl`, `duration`, `aspectRatio`, `resolution`, `provider` | `task_id`, `status`, `provider` |
| `generate-video` + `action: "status"` | 查询任务状态 | `taskId`, `provider` | `status`, `video_url`, `state` |

路由位置：

- `src/lib/invoke-with-key.ts:430`
- `src/lib/invoke-with-key.ts:451`

### 8.2 文本模型和视频 provider 是两套系统

首页文本模型选择定义在：

- `src/lib/home-agent/text-models.ts`

但视频工作流里：

- `script-decompose` 和 `extract-characters-scenes` 可以显式传 `model`
- 内联按钮本身没有 UI 暴露模型切换
- `generate_video_assets` 不吃首页 `selectedTextModelKey`
- 视频出片走的是另一套 `provider + key + endpoint + CLI` 机制

所以维护时不要把“首页当前文本模型”误认为“当前视频出片模型”。

### 8.3 出片通道选择逻辑

函数：`ensureVideoGenerationTransport()`  
位置：`src/lib/home-agent/services/video-workflow-service.ts:660`

选择顺序：

1. Dreamina CLI
   - 条件：
     - `input.provider === "dreamina-cli"`
     - 或未显式指定 provider 且 `prefersJimengCli(getApiConfig()) === true`
   - 还会校验：
     - `window.electronAPI?.dreaminaCli?.exec` 存在
     - `dreaminaCliGetStatus().loggedIn === true`
   - 返回：
     - `mode: "cli"`
     - `provider: "dreamina-cli"`
     - `providerLabel: "Dreamina CLI / Seedance 2.0"`

2. Tuzi / Sora 2
   - 条件：
     - `input.provider === "tuzi"`
     - 且 `config.tuziKey` 存在
   - 返回：
     - `mode: "api"`
     - `provider: "tuzi"`

3. Seedance API
   - 默认 fallback
   - 要求：
     - `jimengKey` 或 `geminiKey` 至少一个存在
   - 返回：
     - `mode: "api"`
     - `provider: undefined | provider`

### 8.4 `generate-video` 的底层 provider 逻辑

实现函数：`localGenerateVideo()`  
位置：`src/lib/invoke-with-key.ts:2154`

#### 状态查询

- `provider === "tuzi"`
  - 调 Tuzi `/doubao/api/v3/contents/generations/tasks/${taskId}`
- `provider === "dreamina-cli"` 或 CLI 偏好命中
  - 调 `dreaminaCliQueryResult(taskId)`
- 否则
  - 调 Seedance `/videos/${taskId}`

#### 创建任务

1. Sora 2 / Tuzi
   - 条件：`model` 以 `sora-2` 开头，或 `provider === "tuzi"`
   - 分辨率映射：
     - `720p -> sora-2`
     - 其他默认 `1080p -> sora-2-pro`
   - 时长限制：
     - `4 ~ 12` 秒
   - 比例支持：
     - `16:9`, `9:16`, `1:1`, `4:3`, `3:4`

2. Dreamina CLI
   - 条件：偏好 CLI 且不是 Sora 2
   - 调 `dreaminaCliGenerateVideo()`
   - 主要输入：
     - `prompt`
     - `imageUrl`
     - `duration`
     - `aspectRatio`

3. Seedance API
   - 条件：API 模式下非 Tuzi
   - 模型映射：
     - `720p -> doubao-seedance-1-5-pro_720p`
     - `1080p -> doubao-seedance-1-5-pro_1080p`
   - 时长限制：
     - `4 ~ 15` 秒
   - 如果有首帧图：
     - 会下载/转 data URI
     - 按设置压缩
     - 再转 multipart 上传

### 8.5 模型映射表

模型配置定义在：

- `src/lib/api-config.ts:59`
- `src/lib/api-config.ts:152`
- `config/builtin-api.json`

当前视频相关映射包括：

| key | provider | category | 说明 |
|---|---|---|---|
| `doubao-seedance-1-5-pro_720p` | `jimeng` | `video` | Seedance 1.5 Pro 720P |
| `doubao-seedance-1-5-pro_1080p` | `jimeng` | `video` | Seedance 1.5 Pro 1080P |
| `seedance2.0` | `jimeng` | `video` | Seedance 2.0，主要给 Dreamina CLI |
| `seedance2.0fast` | `jimeng` | `video` | Seedance 2.0 Fast |
| `sora-2` | `tuzi` | `video` | Sora 2 720p |
| `sora-2-pro` | `tuzi` | `video` | Sora 2 Pro 1080p |

`resolveConfiguredModelName()` 会把逻辑 key 映射成最终实际模型名：

- `src/lib/api-config.ts:547`

---

## 9. 重要数据结构

类型定义文件：`src/types/project.ts`

### 9.1 `Scene`

位置：`:1`

视频链路关键字段：

- `storyboardUrl`
- `panoramaUrl`
- `videoUrl`
- `videoTaskId`
- `videoProvider`
- `videoStatus`
- `videoFailure`
- `videoHistory`
- `recommendedDuration`
- `sceneTimeVariantId`

### 9.2 `VideoFailureInfo`

位置：`:26`

字段：

- `message`
- `provider`
- `stage: "submit" | "status"`
- `updatedAt`

### 9.3 `VideoHistoryEntry`

位置：`:33`

用于在镜头反复重做时保留旧视频历史。

### 9.4 `ProductionAssetManifest`

位置：`:121`

是视频生产状态的统一资产索引。

### 9.5 `VideoStyleLock`

位置：`:127`

是项目级的风格约束：

- `genre`
- `tone`
- `visualStyle`
- `colorMood`
- `cinematography`
- `forbidden`
- `referencePromptTemplate`

### 9.6 `VideoWorldModel`

位置：`:155`

是项目级世界知识：

- synopsis
- continuityRules
- characters
- scenes

### 9.7 `VideoShotPacket`

位置：`:177`

是最核心的镜头执行单元：

- `sceneId`
- `durationSec`
- `camera`
- `characterRefs`
- `backgroundRef`
- `sourceAssetIds`
- `promptSeed`
- `forbiddenChanges`
- `renderMode`
- `reviewStatus`

### 9.8 `VideoReviewItem`

位置：`:196`

是首页审阅卡片的最小单位：

- `targetIds` 不是单纯 sceneId
- 它可能同时包含：
  - packet id
  - scene 相关资产 id
  - review 自身 id

这也是为什么一些 action 能通过 packet/review/asset id 反向命中 scene。

---

## 10. 生产状态包

相关文件：

- `src/components/home-agent/home-agent-project-questions.ts:487`
- `src/lib/home-agent/workflow-actions.ts`
- `src/lib/home-agent/production-state-export.ts`

### 10.1 首页里的三个相关动作

| 动作 | 作用 |
|---|---|
| 导出生产状态包 | 把当前视频项目导出到本地目录 |
| 预览生产状态摘要 | 在首页先预览将导出哪些信息 |
| 打开生产状态目录 | 直接打开导出目录 |

### 10.2 实际导出内容

`exportVideoProductionBundle()` 会输出：

- `overview.json`
- `style-lock.json`
- `world-model.json`
- `asset-manifest.json`
- `shot-packets.json`
- `review-queue.json`
- `README.md`

导出目录格式：

- `home-agent/production-state/<safe-title>-<project-id>`

---

## 11. 维护时必须知道的几个实现细节

1. 视频按钮不是直接绑死在页面 JSX 里的，而是先由 `ComposerQuestion` 动态生成，再由 choice handler 解释。

2. `video:bridge:platform` 是特例。  
   它不是 workflow action，而是 `send()` 一段自然语言，让 Agent 帮用户补平台、镜头风格、出片目标和偏好。

3. `advance_video_workflow_round` 是当前视频模块里真正的“自动多步推进器”。  
   普通 shortcut 本身不会自动连跑后续 action。

4. `generate_video_assets` 的默认行为是“小批次验证”，不是全量狂发。  
   默认 3 条，提交并发 2。

5. `refresh_video_assets` 默认也是分批轮询。  
   进行中镜头在 planner 里一次最多刷 6 条，实际 status 请求并发 4。

6. 审阅队列不是无限长。  
   `deriveVideoReviewQueue()` 当前只取前 12 个 packets。

7. 首页文本模型和视频 provider 完全不是一套配置。  
   拆镜/实体提取属于文本函数，出片属于视频 provider。

8. 当前 inline 按钮没有把 `provider / aspectRatio / resolution / model` 全量暴露给用户。  
   除非通过更高层 action input 或手工指令注入，否则会吃默认值。

9. `sceneTargetMatches()` 支持多种 targetId 形态反查 scene：
   - `scene.id`
   - `packet:${projectId}:${scene.id}`
   - `review:packet:${projectId}:${scene.id}`
   - `shot:${scene.id}:video`
   - `shot:${scene.id}:storyboard`

10. 每次保存项目前都会重新同步视频生产状态。  
    所以看起来只改了 scenes，实际上也可能连带重算 manifest / world model / review queue。

---

## 12. 源码定位速查

| 主题 | 文件 | 入口 |
|---|---|---|
| 工作流规划 | `src/lib/home-agent/services/video-workflow-service.ts` | `planVideoWorkflowContinuation()` |
| 单步推进 | `src/lib/home-agent/services/video-workflow-service.ts` | `advanceVideoWorkflowAction()` |
| 连续推进一轮 | `src/lib/home-agent/services/video-workflow-service.ts` | `advanceVideoWorkflowRoundAction()` |
| 出片提交 | `src/lib/home-agent/services/video-workflow-service.ts` | `generateVideoAssetsAction()` |
| 轮询状态 | `src/lib/home-agent/services/video-workflow-service.ts` | `refreshVideoAssetsAction()` |
| 审阅整理 | `src/lib/home-agent/services/video-workflow-service.ts` | `reviewVideoAssetsAction()` |
| 审阅通过 | `src/lib/home-agent/services/video-workflow-service.ts` | `approveVideoAssetsAction()` |
| 审阅退回 | `src/lib/home-agent/services/video-workflow-service.ts` | `redoVideoAssetsAction()` |
| 桥接卡片 | `src/components/home-agent/home-agent-project-questions.ts` | `buildVideoBridgeQuestion()` |
| 出片卡片 | `src/components/home-agent/home-agent-project-questions.ts` | `buildVideoGenerationQuestion()` |
| 轮询卡片 | `src/components/home-agent/home-agent-project-questions.ts` | `buildVideoRefreshQuestion()` |
| 审阅卡片 | `src/components/home-agent/home-agent-project-questions.ts` | `buildReviewQuestion()` |
| 修复卡片 | `src/components/home-agent/home-agent-project-questions.ts` | `buildVideoRepairQuestion()` |
| 项目级按钮处理 | `src/components/home-agent/home-agent-video-choice-handlers.ts` | `createVideoProjectChoiceHandler()` |
| 审阅级按钮处理 | `src/components/home-agent/home-agent-video-choice-handlers.ts` | `createVideoReviewChoiceHandler()` |
| 资产级按钮处理 | `src/components/home-agent/home-agent-video-choice-handlers.ts` | `createVideoAssetChoiceHandler()` |
| 快捷执行 | `src/components/home-agent/use-home-agent-workflow-shortcuts.ts` | `runWorkflowActionShortcut()` |
| shortcut 执行器 | `src/lib/home-agent/workflow-shortcut-runner.ts` | `runWorkflowShortcut()` |
| 动作注册 | `src/lib/home-agent/workflow-actions.ts` | `runWorkflowAction()` |
| 状态派生 | `src/lib/home-agent/video-production-memory.ts` | `synchronizeVideoProductionState()` |
| provider 路由 | `src/lib/invoke-with-key.ts` | `localGenerateVideo()` |
| API 配置 | `src/lib/api-config.ts` | `SUPPORTED_MODEL_MAPPINGS`, `resolveConfiguredModelName()` |

---

## 13. 结论

当前仓库的视频创作模块已经形成了比较完整的“首页闭环”：

- 首页动态卡片负责引导下一步
- choice handler 负责把按钮翻译成系统 action
- workflow service 负责推进视频项目状态
- production memory 负责把生产数据派生成可审阅、可导出的结构
- provider 层负责把 prompt 和首帧真正送到 Seedance / Dreamina CLI / Tuzi Sora 2

从维护角度看，最关键的不是单个按钮，而是下面三条主线：

1. 阶段判断是否正确  
   决定用户看到哪一张问题卡。

2. targetIds 是否稳定  
   决定单条审阅、单条返工、单条轮询是否能正确命中 scene。

3. provider 与模型映射是否清晰  
   决定“当前到底走哪个视频通道、吃哪个模型”。

后续如果要继续扩展视频模块，优先建议沿这三条线改：

- 增强阶段判定和卡片策略
- 细化 targetIds / packet / asset 的映射规则
- 把 provider / resolution / aspect ratio / model 进一步前移到可视配置层
