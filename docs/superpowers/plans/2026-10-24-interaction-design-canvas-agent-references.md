# 交互设计画布与 Agent 参考图实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已确认的交互设计画布、页面图片和参考图模块接入正式 DutyDeck 交互设计模块，并让 Agent 能读取版本化参考图关系与原图。

**Architecture:** 参考图作为 `PrototypeDraft.references` 的版本化数据，关联到页面、状态或流程；资产字节继续由独立 `PrototypeAsset` 库管理。主进程新增固定版本参考图投影读取，Agent 通过 `prototype_read_references` 获取 assetId、SHA-256、MIME 和关联用途，再按需读取原图。工作区页签顺序为“原型预览 → 画布 → 参考图”，画布页面图只做无脚本沙箱渲染，不执行全部原型脚本。

**Tech Stack:** Bun、TypeScript、React、Jotai、Radix/shadcn、`@xyflow/react`、Electron IPC、现有 `PrototypePreview` 与资产服务。

---

### Task 1: 版本化参考图合同

**Files:**
- Modify: `packages/shared/src/types/interaction-design.ts`
- Modify: `packages/shared/src/types/interaction-design-validation.ts`
- Test: `packages/shared/src/types/interaction-design.test.ts`
- Modify: `apps/electron/src/renderer/components/interaction-design/interaction-design-model.ts`
- Test: `apps/electron/src/renderer/components/interaction-design/interaction-design-model.test.ts`

- [ ] **Step 1: 写失败测试**

在 `interaction-design.test.ts` 增加 BDD 用例：

```ts
test('Given 页面参考图 When 解析草稿 Then 保留用途和版本关联', () => {
  const value = {
    ...draft(),
    references: [{
      id: 'reference-1',
      assetId: 'asset-1',
      title: '活动详情结构',
      role: 'structure',
      source: 'Figma',
      usages: [{ pageId: 'home', stateId: null, flowId: null }],
    }],
  }
  expect(parsePrototypeDraft(value).references?.[0]?.usages[0]?.pageId).toBe('home')
})
```

同时覆盖不存在的 asset、页面、状态和流程关联必须拒绝。

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test packages/shared/src/types/interaction-design.test.ts`
Expected: FAIL，`references` 未被保留或被验证器丢弃。

- [ ] **Step 3: 实现共享合同**

在 `interaction-design.ts` 增加：

```ts
export type PrototypeReferenceRole = 'structure' | 'visual' | 'copy'

export interface PrototypeReferenceUsage {
  pageId: string
  stateId?: string
  flowId?: string
}

export interface PrototypeReference {
  id: string
  assetId: string
  title: string
  role: PrototypeReferenceRole
  source?: string
  usages: PrototypeReferenceUsage[]
}
```

并给 `PrototypeDraft` 增加可选 `references?: PrototypeReference[]`。验证规则：reference id 与 assetId 唯一；usage 必须指向当前版本的页面；stateId 必须属于该页面；flowId 必须属于该页面或指向该页面；同一 reference 内 usage 不可重复。

- [ ] **Step 4: 更新 renderer 深拷贝和 Agent prompt**

`copyPrototypeDraft` 必须携带 `references`。`buildPrototypePrompt` 在指定 `pageId` 时追加该页面、状态及流程的参考图 id 与用途，并提示 Agent 使用 `prototype_read_references` 获取元数据、按需使用 `prototype_asset_content`。

- [ ] **Step 5: 运行共享与 renderer 模型测试**

Run: `bun test packages/shared/src/types/interaction-design.test.ts apps/electron/src/renderer/components/interaction-design/interaction-design-model.test.ts`
Expected: PASS。

### Task 2: 资产校验、固定版本读取和 Agent 工具

**Files:**
- Modify: `packages/shared/src/types/interaction-design.ts`
- Modify: `packages/shared/src/types/interaction-design-validation.ts`
- Modify: `apps/electron/src/main/lib/interaction-design/store.ts`
- Test: `apps/electron/src/main/lib/interaction-design/store.test.ts`
- Modify: `apps/electron/src/main/lib/interaction-design/agent-tools.ts`
- Test: `apps/electron/src/main/lib/interaction-design/agent-tools.test.ts`
- Modify: `apps/electron/default-skills/interaction-design/SKILL.md`

- [ ] **Step 1: 写失败测试**

在 `store.test.ts` 中导入资产并提交带参考图关联的版本，断言：

```ts
const refs = await service.invoke('readReferences', {
  sessionId,
  prototypeId,
  revision: 2,
})
expect(refs[0]).toMatchObject({
  referenceId: 'reference-1',
  assetId: asset.id,
  hash: asset.hash,
  role: 'structure',
})
```

同时断言不存在 asset 的引用被 `save/propose` 拒绝；历史 revision 读取不会返回后来新增参考图。

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/main/lib/interaction-design/store.test.ts`
Expected: FAIL，`readReferences` 不在命令联合或工具白名单中。

- [ ] **Step 3: 实现参考图读取**

新增只读命令：

```ts
readReferences: {
  sessionId: string
  prototypeId: string
  revision: number
  pageId?: string
}
```

返回 `PrototypeReferenceProjection[]`，每项包含 reference 数据与对应 `PrototypeAsset` 元数据，不包含 data URL。`store.assertAssets` 同时检查页面 HTML 和 `draft.references[].assetId`。

- [ ] **Step 4: 接入 Agent 工具**

把 `prototype_read_references` 加入读工具白名单和工具列表。描述明确：先读取固定 revision，按页面过滤，得到参考图用途与 asset 元数据；只有需要看图时才调用 `prototype_asset_content`，不得把参考图描述成已经实现的交互。

更新 `interaction-design/SKILL.md` 至 `1.0.12`，加入参考图读取、页面/状态/流程关联和图像用途规则。

- [ ] **Step 5: 运行 Agent 与 store 测试**

Run: `bun test apps/electron/src/main/lib/interaction-design/store.test.ts apps/electron/src/main/lib/interaction-design/agent-tools.test.ts`
Expected: PASS。

### Task 3: 正式工作区页签与参考图界面

**Files:**
- Create: `apps/electron/src/renderer/components/interaction-design/InteractionDesignReferences.tsx`
- Create: `apps/electron/src/renderer/components/interaction-design/InteractionDesignReferences.test.tsx`
- Modify: `apps/electron/src/renderer/components/interaction-design/InteractionDesignWorkspace.tsx`
- Modify: `apps/electron/src/renderer/components/interaction-design/interaction-design.css`

- [ ] **Step 1: 写失败组件测试**

用静态渲染断言：

```tsx
const markup = renderToStaticMarkup(<InteractionDesignReferences ... />)
expect(markup).toContain('参考图')
expect(markup).toContain('aria-label="活动详情结构参考图"')
expect(markup).toContain('data-reference-aspect-ratio')
```

并覆盖空态、筛选无结果、单张参考图两个页面关联和已有选中项。

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/renderer/components/interaction-design/InteractionDesignReferences.test.tsx`
Expected: FAIL，组件不存在。

- [ ] **Step 3: 实现参考图页**

组件接受 `document`、`assets`、`readAsset`、`onSave` 和 `onReference`。图库从 `document.references` 渲染；未登记资产不可显示为正式参考图。每张卡片使用正方形外壳和内部 contain 图片；点击打开本地 Dialog 大图。关联编辑复用现有 Input/Dialog/DropdownMenu。

- [ ] **Step 4: 接入工作区**

在模块页头下增加“原型预览 / 画布 / 参考图”页签；参考图放最后。页签只切视图，不改变当前页面或布局现场。`onSave` 使用现有 `save(draft, '更新参考图')` CAS。

- [ ] **Step 5: 运行组件测试与类型检查**

Run: `bun test apps/electron/src/renderer/components/interaction-design/InteractionDesignReferences.test.tsx apps/electron/src/renderer/components/interaction-design/interaction-design-model.test.ts`
Run: `bun run typecheck`
Expected: PASS。

### Task 4: 交互图画布与静态页面缩略图

**Files:**
- Create: `apps/electron/src/renderer/components/interaction-design/InteractionDesignCanvas.tsx`
- Create: `apps/electron/src/renderer/components/interaction-design/interaction-design-canvas-model.ts`
- Create: `apps/electron/src/renderer/components/interaction-design/interaction-design-canvas.css`
- Create: `apps/electron/src/renderer/components/interaction-design/InteractionDesignCanvas.test.tsx`
- Test: `apps/electron/src/renderer/components/interaction-design/interaction-design-canvas-model.test.ts`
- Modify: `apps/electron/src/renderer/components/interaction-design/InteractionDesignWorkspace.tsx`

- [ ] **Step 1: 写失败图模型测试**

断言入口页在首列、流程目标在后列、同一列节点不重叠、孤立页仍有位置、选择页面只高亮直接边。画布不使用分组成员。

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/electron/src/renderer/components/interaction-design/interaction-design-canvas-model.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现图布局**

用确定性 BFS 生成列和行，所有节点采用当前预览设备的宽高比。边只来自 `document.flows`，不通过拖动读写正式流程。坐标只存 Jotai 视图偏好，不进入设计版本。

- [ ] **Step 4: 实现静态页面图**

节点中的页面图使用 `buildPrototypePreview` 生成 HTML，放入 `sandbox=""` 的 iframe；该沙箱不允许脚本，只用于静态首帧。图片资源按页面懒加载并复用现有 `createPrototypePreviewAssetReader`。不得为缩略图执行页面脚本。

- [ ] **Step 5: 接入工作区并验证**

“画布”位于参考图之前，默认视图保持原型预览。点击节点切换当前页面，双击进入原型预览；底部选中栏提供打开预览和关联参考图。

Run: `bun test apps/electron/src/renderer/components/interaction-design/InteractionDesignCanvas.test.tsx apps/electron/src/renderer/components/interaction-design/interaction-design-canvas-model.test.ts`
Run: `bun run typecheck`
Expected: PASS。

### Task 5: 完整验证

**Files:**
- Modify: `MEMORY.md`

- [ ] **Step 1: 运行交互设计相关回归**

Run: `bun test packages/shared/src/types/interaction-design.test.ts apps/electron/src/main/lib/interaction-design apps/electron/src/renderer/components/interaction-design`
Expected: 全部 PASS。

- [ ] **Step 2: 运行全仓检查**

Run: `bun run typecheck`
Run: `git diff --check`
Expected: 均通过；只保留可解释的既有警告。

- [ ] **Step 3: 真实 Electron/浏览器冒烟**

验证深浅主题、1440/820/460px、页签顺序、画布页面图、参考图正方形 contain、点击大图、页面/状态关联、Agent 读取投影和控制台零错误。

- [ ] **Step 4: 更新 MEMORY.md**

记录参考图数据合同、Agent 工具、画布静态缩略图边界、验证结果和仍未完成项。
