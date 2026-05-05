# InFinio 工作流链路文档

> 描述 InFinio 从用户点击到面板弹出、Artifact 生成与展示的完整链路。
> 最后更新：2026-04-10

---

## 一、核心数据结构

### ConversationArtifact
```ts
// src/lib/home-agent/types.ts
interface ConversationArtifact {
  id: string;           // 唯一标识，如 "setup:proj-xxx"
  kind: ArtifactKind;   // "setup" | "characters" | "directory" | "outline" | "episode" | ...
  label: string;        // 展示标题，如 "项目设定"
  summary: string;      // 精简摘要（收纳态展示）
  content?: string;     // 纯文本内容（展开态）
  updatedAt: string;    // ISO 时间戳，用于 diff 检测
  presentation?: "plain" | "script-rich";
  payload?: ScriptArtifactPayload;  // 结构化富文本数据
  actions?: ConversationArtifactAction[];
}
```

### ConversationProjectSnapshot
```ts
// src/lib/home-agent/types.ts
interface ConversationProjectSnapshot {
  projectId: string;
  projectKind: "script" | "adaptation" | "video";
  derivedStage: string;          // 中文阶段名，如 "角色开发"、"分集目录"
  artifacts: ConversationArtifact[];
  recommendedActions: string[];
  // ...其他字段
}
```

### HomeAgentMessage（含 artifactIds）
```ts
interface HomeAgentMessage {
  id: string;
  role: "assistant" | "user" | "system";
  content: string;
  createdAt: string;
  artifactIds?: string[];  // 该条消息生成/更新的 artifact ID 列表
}
```

---

## 二、面板弹出机制

### 2.1 `suggested` vs `popoverOverride`

| 状态 | 优先级 | 触发方式 | 使用场景 |
|------|--------|---------|---------|
| `popoverOverride` | 高（强制弹窗） | 工作流完成后由 `applyNextSuggestion` 设置 | 需要立即用户交互的后续步骤 |
| `suggested` | 低（建议卡片） | 由 suggestion effect 根据 snapshot 派生 | 可选的、非阻塞的推荐动作 |

`useHomeAgentQuestionView` 的优先级链：`qState → popoverOverride → suggested`

### 2.2 三个 Ref 的职责

```
// src/components/home-agent/HomeAgentStudio.tsx L295-297
const surfacedProjectSuggestionKeysRef = useRef<Set<string>>(new Set());
const temporarilySuppressedProjectSuggestionKeysRef = useRef<Set<string>>(new Set());
const restoredProjectSuggestionKeysRef = useRef<Set<string>>(new Set());
```

| Ref | 职责 | 生命周期 | 写入时机 |
|-----|------|--------|---------|
| `surfacedProjectSuggestionKeysRef` | 记录已弹出过的建议（用户主动关闭后不再显示） | 会话级别，持久化到 localStorage | suggestion effect 首次显示建议时；用户点击关闭时 |
| `temporarilySuppressedProjectSuggestionKeysRef` | 工作流执行期间临时压制当前建议 | 单次工作流执行周期，streaming 结束后清空 | `clearChoiceUi()` 调用时（工作流开始前） |
| `restoredProjectSuggestionKeysRef` | 标记从 localStorage 恢复的建议 | 会话恢复时初始化，使用后删除 | 会话恢复时与 `surfacedProjectSuggestionKeysRef` 同步初始化 |

### 2.3 Suggestion Effect 的决策逻辑

```ts
// src/components/home-agent/use-home-agent-conversation-effects.ts L272-344
useEffect(() => {
  if (qState || streaming || popoverOverride || draftPresence) return;
  if (!runtime.currentProjectSnapshot) {
    // 无项目时：保留 auto-research 建议，清除其他
    setSuggested((prev) => prev?.id?.startsWith("auto-research:") ? prev : null);
    return;
  }

  const nextSuggestion = recQuestion(snapshot, runtime.currentVideoProject);
  const autoFollowup = resolveAutoWorkflowFollowupAction(snapshot, nextSuggestion);
  // lock_character_cards 不自动执行，不压制建议
  const autoFollowupKey = autoFollowup && autoFollowup.action !== "lock_character_cards" && snapshot
    ? `${sessionId}:${projectId}:${updatedAt}:${autoFollowup.action}`
    : null;

  setSuggested((previous) => {
    // 1. 已恢复的建议：清除恢复标记，返回 null（避免重复弹出）
    if (restoredProjectSuggestionKeysRef.current.has(suggestionKey)) {
      restoredProjectSuggestionKeysRef.current.delete(suggestionKey);
      return previous?.id ? null : previous;
    }
    // 2. 有待自动执行的后续且未尝试过：等待自动执行，暂不显示建议
    if (autoFollowupKey && !attemptedAutoWorkflowKeysRef.current.has(autoFollowupKey)) {
      return null;
    }
    // 3. 工作流执行期间临时压制
    if (temporarilySuppressedProjectSuggestionKeysRef.current.has(suggestionKey) && !previous) {
      return null;
    }
    // 4. 已弹出过且用户已关闭（previous is null）：不再显示
    if (surfacedProjectSuggestionKeysRef.current.has(suggestionKey) && !previous) {
      return null;
    }
    // 5. 记录并显示新建议
    surfacedProjectSuggestionKeysRef.current.add(suggestionKey);
    return nextSuggestion;
  });
}, [/* 不含 suggested，避免循环触发 */]);
```

### 2.4 Streaming 结束后面板重新弹出

```ts
// src/components/home-agent/use-home-agent-conversation-effects.ts L346-353
useEffect(() => {
  const wasStreaming = previousStreamingRef.current;
  previousStreamingRef.current = streaming;
  if (!wasStreaming || streaming) return;
  // 只清空临时压制（工作流执行期间的），不清空用户主动关闭的记录
  temporarilySuppressedProjectSuggestionKeysRef.current.clear();
}, [streaming, temporarilySuppressedProjectSuggestionKeysRef]);
```

---

## 三、工作流快捷方式执行链路

### 3.1 触发入口

```
用户点击选项
  → useHomeAgentChoiceHandlers (scriptProjectChoiceHandler)
  → useHomeAgentWorkflowShortcuts
      runWorkflowActionShortcut(action, input, userBubble)
      runWorkflowActionShortcutChain(steps[], userBubble)
  → workflow-shortcut-runner.ts
      runWorkflowShortcut / runWorkflowShortcutChain
  → workflow-actions.ts → runWorkflowAction
  → drama-workflow-service.ts / video-workflow-service.ts
```

### 3.2 `runWorkflowActionShortcut` 核心流程

```ts
// src/components/home-agent/use-home-agent-workflow-shortcuts.ts L83-140
const runWorkflowActionShortcut = (action, input, userBubble) => {
  // 防重入：已有工作流在执行时拒绝新请求
  if (workflowShortcutInFlightRef.current) {
    push("assistant", "当前已有步骤在执行，请等待当前流程完成后再继续。");
    return;
  }
  workflowShortcutInFlightRef.current = true;

  clearChoiceUi();          // 记录当前建议到 temporarilySuppressed，清除 popover/suggested
  activateConversation();   // 切换到 active 模式
  setActiveWorkflowAction(action);
  setStreaming(true);

  void (async () => {
    try {
      const workflow = await loadWorkflowActionsModule();
      const ui = createWorkflowShortcutUiBridge({ ... });
      await runWorkflowShortcut({ action, input, runtime, runAction, ui, userBubble });
    } finally {
      workflowShortcutInFlightRef.current = false;
      setActiveWorkflowAction(null);
      setStreaming(false);  // 触发 streaming-end effect，清空 temporarilySuppressed
    }
  })();
};
```

### 3.3 `runWorkflowShortcut` 核心逻辑

```ts
// src/lib/home-agent/workflow-shortcut-runner.ts
async function runWorkflowShortcut({ action, input, runtime, runAction, ui, userBubble }) {
  ui.pushUser(userBubble);

  // 记录执行前的 artifact 签名（用于 diff）
  const prevArtifactSignatures = new Map(
    runtime.currentProjectSnapshot?.artifacts.map(a => [a.id, createArtifactRevisionKey(a)]) ?? []
  );

  // 1. 执行主 action
  const result = await runAction(action, input, runtime);
  const nextSnapshot = result.projectSnapshot ?? result.data?.projectSnapshot ?? null;
  const changedArtifactIds = collectChangedArtifactIds(nextSnapshot, prevArtifactSignatures);

  if (result.data) ui.commitRuntime(nextRuntime, nextSnapshot?.projectId);
  if (result.summary.trim()) ui.pushAssistant(result.summary.trim(), changedArtifactIds);

  // 2. 检查是否需要自动后续（如 lock_character_cards）
  const nextSuggestion = recQuestion(nextSnapshot, nextRuntime.currentVideoProject);
  const autoFollowup = resolveAutoWorkflowFollowupAction(nextSnapshot, nextSuggestion);

  if (!autoFollowup) {
    applyNextSuggestion(action, nextSuggestion, ui);  // 决定用 popover 还是 suggested
    return;
  }

  // 3. 执行自动后续
  const autoResult = await runAction(autoFollowup.action, autoFollowup.input, currentRuntime);
  const autoChangedIds = collectChangedArtifactIds(autoSnapshot, prevArtifactSignatures);
  if (autoResult.data) ui.commitRuntime(autoRuntime, autoSnapshot?.projectId);
  if (autoResult.summary.trim()) ui.pushAssistant(autoResult.summary.trim(), autoChangedIds);

  applyNextSuggestion(autoFollowup.action, autoSuggestion, ui);
}
```

### 3.4 `applyNextSuggestion` 决策

```ts
// src/lib/home-agent/workflow-shortcut-runner.ts L173-185
function applyNextSuggestion(action, nextSuggestion, ui) {
  if (shouldAutoOpenFollowupPopover(action, nextSuggestion)) {
    ui.setPopoverQuestion(nextSuggestion);  // 强制弹窗
    ui.setSuggested(null);
  } else {
    ui.setSuggested(nextSuggestion);        // 建议卡片
  }
}
```

**`shouldAutoOpenFollowupPopover` 返回 true 的 action 列表**：
`generate_creative_plan`, `generate_directory`, `generate_episode`, `generate_episode_batch`, `generate_characters`, `generate_character_transform`, `generate_structure_transform`, `generate_outlines`, `enter_drama_step`, `review_episode_quality`, `rewrite_episode_from_review`, `update_compliance_workspace`, `run_compliance_review`, `skip_compliance_review`, `set_episode_duration_preference`, `advance_video_workflow_round`, `analyze_reference_script`

**例外**：即使 action 在上述列表中，如果 `nextSuggestion` 是角色工作流问题（`answerKey` 为 `script-characters` 等），也不自动弹窗。

---

## 四、自动工作流（Auto Followup）

### 4.1 `resolveAutoWorkflowFollowupAction`

```ts
// src/lib/home-agent/workflow-shortcut-runner.ts L118-135
export function resolveAutoWorkflowFollowupAction(snapshot, nextSuggestion) {
  if (
    snapshot &&
    (snapshot.projectKind === "script" || snapshot.projectKind === "adaptation") &&
    nextSuggestion &&
    isCharacterWorkflowQuestion(nextSuggestion)
  ) {
    return { action: "lock_character_cards", input: { projectId: snapshot.projectId } };
  }
  return null;
}
```

目前只有一种自动后续：当下一个建议是角色工作流问题时，自动触发 `lock_character_cards`。

### 4.2 `lock_character_cards` 的特殊处理

- **在 `runWorkflowShortcut` 中**：会被自动执行（作为 generate_characters 的后续步骤）
- **在 suggestion effect 中**：被排除在 `autoFollowupKey` 计算之外，不压制建议显示
- **在 auto followup effect 中**：`if (autoFollowup.action === "lock_character_cards") return;` 不自动触发

原因：`lock_character_cards` 只在用户主动点击"进入角色开发"后的工作流链中执行，不在后台静默触发。

### 4.3 `attemptedAutoWorkflowKeysRef`

```ts
// src/components/home-agent/use-home-agent-conversation-effects.ts L156
const attemptedAutoWorkflowKeysRef = useRef<Set<string>>(new Set());
```

Key 格式：`${sessionId}:${projectId}:${updatedAt}:${action}`

作用：防止同一自动工作流被重复执行。suggestion effect 检查此 ref 来决定是否压制建议（等待自动执行）；auto followup effect 在执行前将 key 加入此 ref。

---

## 五、项目阶段推进链路

### 5.1 `derivedStage` 派生

```
DramaProject.currentStep（英文）
  → project-store.ts: deriveDramaStage()
  → ConversationProjectSnapshot.derivedStage（中文）

映射：
  "setup"              → "立项设定"
  "creative-plan"      → "创意方案"
  "characters"         → "角色开发"
  "character-transform"→ "角色转换"
  "structure-transform"→ "结构转换"
  "directory"          → "分集目录"
  "outlines"           → "单集细纲"
  "episodes"           → "分集撰写"
  "compliance"         → "合规审核"
  "export"             → "导出与出片"
```

### 5.2 `resolveScriptWorkflowStageV2` 反向映射

```ts
// src/components/home-agent/home-agent-project-questions.ts L484-513
// 中文 derivedStage → 英文 stage key（用于 buildScriptPacketQuestion 分支）
"角色" / "人物"     → "characters"
"目录"             → "directory"
"细纲" / "大纲"    → "outlines"
"撰写" / "正文"    → "episodes"
"合规"             → "compliance"
"导出"             → "export"
"创意" / "方案"    → "creative-plan"
"立项" / "设定"    → "setup"
```

### 5.3 `enter_drama_step` 推进 currentStep

```ts
// src/lib/home-agent/services/drama-workflow-service.ts
async function enterDramaStepAction(input, runtime) {
  const nextProject = {
    ...project,
    currentStep: input.step,  // 直接推进
    // 进入 outlines 时初始化批次状态
    outlineBatchStatuses: input.step === "outlines"
      ? (project.outlineBatchStatuses?.length
          ? project.outlineBatchStatuses
          : buildOutlineBatchStatuses(project.directory))
      : project.outlineBatchStatuses,
  };
  return saveDramaProject(nextProject);
}
```

执行后 `currentStep` 变为 `"outlines"`，`derivedStage` 变为 `"单集细纲"`，`resolveScriptWorkflowStageV2` 返回 `"outlines"`，`buildScriptPacketQuestion` 进入 `buildOutlinesWorkflowQuestion` 分支。

### 5.4 `buildOutlinePayload` 生成时机

```ts
// src/lib/home-agent/project-store.ts L695
function buildOutlinePayload(project: DramaProject): ScriptArtifactPayload | undefined {
  if (!project.directory.length) return undefined;
  if (project.currentStep === "directory") return undefined;  // 目录阶段不生成
  // currentStep 为 "outlines" 或更后的步骤才生成 outlines+batchProgress artifact
  return { type: "outlines+batchProgress", ... };
}
```

**关键**：只有 `enter_drama_step` 将 `currentStep` 从 `"directory"` 推进到 `"outlines"` 后，`buildOutlinePayload` 才会生成 artifact，`buildOutlinesWorkflowQuestion` 才能找到该 artifact 并构建批次生成面板。

---

## 六、Artifact 生成链路

### 6.1 WorkflowActionResult

```ts
interface WorkflowActionResult {
  summary: string;
  projectSnapshot?: ConversationProjectSnapshot;
  data?: WorkflowRuntimeDelta;  // 包含 projectSnapshot 的 delta
}
```

### 6.2 changedArtifactIds Diff 逻辑

```ts
// src/lib/home-agent/workflow-shortcut-runner.ts
// 执行前：记录所有 artifact 的内容签名
const prevArtifactSignatures = new Map(
  runtime.currentProjectSnapshot?.artifacts.map(a => [a.id, createArtifactRevisionKey(a)]) ?? []
);

// 执行后：找出新增或内容变化的 artifact
function collectChangedArtifactIds(nextSnapshot, prevSignatures) {
  return nextSnapshot?.artifacts
    .filter(a => {
      const prevKey = prevSignatures.get(a.id);
      return prevKey === undefined || prevKey !== createArtifactRevisionKey(a);
    })
    .map(a => a.id) ?? [];
}
```

`createArtifactRevisionKey` 对 artifact 的 id/kind/label/summary/content/payload/actions 做 JSON 序列化，任何字段变化都会触发 diff。

### 6.3 `runWorkflowShortcutChain` 跨步骤累积

```ts
// src/lib/home-agent/workflow-shortcut-runner.ts
async function runWorkflowShortcutChain({ steps, runtime, runAction, ui, userBubble }) {
  const prevArtifactSignatures = new Map(...);  // 链开始前记录一次
  let currentRuntime = runtime;

  for (const step of steps) {
    const result = await runAction(step.action, step.input, currentRuntime);
    const changedIds = collectChangedArtifactIds(nextSnapshot, prevArtifactSignatures);
    // 每步都更新 prevArtifactSignatures，避免重复计入
    if (result.data) {
      ui.commitRuntime(nextRuntime, nextSnapshot?.projectId);
      currentRuntime = nextRuntime;
    }
    if (result.summary.trim()) {
      ui.pushAssistant(result.summary.trim(), changedIds);
    }
  }
  applyNextSuggestion(steps.at(-1)?.action, finalSuggestion, ui);
}
```

---

## 七、Artifact 展示链路

### 7.1 组件树数据流

```
HomeAgentStudio
  ├── messages: HomeAgentMessage[]        (含 artifactIds)
  ├── currentProject: ConversationProjectSnapshot  (含 artifacts[])
  │
  └── ActiveConversationShell
        └── ConversationTimeline
              │
              ├── artifactMap = new Map(snapshot.artifacts.map(a => [a.id, a]))
              │
              └── 每条 assistant 消息（有 artifactIds）：
                    filteredSnapshot = { ...snapshot, artifacts: [匹配的 artifacts] }
                    → <ScriptArtifactPanel snapshot={filteredSnapshot} />
```

### 7.2 ScriptArtifactPanel 折叠逻辑

- 默认全部收纳（`expandedIds = new Set()`）
- 收纳态：label + summary + 时间戳 + ChevronDown
- 展开态：完整 payload 内容（setup 指标、角色卡、分集目录、细纲批次进度等）

---

## 八、Artifact 类型与对应步骤

| kind | label | 生成步骤 | payload 类型 |
|------|-------|---------|-------------|
| `setup` | 项目设定 | 选题立项 / save_setup | `SetupPayload` |
| `characters` / `characters+mermaid` | 角色设定 | 角色开发 | `CharactersMermaidPayload` |
| `directory` / `directory+stats` | 分集目录 | 分集目录生成 | `DirectoryStatsPayload` |
| `outlines+batchProgress` | 单集细纲 | enter_drama_step → outlines | `OutlinesBatchProgressPayload` |
| `episode` | 分集正文 | 分集撰写 | — |
| `episode-review` | 质检报告 | 集数质检 | `EpisodeReviewPayload` |
| `compliance` | 合规审核 | 合规审核 | `ComplianceSummaryPayload` |
| `export` | 导出总结 | 导出 | `ExportSummaryPayload` |
| `reference` / `plan` | 创意方案 | generate_creative_plan | — |
| `report` | 生产状态包 | 视频工作流导出 | — |

---

## 九、维护面板（Maintenance）

### 9.1 触发条件

```ts
// src/components/home-agent/home-agent-project-questions.ts L1359
export function buildMaintenanceReviewQuestion(
  runtime: Pick<StudioRuntimeState, "skillDrafts" | "maintenanceReports">,
): ComposerQuestion | null {
  const pendingDrafts = listPendingSkillDrafts(runtime.skillDrafts);
  const approvedDrafts = listApprovedSkillDrafts(runtime.skillDrafts);
  const latestReport = runtime.maintenanceReports[0] ?? null;
  if (!pendingDrafts.length && !approvedDrafts.length && !latestReport) return null;
  // 返回 answerKey: "maintenance-review" 的面板
}
```

显示条件：`skillDrafts` 中有 pending/approved 草案，或 `maintenanceReports` 非空。

### 9.2 维护面板选项

| 选项 | value | 显示条件 |
|------|-------|---------|
| 查看最近维护结论 | `maintenance:report:latest` | `latestReport` 存在 |
| 查看 N 份待审核技能草案 | `maintenance:skills` | `pendingDrafts.length > 0` |
| 查看已批准草案 | `maintenance:skills:approved` | `approvedDrafts.length > 0` |
| 导出已批准草案 | `maintenance:skills:export-approved` | `approvedDrafts.length > 0` |
| 执行一次维护检查 | `maintenance:run` | 始终显示 |

---

## 十、Runtime 状态更新路径

```
runWorkflowAction 返回 WorkflowActionResult
  → result.data.projectSnapshot（新快照，含更新后的 artifacts[]）
  → mergeRuntimeWithWorkflowDelta(runtime, result.data)
      → nextRuntime.currentProjectSnapshot = newSnapshot
      → nextRuntime.recentProjects = upsertRecentProject(...)
      → nextRuntime.skillDrafts = delta.skillDrafts ?? previous.skillDrafts
      → nextRuntime.maintenanceReports = delta.maintenanceReports ?? previous.maintenanceReports
  → ui.commitRuntime(nextRuntime)
      → setRuntime(nextRuntime)          [HomeAgentStudio state]
      → setActiveProjectId(projectId)
  → currentProject（派生自 runtime.currentProjectSnapshot）更新
  → ConversationTimeline artifactMap 重建
  → streaming 结束 → temporarilySuppressedProjectSuggestionKeysRef.clear()
  → suggestion effect 重新运行 → setSuggested(nextSuggestion)
```

---

## 十一、持久化

```ts
// StudioSessionState（localStorage）
{
  messages: HomeAgentMessage[],                    // 含 artifactIds
  currentProjectSnapshot: ConversationProjectSnapshot,  // 含 artifacts[]
  surfacedProjectSuggestionKeys: string[],         // 已弹出过的建议 key
  surfacedTaskIds: string[],
  surfacedTaskFollowupKeys: string[],
}
```

恢复时：
- `surfacedProjectSuggestionKeysRef` 和 `restoredProjectSuggestionKeysRef` 同步初始化为 `new Set(surfacedProjectSuggestionKeys)`
- `restoredProjectSuggestionKeysRef` 中的 key 在 suggestion effect 首次命中时被删除，防止重复弹出
