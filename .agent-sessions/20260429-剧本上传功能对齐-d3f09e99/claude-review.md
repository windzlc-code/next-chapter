# 审查报告：剧本上传功能对齐

**任务 ID**: 20260429-剧本上传功能对齐-d3f09e99  
**审查时间**: 2026-04-30  
**补丁范围**: `video-workflow-service.ts` + `video-workflow-service.spec.ts`

---

## 问题列表（按严重程度排序）

### P1 — 测试失败（已修复）

**位置**: `video-workflow-service.ts:494`  
**问题**: `ensureVideoProject` 创建新项目时，`sourceProjectId` 只从 `runtime.currentDramaProject?.id` 取值。当用户通过上传剧本（非 drama 项目）进入视频工作流时，`currentDramaProject` 为 null，导致 `sourceProjectId` 为 undefined。

虽然 `prepareVideoGenerationAction` 在后续会覆盖 `sourceProjectId`，但 `createStoredVideoProject` 被调用时传入的参数缺少 `sourceProjectId`，导致测试断言失败。

**修复**: 在 `ensureVideoProject` 中添加与 `prepareVideoGenerationAction` 一致的 fallback 逻辑：

```typescript
sourceProjectId:
  runtime.currentDramaProject?.id ||
  (runtime.currentProjectSnapshot?.projectKind !== "video"
    ? runtime.currentProjectSnapshot?.projectId
    : undefined),
```

**验证**: 修复后全部 8 个测试通过，TypeScript 编译零错误。

---

### P3 — 低风险语义不一致（不阻塞，建议后续优化）

**位置**: `resolveWorkingScript` line 195-199 vs `extractSnapshotBridgeScript` line 143-158

**问题**: 两个函数对 artifact 的选取策略不同：
- `extractSnapshotBridgeScript`: 按 export > episode > reference > plan 优先级
- `resolveWorkingScript` fallback: 取第一个有内容的 artifact（无优先级）

当前工作流中，`buildVideoBridgeInput` 会先注入正确的 script 到 input，使 `resolveWorkingScript` 在第一个条件就命中，不会走到无差别 fallback。因此实际不会触发问题。

但如果未来有 action 函数绕过 `prepareVideoGenerationAction` 直接使用 `resolveWorkingScript`，可能取到 setup/摘要类 artifact 而非正文。

**建议**: 后续可将 `resolveWorkingScript` 的 artifact fallback 也改为使用 `extractSnapshotBridgeScript` 的优先级逻辑，保持语义一致。当前不阻塞合入。

---

### P4 — 测试覆盖建议（不阻塞）

新增的两个测试覆盖了核心桥接路径，质量良好。可选的补充覆盖：
- 当 snapshot 只有 setup artifact（无 export）时，`extractSnapshotBridgeScript` 的 fallback 行为
- `buildVideoBridgeInput` 在 `currentDramaProject` 存在时的短路行为

---

## 修复内容

| 文件 | 行号 | 修改 |
|------|------|------|
| `video-workflow-service.ts` | 494 | `sourceProjectId` 添加 snapshot fallback |

## 验证结果

- vitest: 8/8 passed
- tsc --noEmit: 0 errors
- 修复已应用到 worktree: `.agent-worktrees/20260429-剧本上传功能对齐-d3f09e99`

## 结论

补丁整体设计合理，`extractSnapshotBridgeScript` + `buildVideoBridgeInput` 的分层桥接逻辑清晰。发现并修复了一个 `ensureVideoProject` 中 `sourceProjectId` 缺失 snapshot fallback 的 bug（导致测试失败）。修复后无阻塞问题，可以合入。
