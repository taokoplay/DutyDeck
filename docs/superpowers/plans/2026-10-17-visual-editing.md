# 影像剪辑成片 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 DutyDeck 影像创作工作台中加入按集剪辑时间线、Agent 候选修改和真实导出任务的可验证首版。

**Architecture:** 剪辑文档独立于 `VisualProductionDocument` 持久化，每集一条时间线，片段引用镜头已采用媒体的固定 hash/版本。共享包定义时间线类型、校验和 IPC 联合；主进程负责原子存储、版本冲突和导出任务；renderer 负责播放器、轨道和候选预览；Agent 只提交结构化候选，由宿主校验后采用。

**Tech Stack:** Bun、TypeScript、React、Jotai、Radix/shadcn primitives、Electron IPC、现有 `safe-file.ts` 原子写入与影像媒体读取服务。

---

### Task 1: 建立共享时间线领域合同

**Files:**
- Create: `packages/shared/src/types/visual-editing.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/types/visual-production-validation.ts`
- Test: `packages/shared/src/types/visual-editing.test.ts`

- [ ] **Step 1: 写失败测试，覆盖合法时间线与主要边界**

```ts
it('Given 按分镜建立的连续片段 When 解析时间线 Then 保留来源版本和轨道顺序', () => {
  const result = parseVisualEditingDocument(validTimeline)
  expect(result.tracks[0]?.clips.map(clip => clip.source.shotId)).toEqual(['shot-1', 'shot-2'])
})

it('Given 视频轨片段重叠 When 解析时间线 Then 拒绝越界和重叠', () => {
  expect(() => parseVisualEditingDocument({ ...validTimeline, tracks: [{ ...validTimeline.tracks[0], clips: [{ ...validClip, start: 0 }, { ...validClip, id: 'clip-2', start: 1 }] }] })).toThrow('时间线片段重叠')
})

it('Given 字幕超出时间线 When 解析时间线 Then 拒绝悬空字幕', () => {
  expect(() => parseVisualEditingDocument({ ...validTimeline, tracks: [{ ...captionTrack, clips: [{ ...captionClip, start: 10 }] }] })).toThrow('字幕时间超出时间线')
})
```

- [ ] **Step 2: 运行共享类型测试确认先红**

Run: `bun test packages/shared/src/types/visual-editing.test.ts`

Expected: FAIL，因为 `parseVisualEditingDocument` 和时间线类型尚不存在。

- [ ] **Step 3: 实现时间线类型、候选操作和严格解析器**

新增 `VisualEditingDocument`、`VisualEditingTrack`、`VisualEditingClip`、`VisualEditingTimelineCandidate`、`VisualEditingOperation`、`VisualEditingExportSettings` 和 `VisualEditingExportJob`。解析器必须验证：

```ts
export type VisualEditingTrackKind = 'video' | 'voice' | 'music' | 'caption'
export type VisualEditingOperation =
  | { type: 'moveClip'; trackId: string; clipId: string; toIndex: number }
  | { type: 'splitClip'; trackId: string; clipId: string; at: number }
  | { type: 'trimClip'; trackId: string; clipId: string; sourceIn: number; sourceOut: number }
  | { type: 'setVolume'; trackId: string; clipId: string; volume: number }
  | { type: 'setCaption'; trackId: string; clipId?: string; text: string; start: number; duration: number }
  | { type: 'removeClip'; trackId: string; clipId: string }
```

校验器拒绝额外字段、非法身份、负数时间、空片段、视频轨重叠、字幕越界、未知轨道、重复 clipId 和超过既有影像预算的集合。导出任务状态使用 `queued | preparing | rendering | completed | failed | cancelled`。

- [ ] **Step 4: 导出 shared 类型并运行测试**

在 `packages/shared/src/index.ts` 导出新类型和解析函数，运行：

```bash
bun test packages/shared/src/types/visual-editing.test.ts
bun run --filter='@dutydeck/shared' typecheck
```

Expected: 测试通过，shared 包类型检查通过。

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/visual-editing.ts packages/shared/src/types/visual-editing.test.ts packages/shared/src/types/visual-production-validation.ts packages/shared/src/index.ts
git commit -m "新增影像剪辑时间线共享合同"
```

### Task 2: 增加剪辑时间线主进程存储与 IPC

**Files:**
- Create: `apps/electron/src/main/lib/visual-production/editing-store.ts`
- Create: `apps/electron/src/main/lib/visual-production/editing-store.test.ts`
- Modify: `apps/electron/src/main/lib/visual-production/access.ts`
- Modify: `apps/electron/src/main/lib/visual-production/integration.ts`
- Modify: `apps/electron/src/main/lib/visual-production/ipc.ts`
- Modify: `packages/shared/src/types/visual-production.ts`
- Modify: `packages/shared/src/types/visual-production-validation.ts`
- Test: `apps/electron/src/main/lib/visual-production/access.test.ts`

- [ ] **Step 1: 写存储失败测试**

覆盖以下断言：

```ts
it('Given 作品有三个已采用镜头 When createRoughCut Then 只按顺序创建有媒体的片段')
it('Given expectedRevision 过期 When saveTimeline Then 保留旧文件并抛出时间线冲突')
it('Given 镜头产生新 mediaHash When loadTimeline Then 返回 needsReplacement=true')
it('Given 其他 session 的 timeline When loadTimeline Then 拒绝访问')
```

- [ ] **Step 2: 运行测试确认先红**

Run: `bun test apps/electron/src/main/lib/visual-production/editing-store.test.ts`

Expected: FAIL，因为时间线命令和存储服务尚不存在。

- [ ] **Step 3: 扩展 shared IPC 输入/输出**

在 `VisualProductionInputs`、`VisualProductionResults` 和 `VisualProductionMethod` 增加：

```ts
loadTimeline: { sessionId: string; productionId: string; episodeId: string }
createRoughCut: { sessionId: string; productionId: string; episodeId: string; baseProductionRevision: number }
saveTimeline: { sessionId: string; productionId: string; episodeId: string; expectedRevision: number; timeline: VisualEditingDocument }
proposeTimelineEdit: { sessionId: string; productionId: string; episodeId: string; expectedRevision: number; operations: VisualEditingOperation[]; summary: string }
adoptTimelineEdit: { sessionId: string; productionId: string; episodeId: string; candidateId: string; expectedRevision: number }
discardTimelineEdit: { sessionId: string; productionId: string; episodeId: string; candidateId: string }
```

读取方法加入 `loadTimeline`，其余写方法进入统一写租约。所有输入沿用 `assertVisualProductionId`、`parseVisualEditingDocument` 和现有影像项目身份校验。

- [ ] **Step 4: 实现 `VisualEditingStore`**

服务使用 `interactionDirectory(projectRoot, ['.proma', 'visual-production', 'projects', productionId, 'editing'])`，每个集数保存为独立 JSON 文件并通过 `writeJsonFileAtomicSecure` 写入。 `createRoughCut` 从当前作品读取 shots 与 media，跳过没有采用媒体的镜头；`saveTimeline` 对比文件 CAS 状态并验证所有 `shotId/mediaId/hash` 仍属于该作品；`loadTimeline` 重新检查来源 hash，给变更片段增加只读失效标记，不修改正式时间线。

- [ ] **Step 5: 把方法接入 access、integration 和 IPC**

`VisualProductionAccess.execute` 继续统一校验 `sessionId`、写权限和工作区租约。 `createProductionVisualProductionAccess` 创建 `VisualProductionService` 时同时注入 `VisualEditingStore`。 `registerVisualProductionIpc` 保持单通道解析，不新增 renderer 可选路径或文件参数。

- [ ] **Step 6: 运行主进程定向测试**

```bash
bun test apps/electron/src/main/lib/visual-production/editing-store.test.ts apps/electron/src/main/lib/visual-production/access.test.ts
bun run --filter='@dutydeck/electron' typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/types/visual-production.ts packages/shared/src/types/visual-production-validation.ts apps/electron/src/main/lib/visual-production/editing-store.ts apps/electron/src/main/lib/visual-production/editing-store.test.ts apps/electron/src/main/lib/visual-production/access.ts apps/electron/src/main/lib/visual-production/integration.ts apps/electron/src/main/lib/visual-production/ipc.ts apps/electron/src/main/lib/visual-production/access.test.ts
git commit -m "接入影像剪辑时间线存储与IPC"
```

### Task 3: 接入 preload 与剪辑工作台基础 UI

**Files:**
- Modify: `apps/electron/src/preload/visual-production-preload.ts`
- Modify: `apps/electron/src/preload/visual-production-preload.test.ts`
- Modify: `apps/electron/src/renderer/atoms/visual-production-atoms.ts`
- Create: `apps/electron/src/renderer/components/visual-production/VisualEditingWorkspace.tsx`
- Create: `apps/electron/src/renderer/components/visual-production/VisualEditingTimeline.tsx`
- Create: `apps/electron/src/renderer/components/visual-production/visual-editing.css`
- Modify: `apps/electron/src/renderer/components/visual-production/VisualProductionWorkspace.tsx`
- Modify: `apps/electron/src/renderer/components/visual-production/visual-production.css`
- Test: `apps/electron/src/renderer/components/visual-production/VisualEditingWorkspace.test.tsx`

- [ ] **Step 1: 写 preload 路由测试**

验证 `loadTimeline`、`saveTimeline` 和 `createRoughCut` 原样通过统一 `VISUAL_PRODUCTION_CHANNELS.INVOKE`，变更通知仍只接受 workspaceId/productionId。

- [ ] **Step 2: 扩展 view 状态与 preload 类型**

将 `VisualProductionView.tab` 增加 `'editing'`，preload 无新增 Electron 暴露面，只复用泛型 `visualProduction.invoke`。更新测试中的输入联合和菜单选项。

- [ ] **Step 3: 实现工作台数据加载和空态**

`VisualEditingWorkspace` 接收 `sessionId`、`productionId`、`snapshot`、`episodeId`、`active` 与 `onEpisodeChange`。挂载后调用 `loadTimeline`；没有时间线显示“按分镜创建剪辑”；创建按钮调用 `createRoughCut` 并刷新。加载、错误、冲突、空集和缺少镜头媒体均显示业务说明。

- [ ] **Step 4: 实现播放器与片段时间线**

复用 `VisualMediaView` 加载当前片段媒体；播放器显示当前集总时长、当前片段序号、播放/暂停和前后片段。 `VisualEditingTimeline` 按视频、旁白、音乐、字幕四轨显示片段，支持点击选择和横向滚动；首版拖动排序以“拖动结束后提交 moveClip”实现，不让拖动事件修改源媒体。

- [ ] **Step 5: 接入工作台页签**

在 `VisualProductionWorkspace.tsx` 增加“剪辑成片”页签和 `view.tab === 'editing'` 分支；切换页签停止当前影像分镜播放，保持项目、资产、分镜、画布、素材导出和制作配置现有行为。新样式使用已有 CSS 变量和 Radix/shadcn Button/Dialog/Select，不引入原型专用系统菜单。

- [ ] **Step 6: 运行 renderer 测试与类型检查**

```bash
bun test apps/electron/src/preload/visual-production-preload.test.ts apps/electron/src/renderer/components/visual-production/VisualEditingWorkspace.test.tsx
bun run --filter='@dutydeck/electron' typecheck
```

- [ ] **Step 7: Commit**

```bash
git add apps/electron/src/preload/visual-production-preload.ts apps/electron/src/preload/visual-production-preload.test.ts apps/electron/src/renderer/atoms/visual-production-atoms.ts apps/electron/src/renderer/components/visual-production/VisualEditingWorkspace.tsx apps/electron/src/renderer/components/visual-production/VisualEditingTimeline.tsx apps/electron/src/renderer/components/visual-production/visual-editing.css apps/electron/src/renderer/components/visual-production/VisualProductionWorkspace.tsx apps/electron/src/renderer/components/visual-production/visual-production.css apps/electron/src/renderer/components/visual-production/VisualEditingWorkspace.test.tsx
git commit -m "加入影像剪辑成片工作台"
```

### Task 4: 完成片段编辑、撤销和 Agent 候选

**Files:**
- Modify: `packages/shared/src/types/visual-editing.ts`
- Modify: `apps/electron/src/main/lib/visual-production/editing-store.ts`
- Modify: `apps/electron/src/main/lib/visual-production/agent-tools.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Create: `apps/electron/src/renderer/components/visual-production/VisualEditingInspector.tsx`
- Create: `apps/electron/src/renderer/components/visual-production/VisualEditingCandidateDialog.tsx`
- Modify: `apps/electron/src/renderer/components/visual-production/VisualEditingWorkspace.tsx`
- Test: `packages/shared/src/types/visual-editing.test.ts`
- Test: `apps/electron/src/main/lib/visual-production/editing-store.test.ts`
- Test: `apps/electron/src/main/lib/visual-production/agent-tools.test.ts`
- Test: `apps/electron/src/renderer/components/visual-production/VisualEditingWorkspace.test.tsx`

- [ ] **Step 1: 写编辑操作测试**

验证 `moveClip`、`splitClip`、`trimClip`、`setVolume`、`setCaption`、`removeClip` 的正常路径和未知片段、越界、跨轨道、锁定来源、过期 revision 边界。

- [ ] **Step 2: 实现纯函数编辑器**

在 shared 类型文件中新增 `applyVisualEditingOperations(document, operations)`，逐个复制时间线后应用操作，返回新文档和影响摘要；不修改输入对象，不接受媒体路径和任意字段。

- [ ] **Step 3: 实现 Inspector 和保存**

Inspector 使用 Dialog 呈现入点、出点、音量和字幕；保存按钮固定在 footer。保存调用 `saveTimeline` 并在冲突时保留表单草稿；撤销/重做保存前后仅操作本地 command stack，采用服务器候选后清空与旧 revision 不兼容的栈。

- [ ] **Step 4: 增加 Agent 时间线工具**

在影像 Agent 工具中增加 `visual_production_read_timeline`、`visual_production_propose_timeline_edit`、`visual_production_adopt_timeline_edit`。读取结果分页且不携带媒体二进制；候选必须绑定 productionId/episodeId/timelineRevision；宿主校验源 hash，Agent 不得直接写正式时间线。

- [ ] **Step 5: 完成候选预览与采用/丢弃**

工作台顶部显示待采用数量，候选 Dialog 显示前后时长、顺序、音量和字幕差异；采用调用 `adoptTimelineEdit`，过期时禁止按钮并提示重新读取；丢弃只改变候选状态。

- [ ] **Step 6: 运行 Agent 与 renderer 回归**

```bash
bun test packages/shared/src/types/visual-editing.test.ts apps/electron/src/main/lib/visual-production/editing-store.test.ts apps/electron/src/main/lib/visual-production/agent-tools.test.ts apps/electron/src/renderer/components/visual-production/VisualEditingWorkspace.test.tsx
bun run --filter='@dutydeck/electron' typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/types/visual-editing.ts apps/electron/src/main/lib/visual-production/editing-store.ts apps/electron/src/main/lib/visual-production/agent-tools.ts apps/electron/src/main/lib/agent-orchestrator.ts apps/electron/src/renderer/components/visual-production/VisualEditingInspector.tsx apps/electron/src/renderer/components/visual-production/VisualEditingCandidateDialog.tsx apps/electron/src/renderer/components/visual-production/VisualEditingWorkspace.tsx packages/shared/src/types/visual-editing.test.ts apps/electron/src/main/lib/visual-production/editing-store.test.ts apps/electron/src/main/lib/visual-production/agent-tools.test.ts apps/electron/src/renderer/components/visual-production/VisualEditingWorkspace.test.tsx
git commit -m "支持Agent修改影像剪辑时间线"
```

### Task 5: 接入成片导出任务

**Files:**
- Modify: `packages/shared/src/types/visual-editing.ts`
- Create: `apps/electron/src/main/lib/visual-production/export-service.ts`
- Create: `apps/electron/src/main/lib/visual-production/export-service.test.ts`
- Modify: `apps/electron/src/main/lib/visual-production/editing-store.ts`
- Modify: `apps/electron/src/main/lib/visual-production/ipc.ts`
- Modify: `apps/electron/src/renderer/components/visual-production/VisualEditingWorkspace.tsx`
- Create: `apps/electron/src/renderer/components/visual-production/VisualEditingExportDialog.tsx`
- Test: `apps/electron/src/renderer/components/visual-production/VisualEditingWorkspace.test.tsx`

- [ ] **Step 1: 写导出任务测试**

覆盖冻结时间线 revision、源媒体 hash、重复请求幂等、编码器不可用失败、取消排队任务、输出 hash 校验和错误恢复。

- [ ] **Step 2: 定义导出 IPC 和任务状态**

新增 `requestExport`、`listExportJobs`、`cancelExport` 输入/输出；请求只接收比例、帧率、音频与字幕开关等有限设置，不接收路径。 `VisualEditingExportJob` 保存 frozen timeline revision、source hashes、encoder id、state、message、artifact hash。

- [ ] **Step 3: 实现编码器 adapter 边界**

`export-service.ts` 只接受主进程解析的媒体副本和规范时间线，先检查现有可用编码器；无编码器时返回 `EXPORT_ENCODER_UNAVAILABLE` 并持久化 failed 任务。可用编码器完成后检查输出存在、MIME 和 hash，再标记 completed。禁止把 `exportManifest` 的 JSON 或素材下载结果当作成片。

- [ ] **Step 4: 接入导出弹窗与状态**

导出 Dialog 复用项目默认 Select/Dialog/Button，显示当前集、时长、比例、帧率和任务状态；进行中允许取消本机任务，完成后提供真实文件下载入口，失败显示可行动原因。

- [ ] **Step 5: 运行导出测试**

```bash
bun test apps/electron/src/main/lib/visual-production/export-service.test.ts apps/electron/src/renderer/components/visual-production/VisualEditingWorkspace.test.tsx
bun run --filter='@dutydeck/electron' typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types/visual-editing.ts apps/electron/src/main/lib/visual-production/export-service.ts apps/electron/src/main/lib/visual-production/export-service.test.ts apps/electron/src/main/lib/visual-production/editing-store.ts apps/electron/src/main/lib/visual-production/ipc.ts apps/electron/src/renderer/components/visual-production/VisualEditingWorkspace.tsx apps/electron/src/renderer/components/visual-production/VisualEditingExportDialog.tsx apps/electron/src/renderer/components/visual-production/VisualEditingWorkspace.test.tsx
git commit -m "接入影像成片导出任务"
```

### Task 6: 完成 Electron smoke 与全仓验证

**Files:**
- Modify: `apps/electron/src/renderer/components/visual-production/VisualEditingWorkspace.test.tsx`
- Create: `apps/electron/src/renderer/components/visual-production/visual-editing.smoke.test.ts`

- [ ] **Step 1: 增加真实 Electron smoke 场景**

覆盖默认窄侧栏、展开精剪、集数切换、空集粗剪、时间线横向滚动、片段弹窗保存、Agent 候选采用/撤销、主题切换、460px 窄窗口、焦点恢复和错误重试。

- [ ] **Step 2: 运行最小回归**

```bash
bun test packages/shared/src/types/visual-editing.test.ts apps/electron/src/main/lib/visual-production/editing-store.test.ts apps/electron/src/main/lib/visual-production/export-service.test.ts apps/electron/src/renderer/components/visual-production/VisualEditingWorkspace.test.tsx
```

- [ ] **Step 3: 运行全仓类型检查与构建**

```bash
bun run typecheck
bun run build
```

Expected: 类型检查和构建通过；若真实编码器不可用，只允许导出失败态测试通过，不把环境缺失当成成功。

- [ ] **Step 4: 复查差异与工作区**

```bash
git diff --check
git status --short --branch
```

确认只包含剪辑时间线相关文件，未覆盖用户已有改动、未提交原型或无关模块。

- [ ] **Step 5: Commit**

```bash
git add apps/electron/src/renderer/components/visual-production/VisualEditingWorkspace.test.tsx apps/electron/src/renderer/components/visual-production/visual-editing.smoke.test.ts
git commit -m "补齐影像剪辑成片回归验证"
```

