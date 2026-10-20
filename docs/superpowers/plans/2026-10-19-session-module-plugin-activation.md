# 会话模块开关与插件激活 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除消息输入框底部的模块选择流程，把模块能力开关放到右侧工具栏，并让内置模块与受管插件按同一套 Session 策略、工具门禁和审计合同生效。

**Architecture:** 右侧工具栏只负责显示面板状态和切换 Session 能力；主进程以 `AgentSessionModulePolicy` 为唯一持久化事实源，在每轮开始时根据模块激活模式、插件状态、会话准入和包 hash 生成不可变能力快照。旧消息中的 `moduleIds` 保留为历史、重试和显式一次性调用兼容字段，新消息默认从 Session 策略解析。插件可以声明 Skill、prompt、style 和模块激活方式，但插件清单中的 `toolRefs` 不能直接授予宿主工具。

**Tech Stack:** Bun、TypeScript、Electron IPC、React、Jotai、Radix/shadcn、JSON 原子写入、现有 Pi Agent runtime、现有 `AgentPluginRegistry`/`AgentPluginHost`。

---

## 0. 先给结论

这个方案应当落地，原因是它修复了当前权限链路中的根因：右侧面板的 `active` 只表示“正在打开”，而 `module-skill-resolver.ts` 只读取当前消息的 `explicitModuleIds`，所以用户即使打开了画布、影像创作或交互设计面板，发送消息时仍可能得到 `moduleIds: []`，专业 Skill 和工具不会装配。

方案不能单独修复 `CANVAS_BINDING_FAILED`。该错误发生在画布关联阶段，仍需检查画布 ID、文件/项目状态、关联事务和损坏数据；本设计只保证“模块已开启且当前会话可用”不会再被误判为“没有画布能力”。画布绑定错误必须继续显示独立错误码、阶段和诊断日志，不能把模块开关当成绑定成功的证明。

## 1. 功能目标与非目标

### 1.1 功能目标

- 右侧工具栏展示内置专业模块和已安装插件模块；每个条目同时表达“面板是否打开”和“当前 Session 是否允许 Agent 调用”。
- 用户开启模块后，模块能力跟随当前 Agent Session，后续消息默认使用该 Session 策略。
- Agent 运行期间不热扩权；策略修改从下一轮开始生效，当前运行使用启动时冻结的模块、插件版本和包 hash。
- 内置模块、manifest-only 插件和内容插件共用模块目录、Session 策略、资源解析、工具门禁和运行审计。
- 保留旧消息 `moduleIds`，让历史消息、旧会话恢复、重试和一次性显式模块命令继续可读可执行。
- 分支会话有自己的策略；创建用户探索分支时可以复制父会话偏好，但不复制父会话的授权事实。
- 通过同一个会话准入 helper 统一 UI 与主进程对探索分支、归档会话、自动化会话、委派会话和内部会话的判断。

### 1.2 非目标

- 不把模块开关改成逐个底层工具开关；`media_*`、`canvas_*` 等仍由模块边界统一控制。
- 不让插件 manifest 中的字符串 `toolRefs` 直接变成可执行函数或扩大宿主工具集合。
- 不在本轮解决画布文件关联、Canvas 数据迁移、媒体输入格式或模型供应商错误。
- 不执行第三方插件 JavaScript；当前 V2 内容插件仍是受校验的 Skill、prompt、style 和资源包。
- 不改变浏览器、终端等宿主基础能力的自动可用规则；它们可以在工具栏打开面板，但不因专业模块策略自动获得额外权限。

## 2. 当前问题与代码边界

### 2.1 已确认的调用链问题

1. [`packages/shared/src/types/agent-modules.ts`](../../../packages/shared/src/types/agent-modules.ts) 已有 `AgentSessionModulePolicy`，但 `AgentModuleManifest` 没有 `activation`。
2. [`apps/electron/src/main/lib/agent-modules/module-skill-resolver.ts`](../../../apps/electron/src/main/lib/agent-modules/module-skill-resolver.ts) 的 `resolveSelectedModuleIds()` 只读取 `explicitModuleIds`；空消息选择直接返回空模块。
3. [`apps/electron/src/renderer/components/agent/AgentView.tsx`](../../../apps/electron/src/renderer/components/agent/AgentView.tsx) 只有在 `mentions.moduleIds` 非空时才把模块写入发送输入。
4. [`apps/electron/src/renderer/components/agent/AgentModuleBar.tsx`](../../../apps/electron/src/renderer/components/agent/AgentModuleBar.tsx) 的 `messageMode` 仍把模块选择放在输入框底部；这个状态属于草稿，不属于 Session。
5. [`apps/electron/src/renderer/components/app-shell/WorkspaceTools.tsx`](../../../apps/electron/src/renderer/components/app-shell/WorkspaceTools.tsx) 的 `TOOL_ITEMS` 是静态列表，`active` 只代表面板导航。
6. [`apps/electron/src/renderer/atoms/workspace-tools.ts`](../../../apps/electron/src/renderer/atoms/workspace-tools.ts) 的 `visualProductionDenialReason()` 仍拒绝 `explorationParentSessionId`，而主进程 [`apps/electron/src/main/lib/agent-session-visibility.ts`](../../../apps/electron/src/main/lib/agent-session-visibility.ts) 的 `isEligibleProjectAgent()` 已允许符合条件的用户探索分支。
7. [`apps/electron/src/main/lib/agent-modules/module-tool-policy.ts`](../../../apps/electron/src/main/lib/agent-modules/module-tool-policy.ts) 已有按工具前缀映射模块的门禁，应继续作为最后一道门，不由 renderer 或插件绕过。
8. [`packages/plugin-sdk/src/contracts.ts`](../../../packages/plugin-sdk/src/contracts.ts) 和 [`packages/plugin-sdk/src/schema.ts`](../../../packages/plugin-sdk/src/schema.ts) 当前只接受 `message-explicit`；[`packages/shared/src/types/content-plugin.ts`](../../../packages/shared/src/types/content-plugin.ts) 的 V2 插件是 manifest-only，`permissions`、`dependencies`、`exports` 均为空。

### 2.2 关联模块影响

- Agent 编排、队列、恢复、审计、设置插件中心和右侧工具栏都会读模块目录或 Session 策略，必须以 shared 类型为边界同步变更。
- 画布、影像、交互设计的业务服务不改调用语义；它们只接收经过模块快照和现有业务准入的工具请求。
- 插件目录、插件安装和 Plugin Host 的生命周期保持独立；“全局启用”与“当前 Session 开启”不能合并。

## 3. 状态模型

### 3.1 四个独立事实

| 状态 | 事实源 | 含义 | 可否直接授权 Agent |
| --- | --- | --- | --- |
| 已安装 | 插件管理器/包目录 | 包已通过结构、完整性和兼容性校验 | 否 |
| 全局启用 | 插件注册表/插件管理服务 | 插件允许进入宿主模块目录 | 否 |
| 本会话已开启 | `AgentSessionMeta.modulePolicy` | 当前 Session 后续消息默认可解析该模块 | 经过主进程准入后是 |
| 面板已打开 | renderer Jotai 导航状态 | 当前窗口正在显示对应工作区 | 否 |

### 3.2 统一条目模型

新增类型放在 `packages/shared/src/types/agent-modules.ts`，用于主进程投影和 renderer 展示：

```ts
export type WorkspaceToolEntryKind = 'workspace-surface' | 'module-capability'

export interface WorkspaceToolEntry {
  id: string
  kind: WorkspaceToolEntryKind
  label: string
  icon: string
  group: '工作区' | '效率' | '知识与能力' | '专业工具' | '插件'
  moduleId?: string
  enabledForSession: boolean
  panelOpen: boolean
  visible: boolean
  disabledReason?: string
  activation: AgentModuleActivationMode
  pluginId?: string
  moduleVersion?: string
  packageHash?: string
  surfaceIds: string[]
}
```

`WorkspaceToolId` 保持静态 union，用于已有导航和面板类型；插件条目使用 `WorkspaceToolEntry.moduleId` 和 `kind: 'module-capability'`，不能把 `WorkspaceToolId` 退化成 `string`。右侧工具栏组件接收 `WorkspaceToolEntry[]`，静态工作区入口和动态模块入口在同一视觉列表中渲染。

### 3.3 模块激活模式

```ts
export type AgentModuleActivationMode = 'message-explicit' | 'session-toggle'

export interface AgentModuleManifest {
  // 已有字段保持不变
  id: string
  version: string
  apiVersion: 1
  displayName: string
  description: string
  icon: string
  scope: AgentModuleScope
  contributions: AgentModuleContribution[]
  skillRefs: string[]
  promptRefs: string[]
  toolRefs: string[]
  artifactTypes: string[]
  surfaceIds: string[]
  requiredPermissions: string[]
  activation: AgentModuleActivationMode
  source?: 'builtin' | 'installed'
  pluginId?: string
  resourceSource?: 'package'
  packageHash?: string
}
```

旧清单没有 `activation` 时，解析器把它规范化为 `message-explicit` 并记录警告；绝不能默认升级成 `session-toggle`，否则旧插件会在用户没有明确开启的情况下自动进入后续消息。

`AgentSessionModulePolicy` 继续使用现有合同：

```ts
export interface AgentSessionModulePolicy {
  mode: AgentModuleMode
  enabledModuleIds: string[]
  disabledModuleIds: string[]
  pinnedModuleIds: string[]
  revision: number
  updatedAt: number
}
```

`enabledModuleIds` 是会话默认开启集合；`disabledModuleIds` 优先级最高；`pinnedModuleIds` 只表达 UI 固定偏好，不绕过插件全局关闭、模块激活模式或会话准入。所有写入使用 `expectedRevision` CAS。

## 4. 右侧工具栏交互设计

### 4.1 入口行为

- 点击条目主体：打开或聚焦对应面板；这只改变 `panelOpen`。
- 点击条目右侧的开关/状态按钮：切换 `enabledForSession`；这只调用 `SET_SESSION_MODULE_POLICY`。
- 折叠工具栏：图标点击打开面板；长按或键盘菜单显示“开启本会话能力”“关闭本会话能力”“查看调用记录”。
- 展开工具栏：专业模块显示开关、当前状态点和不可用原因；插件模块显示来源、版本和 hash 截断摘要，完整信息放 Tooltip/详情弹层。
- 面板打开但能力关闭时，面板仍可浏览已有产物；面板内发起需要 Agent 的操作时明确提示“请先开启本会话能力”。
- 模块能力已经开启但面板未打开时，状态点显示“可调用”；这正是解决当前“面板打开但 Agent 无工具”问题的关键。

### 4.2 状态和文案

| 条件 | UI 状态 | 用户动作 |
| --- | --- | --- |
| 已安装、全局启用、会话已开启 | `可调用` | 关闭或打开面板 |
| 已安装、全局启用、会话未开启 | `未开启` | 开启本会话 |
| 插件全局关闭 | `插件已停用` | 去插件中心启用 |
| 包 hash/版本不匹配 | `需要刷新` | 刷新目录；失败时不允许开启 |
| 会话无项目或不满足模块准入 | `当前会话不可用` | 切换到可用会话 |
| 运行中切换 | `下一轮生效` | 等待当前运行结束 |
| 目录加载失败 | `模块目录不可用` | 重试；不显示虚假的可调用状态 |

### 4.3 删除底部消息选择器

- 从 `AgentView` 的 `inputToolbarItems` 删除 `AgentModuleBar messageMode`。
- `AgentModuleBar` 改为仅用于会话策略/调用记录兼容入口，或在右侧工具栏完全接管后删除组件及其专属草稿选择逻辑。
- `RichTextInputHandle.toggleModuleMention()` 不再作为普通发送的默认入口；保留读取旧草稿和显式 `/module:<id>` 兼容解析。
- 新发送 payload 不主动写入 `moduleIds`；只附带 `modulePolicyRevision`，由主进程重新读取策略。

## 5. IPC 合同

### 5.1 新增 Session 模块目录投影

在 `packages/shared/src/types/agent-modules.ts` 增加：

```ts
export interface AgentSessionModuleCatalog {
  sessionId: string
  policy: AgentSessionModulePolicy
  entries: WorkspaceToolEntry[]
  catalogRevision: number
  refreshedAt: number
}
```

在 `packages/shared/src/types/agent.ts` 增加：

```ts
GET_SESSION_MODULE_CATALOG: 'agent:get-session-module-catalog'
```

四层同步修改：

1. `packages/shared/src/types/agent.ts`：通道、请求/响应类型和 preload API 类型。
2. `apps/electron/src/main/ipc.ts`：校验可见 Session，调用主进程模块目录投影服务。
3. `apps/electron/src/preload/index.ts`：暴露 `getSessionModuleCatalog(sessionId)`，不暴露任意模块写入能力。
4. `apps/electron/src/renderer/components/agent/agent-module-loader.ts`：把目录、策略和条目作为一次代次发布到 Jotai。

现有 `GET_AGENT_MODULES` 保留给插件中心的全局目录；现有 `GET_SESSION_MODULE_POLICY`/`SET_SESSION_MODULE_POLICY` 保留给最小策略读取和写入。新增目录投影用于把 canonical eligibility、插件健康、面板能力和策略状态一次性返回，避免 renderer 自己复制安全判断。

### 5.2 策略写入规则

`SET_SESSION_MODULE_POLICY` 的主进程处理顺序：

1. `requireVisibleSession(sessionId)`。
2. 读取当前策略并比较 `expectedRevision`；不匹配返回 `AGENT_MODULE_POLICY_REVISION_CONFLICT`。
3. 只接受 `activation === 'session-toggle'` 的模块进入 `enabledModuleIds` 或 `pinnedModuleIds`。
4. 校验插件全局启用、模块版本/hash、会话项目、模块准入和 `toolMode`；失败返回明确错误码。
5. 用 `safe-file.ts` 原子写入 Session 元数据，`revision + 1`，更新 `updatedAt`。
6. 返回新策略；renderer 重新读取目录投影，不能乐观伪造成功状态。

### 5.3 发送与队列字段

保留现有字段并明确来源：

```ts
interface AgentSubmitModuleContext {
  modulePolicyRevision?: number
  moduleIds?: string[]
  moduleInvocationMode?: AgentModuleInvocationMode
  moduleSelectionSource?: 'session-policy' | 'message-explicit' | 'legacy'
}
```

普通发送仅发送 `modulePolicyRevision` 和 `moduleSelectionSource: 'session-policy'`；显式命令、旧消息和历史重试才填写 `moduleIds`。队列记录保存提交时的 revision 和已解析模块 ID 快照，主进程在出队时重新校验，不允许因策略改变而静默扩权。

## 6. Agent runtime 数据流

```text
右侧开关
  → SET_SESSION_MODULE_POLICY(expectedRevision)
  → Session modulePolicy revision + 1
  → GET_SESSION_MODULE_CATALOG 更新 renderer
  → 普通发送只带 modulePolicyRevision
  → Agent 编排在 preflight 读取最新 policy
  → resolveActiveModuleContext()
       ├─ session-toggle 模块：从 enabledModuleIds 解析
       ├─ message-explicit 模块：只接受显式 moduleIds
       ├─ disabled/global/plugin/hash/eligibility 校验
       └─ 生成模块、Skill、prompt、插件资源不可变快照
  → createAgentModuleToolPolicy(activeModuleIds, toolMode)
  → Pi Agent runtime
  → Run Journal 记录 policyRevision、版本、hash、真实 Skill 和工具事件
```

### 6.1 resolver 算法

在 `apps/electron/src/main/lib/agent-modules/module-skill-resolver.ts` 定义纯函数 `resolveSelectedModuleIds(input)`：

```ts
function resolveSelectedModuleIds(input: ResolveActiveModuleContextInput): string[] {
  const explicitIds = input.explicitModuleIds ?? []
  const sessionIds = input.policy.enabledModuleIds
  const catalog = input.catalog
  const selected = catalog.filter((module) => {
    if (isAutomaticAgentModuleId(module.id)) return false
    if (input.policy.disabledModuleIds.includes(module.id)) return false
    if (module.activation === 'session-toggle') return sessionIds.includes(module.id) || explicitIds.includes(module.id)
    return explicitIds.includes(module.id)
  })
  return selected.map((module) => module.id)
}
```

实际实现必须同时过滤未全局启用插件、包 hash 不匹配、当前会话不满足模块准入和重复 ID；上面的代码是决策顺序的最小示例，不是绕过这些检查的公开 API。解析结果为空时只有在没有开启模块时才算正常；显式请求的模块不可用时必须写入 `unavailable`，不能静默退化为普通聊天。

### 6.2 运行快照和热切换

- 每次运行开始时冻结 `policyRevision`、模块版本、插件 ID、包 hash、prompt/Skill 资源摘要和 `activeModuleIds`。
- 运行中切换开关：UI 显示“下一轮生效”，写入可以完成，但当前运行的工具门禁不变。
- 当前运行结束前，插件升级/全局关闭不改写已冻结的资源正文；下一轮重新读取目录。
- `modulePolicyRevision` 迟到时直接返回冲突错误，并记录 `checkpoint:module-context`，不使用 renderer 过期快照。

## 7. 模块工具门禁

`apps/electron/src/main/lib/agent-modules/module-tool-policy.ts` 继续是最后一道门：

- `prototype_` → `interaction-design`
- `visual_` → `visual-production`
- `canvas_` → `canvas`
- `media_` → `canvas` 或 `visual-production`，沿用现有上下文要求
- `ops_`/`server_` → `server-ops`
- `api_` → `api-workbench`
- `factory_` → `capability-factory`

门禁输入只来自主进程解析成功的 `activeModuleIds` 和现有 `toolMode`。插件 `toolRefs` 仅用于目录和审计声明；manifest-only 内容插件不加入 `trustedToolNames`，也不改变宿主 Pi 工具 schema。未来若开放真实插件工具，必须新增受信工具注册、命名空间、签名发布者、capability allowlist、生命周期和卸载租约，不能复用本轮内容插件字段直接执行。

## 8. 插件激活合同

### 8.1 SDK 与宿主类型

修改：

- `packages/plugin-sdk/src/contracts.ts`：新增不依赖宿主 shared 包的 `PluginModuleActivationMode = 'message-explicit' | 'session-toggle'`，`PluginModule.activation` 使用该 SDK 本地类型；宿主适配层再映射为 shared 的 `AgentModuleActivationMode`。
- `packages/plugin-sdk/src/schema.ts`：模块 `activation` 接受两个枚举值；缺失字段只在兼容解析层补齐，不在新模板中省略。
- `packages/shared/src/types/agent-plugin.ts`：旧 `AgentPluginManifest` 模块归一化时补 `activation: 'message-explicit'`；新模块可以声明 `session-toggle`。
- `packages/shared/src/types/content-plugin.ts`：`InstalledContentPlugin` 继续区分 `enabled` 与 Session 开启，`ContentPluginPreview` 增加每个模块的激活模式摘要。

### 8.2 版本与兼容

- V1 manifest-only 插件没有 `activation`：解析为 `message-explicit`，保留原选择/历史行为。
- V2 content plugin 显式声明 `session-toggle`：只有包结构、签名/完整性、发布者信任、全局启用和宿主版本均满足时，才出现在右侧会话开关列表。
- 模块 ID 使用全限定形式 `${pluginId}.${localModuleId}`；旧插件的本地 ID 只在 registry 载入时转换，历史消息中的旧 ID 由兼容别名映射，不把 `WorkspaceToolId` 改成任意字符串。
- `activation` 只改变默认选择来源，不增加工具权限；因此旧包安全降级为显式消息模式，不需要静默迁移已有 Session 策略。

### 8.3 插件生命周期

| 操作 | Session 策略 | 当前运行 | 下一轮 |
| --- | --- | --- | --- |
| 全局停用 | 保留 ID，条目显示不可用 | 使用已冻结资源完成或按现有运行策略停止 | 拒绝新准入 |
| 升级 | 保留 ID，目录显示新版本待生效 | 使用旧版本 hash | 重新解析新版本 |
| 卸载 | 保留历史/策略引用，条目显示缺失 | 不删除被引用的运行资源 | 阻断新运行；无引用包才回收 |
| hash 不匹配 | 不自动修复策略 | 当前快照不受影响 | fail closed，要求刷新/恢复 |

每轮审计记录实际 `pluginId`、`moduleVersion`、`packageHash`，不能只记模块 ID。

## 9. 会话、分支、恢复和队列语义

### 9.1 会话准入矩阵

在 `packages/shared/src/types/agent-session-eligibility.ts` 增加纯函数 `getAgentModuleEligibility(moduleId, session, projectId)`，renderer 的目录投影和主进程的策略写入/运行 preflight 都调用同一规则：

| 模块 | 普通项目会话 | 用户探索分支 | 自动化/委派 | 内部 Design/Canvas |
| --- | --- | --- | --- | --- |
| 交互设计 | 允许 | 允许 | 拒绝 | 拒绝 |
| 影像创作 | 允许 | 允许 | 拒绝 | 拒绝 |
| 画布 | 允许 | 允许 | 拒绝 | 拒绝 |
| 服务器运维 | 按现有普通顶层与 toolMode 规则 | 按现有 API/运维规则 | 拒绝 Agent 自动扩权 | 拒绝 |
| 接口工作台 | 按现有项目/网络规则 | 按现有项目/网络规则 | 按现有 facade 规则 | 拒绝 |
| 编排工厂 | 允许 | 允许 | 拒绝 | 拒绝 |

`workspace-tools.ts` 的 `visualProductionDenialReason()` 不再直接检查 `isOrdinaryTopLevelAgentSession()`；它使用目录投影中的 `disabledReason`，后端仍独立复核。这样探索分支不会出现 UI 拒绝、后端允许的矛盾。

### 9.2 创建探索分支

- 用户探索分支创建时复制父会话的 `modulePolicy` 作为偏好快照，`revision` 从 0 重置，`updatedAt` 重新生成。
- 不复制当前运行快照、插件租约、权限票据或工具调用结果。
- 分支首次发送仍重新检查项目、可见性、归档、自动化、委派、内部来源和插件 hash。
- 自动化、委派、内部会话不通过复制策略获得普通用户模块能力。

### 9.3 队列和恢复

- 用户提交排队消息时保存 `modulePolicyRevision`、解析出的模块 ID、版本和 hash。
- 出队时若 revision 未变，按快照继续；若 revision 改变，重新校验所有模块仍开启且 hash 一致。
- 若模块已被关闭、删除或变为不可用，队列消息进入 `AGENT_MODULE_POLICY_CHANGED`，显示“策略已改变，请重试”，不静默改为普通聊天，也不自动扩大到新开启模块。
- 恢复运行必须匹配 Journal 中的 `policyRevision`、模块版本、包 hash、工具 schema 和项目准入；缺少任一证据时只允许查看审计，不允许继续执行。

## 10. 迁移策略

1. Session JSON：继续通过 `normalizeAgentSessionModulePolicy()` 读取；缺失策略得到空 enabled 集合和 `mode: 'auto'`，不自动开启专业模块。
2. 内置模块：`canvas`、`visual-production`、`interaction-design`、`server-ops`、`api-workbench`、`capability-factory` 的 manifest 明确写 `activation: 'session-toggle'`。
3. `browser`、`terminal`：保留宿主自动模块语义，不进入专业模块会话开关；面板仍由右侧工作区入口打开。
4. 旧插件 manifest：缺失 `activation` 时规范化为 `message-explicit`，在插件诊断中显示兼容警告。
5. 旧消息与旧审计：保留 `moduleIds` 和历史模块版本/hash；渲染层按模块目录或归档审计显示“历史模块”，不能重写历史 JSONL。
6. 输入框草稿：移除新的 module mention 写入；已有草稿中的 module mention 在发送时作为 `message-explicit` 一次性兼容输入，发送成功后不再生成新的底部选择 chip。
7. 插件禁用/卸载：不静默删除 Session 策略 ID；在目录投影中标记不可用，用户重新安装相同身份且 hash 合法后才恢复可选。

## 11. 性能、资源和可观测性预算

- 插件目录只在启动、显式刷新和插件变更通知后读取；普通发送不扫描插件目录。
- 运行解析按 `pluginId + version + packageHash` 缓存包资源；只读取当前开启模块引用的 Skill/prompt/style。
- 沿用现有上限：插件模块最多 256 个、提示总量 512 KiB、单轮 Skill/prompt 预算由 `packages/plugin-sdk` 的 `RESOURCE_LIMITS` 约束；超过预算明确返回 `AGENT_MODULE_PACKAGE_CONTEXT_LIMIT`。
- 每次开关只写一次 Session JSON 原子文件；renderer 使用会话级 Jotai atom，目录投影变更按 `catalogRevision` 丢弃旧请求，避免全应用重渲染。
- 工具栏只保存最近状态，不保存资源正文；日志记录 policy revision、模块版本/hash、不可用原因和真实工具事件，不记录完整 prompt、路径、凭据或用户输入副本。
- 开关切换不触发模型请求、网络请求或面板资源创建；面板打开由既有 WorkContext 路由负责。

## 12. 安全模型

- renderer 的开关是请求，不是授权；主进程每次写策略和每轮运行都复核。
- `session-toggle` 只改变默认模块选择，不改变基础权限、项目路径、网络、媒体 provider 或服务器凭据权限。
- 插件模块必须使用全限定 ID；内置 ID、prompt ID、插件 ID 冲突直接拒绝。
- `toolRefs` 不进入宿主 `trustedToolNames`；真实插件工具若开放，必须走独立信任/签名/沙箱设计。
- 包 hash、版本和发布者绑定在安装、运行、恢复和审计中保持一致；任何不一致 fail closed。
- 运行中开关不会改写当前工具门禁；防止迟到 renderer 写入造成 TOCTOU 扩权。
- 探索分支只复制用户偏好，不复制自动化、委派、内部来源、权限票据或父运行上下文。

## 13. 测试矩阵

| 场景 | 层级 | 主要测试 | 通过条件 |
| --- | --- | --- | --- |
| 旧 manifest 无 activation | shared/SDK | `packages/shared/src/types/agent-plugin.test.ts`、`packages/plugin-sdk/tests/validation.test.ts` | 规范化为 message-explicit，并产生兼容警告 |
| Session 开启画布后普通消息发送 | resolver/orchestrator | `apps/electron/src/main/lib/agent-modules/module-skill-resolver.test.ts`、`agent-orchestrator.test.ts` | 无 `moduleIds` 仍解析 canvas，工具门禁允许画布工具 |
| Session 关闭画布 | resolver/tool policy | `module-skill-resolver.test.ts`、`module-tool-policy.test.ts` | 不注入 Skill/prompt，画布工具被拒绝并有明确原因 |
| 面板打开但能力关闭 | renderer | `WorkspaceTools.test.tsx`、`WorkspaceToolRail.test.tsx` | 面板可浏览，Agent 能力状态仍为未开启 |
| 右侧开关 CAS 冲突 | IPC/loader | `agent-module-catalog-ipc.test.ts`、`agent-module-loader.test.ts` | 旧 revision 不覆盖新策略，UI 显示可重试 |
| 探索分支 | shared/main/renderer | `agent-session-eligibility.test.ts`、`agent-session-visibility.test.ts`、`workspace-tools.test.ts` | 交互设计/影像/画布 UI 与后端均允许；自动化/委派/内部会话仍拒绝 |
| 插件全局停用/升级/卸载 | plugin/runtime/audit | `content-plugin-service.test.ts`、`plugin-management-service.test.ts`、`module-run-audit.test.ts` | 当前运行快照稳定，下一轮 fail closed，历史审计保留版本/hash |
| 队列策略发生变化 | queue/recovery | `agent-queue-routing.module-policy.test.ts`、`agent-recovery-context.test.ts` | 不静默扩权，进入 `AGENT_MODULE_POLICY_CHANGED` |
| `toolRefs` 试图授予工具 | tool gate | `module-tool-policy.test.ts`、插件 registry 测试 | 未注册宿主工具不执行，manifest-only 插件仍无 runtime 权限 |
| Canvas 关联真实失败 | Canvas binding | `apps/electron/src/main/lib/design/agent-canvas-binding-ipc.test.ts`、现有诊断日志测试 | 仍返回 `CANVAS_BINDING_FAILED` 和关联阶段；不被模块开关吞掉或伪装成功 |
| 完整用户流程 | Electron smoke | `apps/electron/scripts/session-module-plugin-activation-smoke.ts` 与 renderer smoke | 右侧开关、普通发送、审计、插件变更和回滚开关贯通 |

执行顺序：先跑 shared/SDK 和 resolver 单元测试，再跑 IPC/renderer，最后跑 Electron smoke、`bun run typecheck`、`bun test` 和 `bun run electron:build`。

## 14. 实施任务

### Task 1: 固化 shared 模块和插件合同

**Files:**
- Modify: `packages/shared/src/types/agent-modules.ts`
- Modify: `packages/shared/src/types/agent-plugin.ts`
- Modify: `packages/shared/src/types/content-plugin.ts`
- Modify: `packages/shared/src/types/index.ts`
- Test: `packages/shared/src/types/agent-modules.test.ts`
- Test: `packages/shared/src/types/agent-plugin.test.ts`

- [ ] **Step 1: 先写失败测试**：覆盖缺失 `activation` 归一化为 `message-explicit`、显式 `session-toggle` 保留、旧 Session 策略安全默认和全限定插件模块 ID。
- [ ] **Step 2: 运行测试确认失败**：`bun test packages/shared/src/types/agent-modules.test.ts packages/shared/src/types/agent-plugin.test.ts`；预期出现缺少 `activation` 字段或解析断言失败。
- [ ] **Step 3: 实现最小合同**：新增 `AgentModuleActivationMode`、`WorkspaceToolEntry`、`AgentSessionModuleCatalog`，在 parser 中补兼容默认值，更新 clone/normalize 函数和 shared 导出。
  ```ts
  export type AgentModuleActivationMode = 'message-explicit' | 'session-toggle'
  export interface AgentSessionModuleCatalog { sessionId: string; policy: AgentSessionModulePolicy; entries: WorkspaceToolEntry[]; catalogRevision: number; refreshedAt: number }
  ```
- [ ] **Step 4: 运行测试确认通过**：同一命令输出全部 PASS，并检查旧 manifest 的 warning 不会导致拒绝。

### Task 2: 建立统一会话准入 helper

**Files:**
- Modify: `packages/shared/src/types/agent-session-eligibility.ts`
- Test: `packages/shared/src/types/agent-session-eligibility.test.ts`
- Modify: `apps/electron/src/main/lib/agent-session-visibility.ts`
- Test: `apps/electron/src/main/lib/agent-session-visibility.test.ts`

- [ ] **Step 1: 写 BDD 矩阵测试**：普通会话、探索分支、归档、自动化、委派、内部 Design/Canvas、无项目和 toolMode 受限场景分别断言模块准入。
- [ ] **Step 2: 运行失败测试**：`bun test packages/shared/src/types/agent-session-eligibility.test.ts apps/electron/src/main/lib/agent-session-visibility.test.ts`。
- [ ] **Step 3: 实现 `getAgentModuleEligibility(moduleId, session, projectId)`**：返回 `{ allowed: boolean; reason?: string }`，并让主进程现有 `isEligibleProjectAgent()` 作为项目级基础条件。
  ```ts
  export function getAgentModuleEligibility(moduleId: string, session: ProjectAgentEligibilityFields, projectId: string): { allowed: boolean; reason?: string } {
    const projectEligible = isAgentSessionUserVisible(session) && session.workspaceId === projectId && !session.archived
    if (!projectEligible) return { allowed: false, reason: 'AGENT_MODULE_SESSION_INELIGIBLE' }
    if (moduleId === 'server-ops') return { allowed: true }
    return { allowed: true }
  }
  ```
- [ ] **Step 4: 运行通过测试**：同一命令；同时确认探索分支对交互设计、影像创作、画布不再被错误拒绝。

### Task 3: 把 Session 策略接入 module resolver

**Files:**
- Modify: `apps/electron/src/main/lib/agent-modules/module-skill-resolver.ts`
- Test: `apps/electron/src/main/lib/agent-modules/module-skill-resolver.test.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Test: `apps/electron/src/main/lib/agent-orchestrator.test.ts`

- [ ] **Step 1: 写失败测试**：没有 `explicitModuleIds` 但策略开启 `canvas` 时解析出画布模块；策略关闭时返回 `AGENT_MODULE_DISABLED`；旧显式消息模式仍可用。
- [ ] **Step 2: 运行失败测试**：`bun test apps/electron/src/main/lib/agent-modules/module-skill-resolver.test.ts apps/electron/src/main/lib/agent-orchestrator.test.ts`。
- [ ] **Step 3: 修改 `resolveSelectedModuleIds()`**：按 `session-toggle`/`message-explicit` 分流，过滤自动模块、禁用模块和不可用插件，生成稳定排序的 `activeModuleIds`。
  ```ts
  const explicit = new Set(input.explicitModuleIds ?? [])
  return input.catalog.filter((module) => {
    if (isAutomaticAgentModuleId(module.id) || input.policy.disabledModuleIds.includes(module.id)) return false
    return module.activation === 'session-toggle' ? input.policy.enabledModuleIds.includes(module.id) || explicit.has(module.id) : explicit.has(module.id)
  }).map((module) => module.id)
  ```
- [ ] **Step 4: 在 orchestrator preflight 读取最新策略**：校验 `modulePolicyRevision`，把解析结果传给现有 `createAgentModuleToolPolicy()` 和 Run Journal。
- [ ] **Step 5: 运行通过测试**：同一命令，并断言 `moduleIds: []` 不再掩盖已开启 Session 模块。

### Task 4: 接入插件激活模式和资源快照

**Files:**
- Modify: `packages/plugin-sdk/src/contracts.ts`
- Modify: `packages/plugin-sdk/src/schema.ts`
- Modify: `apps/electron/src/main/lib/agent-plugins/content-module-runtime.ts`
- Modify: `apps/electron/src/main/lib/agent-modules/plugin-registry.ts`
- Test: `apps/electron/src/main/lib/agent-plugins/content-plugin-service.test.ts`
- Test: `apps/electron/src/main/lib/agent-modules/plugin-registry.test.ts`

- [ ] **Step 1: 写失败测试**：旧插件默认显式模式；新内容插件的 session-toggle 模块出现在目录；全局关闭、hash 不匹配和资源归属错误不能进入运行快照。
- [ ] **Step 2: 运行失败测试**：`bun test apps/electron/src/main/lib/agent-plugins/content-plugin-service.test.ts apps/electron/src/main/lib/agent-modules/plugin-registry.test.ts`。
- [ ] **Step 3: 扩展 SDK schema**：接受两个 activation 值，新模板必须显式写出 activation；SDK 不依赖宿主 shared 包，旧包由宿主兼容层补值。
  ```ts
  export type PluginModuleActivationMode = 'message-explicit' | 'session-toggle'
  export interface PluginModule { id: string; displayName: string; activation: PluginModuleActivationMode; skills: string[]; prompts: string[]; styles?: string[] }
  ```
- [ ] **Step 4: 投影全限定 ID 和 activation**：`content-module-runtime.ts` 只返回已验证资源，保留 `pluginId`、`packageHash`、`moduleVersion`。
- [ ] **Step 5: 运行通过测试**：同一命令，并确认 `toolRefs` 没有进入 trusted tool 列表。

### Task 5: 新增 Session 模块目录 IPC

**Files:**
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/index.ts`
- Modify: `apps/electron/src/renderer/components/agent/agent-module-loader.ts`
- Modify: `apps/electron/src/renderer/atoms/agent-module-atoms.ts`
- Create: `apps/electron/src/main/lib/agent-module-catalog-ipc.test.ts`
- Test: `apps/electron/src/renderer/components/agent/agent-module-loader.test.ts`

- [ ] **Step 1: 写失败测试**：目录投影包含 `enabledForSession`、`panelOpen` 默认 false、插件版本/hash 和 canonical disabledReason；过期 revision 写入被拒绝。
- [ ] **Step 2: 运行失败测试**：`bun test apps/electron/src/main/lib/agent-module-catalog-ipc.test.ts apps/electron/src/renderer/components/agent/agent-module-loader.test.ts`。
- [ ] **Step 3: 实现 `GET_SESSION_MODULE_CATALOG`**：主进程校验可见 Session，合并模块注册表、策略、插件健康和准入 helper。
  ```ts
  interface AgentSessionModuleCatalogService { getForSession(sessionId: string): Promise<AgentSessionModuleCatalog> }
  declare const agentSessionModuleCatalogService: AgentSessionModuleCatalogService
  ipcMain.handle(AGENT_IPC_CHANNELS.GET_SESSION_MODULE_CATALOG, async (_, sessionId: string) => {
    return agentSessionModuleCatalogService.getForSession(sessionId)
  })
  ```
- [ ] **Step 4: 更新 loader 代次**：目录和策略以同一 `catalogRevision` 发布，迟到结果不得覆盖当前 Session。
- [ ] **Step 5: 运行通过测试**：同一命令，并验证 renderer 没有直接读插件目录或调用任意路径。

### Task 6: 重构右侧工具栏

**Files:**
- Modify: `apps/electron/src/renderer/components/app-shell/WorkspaceTools.tsx`
- Modify: `apps/electron/src/renderer/components/app-shell/WorkspaceToolRail.tsx`
- Modify: `apps/electron/src/renderer/atoms/workspace-tools.ts`
- Modify: `apps/electron/src/renderer/components/agent/AgentModuleBar.tsx`
- Modify: `apps/electron/src/renderer/components/agent/AgentView.tsx`
- Test: `apps/electron/src/renderer/components/app-shell/WorkspaceTools.test.tsx`
- Test: `apps/electron/src/renderer/atoms/workspace-tools.test.ts`
- Test: `apps/electron/src/renderer/components/agent/AgentModuleBar.test.tsx`

- [ ] **Step 1: 写失败 UI 测试**：点击条目主体只打开面板；点击开关只更新 Session 策略；探索分支显示可用；输入框不再渲染 `agent-module-picker`。
- [ ] **Step 2: 运行失败测试**：`bun test apps/electron/src/renderer/components/app-shell/WorkspaceTools.test.tsx apps/electron/src/renderer/atoms/workspace-tools.test.ts apps/electron/src/renderer/components/agent/AgentModuleBar.test.tsx`。
- [ ] **Step 3: 将 `WorkspaceToolRail` 输入改为 `WorkspaceToolEntry[]`**：静态 `WorkspaceToolId` 继续用于导航，动态模块使用 `moduleId`。
  ```ts
  interface WorkspaceToolRailProps { items: WorkspaceToolEntry[]; onOpen: (entry: WorkspaceToolEntry) => void; onToggleModule: (moduleId: string) => void }
  ```
- [ ] **Step 4: 增加可访问开关**：提供 `aria-pressed`、`aria-label`、键盘 Enter/Space、加载态和失败重试；关闭能力不关闭浏览已有面板。
- [ ] **Step 5: 从 `AgentView.inputToolbarItems` 删除 `messageMode`**：普通发送不再向草稿写入模块 mention，保留旧草稿兼容读取。
- [ ] **Step 6: 运行通过测试**：同一命令，并用 renderer smoke 验证窄窗口、深浅主题和焦点恢复。

### Task 7: 队列、重试和恢复采用能力快照

**Files:**
- Modify: `apps/electron/src/renderer/lib/agent-message-queue.ts`
- Modify: `apps/electron/src/main/lib/agent-queue-routing.ts`
- Modify: `apps/electron/src/main/lib/agent-recovery-context.ts`
- Modify: `apps/electron/src/main/lib/agent-run-recovery.ts`
- Test: `apps/electron/src/renderer/lib/agent-message-queue.test.ts`
- Create: `apps/electron/src/main/lib/agent-queue-routing.module-policy.test.ts`
- Test: `apps/electron/src/main/lib/agent-recovery-context.test.ts`

- [ ] **Step 1: 写失败测试**：策略 revision 变化后排队消息不会静默扩权；关闭模块后显示 `AGENT_MODULE_POLICY_CHANGED`；恢复缺少 hash 或准入证据时 fail closed。
- [ ] **Step 2: 运行失败测试**：`bun test apps/electron/src/renderer/lib/agent-message-queue.test.ts apps/electron/src/main/lib/agent-queue-routing.module-policy.test.ts apps/electron/src/main/lib/agent-recovery-context.test.ts`。
- [ ] **Step 3: 保存提交时模块快照**：记录 revision、module IDs、version、packageHash 和 `selectionSource`。
  ```ts
  interface AgentQueuedModuleSnapshot { policyRevision: number; moduleIds: string[]; modules: Array<{ id: string; version: string; packageHash?: string }>; selectionSource: 'session-policy' | 'message-explicit' | 'legacy' }
  ```
- [ ] **Step 4: 出队/恢复前重新校验**：不匹配时保留原消息和审计，返回可操作错误，不自动改写用户文本。
- [ ] **Step 5: 运行通过测试**：同一命令，并验证重试保留旧消息中的显式 `moduleIds`。

### Task 8: 插件启停、升级、卸载与审计

**Files:**
- Modify: `apps/electron/src/main/lib/agent-modules/plugin-management-service.ts`
- Modify: `apps/electron/src/main/lib/agent-plugins/content-plugin-manager.ts`
- Modify: `apps/electron/src/main/lib/agent-modules/module-run-audit.ts`
- Modify: `apps/electron/src/renderer/components/settings/PluginCenter.tsx`
- Modify: `apps/electron/src/renderer/components/agent/AgentModuleRunAuditView.tsx`
- Test: `apps/electron/src/main/lib/agent-modules/plugin-management-service.test.ts`
- Test: `apps/electron/src/main/lib/agent-modules/module-run-audit.test.ts`
- Test: `apps/electron/src/renderer/components/settings/PluginCenter.test.tsx`

- [ ] **Step 1: 写失败测试**：停用保留 Session ID 但阻断新运行；升级只影响下一轮；卸载保留历史审计；每轮显示实际版本/hash。
- [ ] **Step 2: 运行失败测试**：`bun test apps/electron/src/main/lib/agent-modules/plugin-management-service.test.ts apps/electron/src/main/lib/agent-modules/module-run-audit.test.ts apps/electron/src/renderer/components/settings/PluginCenter.test.tsx`。
- [ ] **Step 3: 实现生命周期状态投影**：安装、全局启用、Session 开启、面板打开分别显示，禁止一个 `active` 字段承载多种含义。
  ```ts
  const entry: WorkspaceToolEntry = {
    id: `module:${module.id}`, kind: 'module-capability', label: module.displayName, icon: module.icon,
    group: module.source === 'installed' ? '插件' : '专业工具', moduleId: module.id,
    activation: module.activation, enabledForSession: policy.enabledModuleIds.includes(module.id),
    panelOpen: openModuleIds.has(module.id), visible: true, surfaceIds: [...module.surfaceIds],
    ...(module.pluginId ? { pluginId: module.pluginId } : {}),
    ...(module.packageHash ? { packageHash: module.packageHash } : {}),
    moduleVersion: module.version,
  }
  ```
- [ ] **Step 4: 让审计读取冻结快照**：只记录摘要和真实调用，不把声明的 `toolRefs` 当作执行事实。
- [ ] **Step 5: 运行通过测试**：同一命令。

### Task 9: 端到端验证和回滚开关

**Files:**
- Create: `apps/electron/scripts/session-module-plugin-activation-smoke.ts`
- Create: `apps/electron/scripts/session-module-plugin-activation-smoke-renderer.tsx`
- Modify: `package.json`
- Modify: `apps/electron/package.json`
- Test: `apps/electron/src/main/lib/agent-modules/module-tool-policy.test.ts`

- [ ] **Step 1: 编写 smoke 场景**：创建普通会话和探索分支，开启画布/影像/交互设计，发送无 `moduleIds` 消息，断言 resolver、tool policy、审计和右侧条目一致；再安装一个 session-toggle 内容插件，验证禁用、升级、卸载和 hash 失效。
- [ ] **Step 2: 运行 smoke 前置测试**：`bun test apps/electron/src/main/lib/agent-modules/module-tool-policy.test.ts`。
- [ ] **Step 3: 接入真实 Electron preload 和 renderer**：脚本使用隔离临时数据根，不调用收费模型，不读用户真实插件或会话目录。
- [ ] **Step 4: 运行 smoke**：`cd apps/electron && bun run scripts/session-module-plugin-activation-smoke.ts`；预期真实 BrowserWindow、主进程 IPC、renderer 条目和策略 CAS 全部通过。
- [ ] **Step 5: 运行完整门槛**：`bun run typecheck`、`bun test`、`bun run electron:build`；全仓已有无关失败必须单独归因，不能用本功能测试通过替代全仓结论。
- [ ] **Step 6: 保留回滚开关**：增加主进程配置 `sessionModuleToggleEnabled`，关闭时隐藏动态开关并回退到旧显式 `moduleIds` 解析；策略和历史数据仍保留，重新开启后可恢复。
  ```ts
  const sessionModuleToggleEnabled = process.env.DUTYDECK_SESSION_MODULE_TOGGLE !== '0'
  const selectedIds = sessionModuleToggleEnabled ? resolveSelectedModuleIds(input) : resolveLegacyExplicitModuleIds(input)
  ```

## 15. 验收标准

### 用户行为

- 右侧工具栏能看到六个内置专业模块和已安装的 session-toggle 插件模块。
- 点击“开启本会话”后，下一条普通消息不携带 `moduleIds` 仍能解析对应模块 Skill、prompt 和宿主工具。
- 面板打开状态与能力开启状态独立可见；只打开面板不会误称 Agent 已获得能力。
- 运行中切换只显示“下一轮生效”，当前运行门禁和审计不改变。
- 输入框底部不再出现“选择模块”流程；旧消息、旧草稿和显式命令仍可重试。

### 插件行为

- 旧插件没有 activation 时保持 message-explicit，不会自动扩权。
- session-toggle 内容插件可以出现在右侧工具栏，但必须先全局启用、通过包校验和当前会话准入。
- 插件停用、升级、卸载、hash 不匹配都有明确不可用状态；不会删除历史审计或静默改写策略。
- 插件 `toolRefs` 永远不能直接让模型调用宿主工具。

### 安全与一致性

- renderer、主进程和恢复入口都使用同一 canonical eligibility 规则。
- 探索分支对交互设计、影像创作、画布的 UI 与后端判断一致；自动化、委派、内部会话不能通过开关获得普通用户能力。
- `modulePolicyRevision` 冲突、队列策略变化、插件版本/hash 变化均 fail closed。
- Run Journal 可还原本轮 policy revision、模块版本/hash、不可用原因和真实工具事件。

### 诊断边界

- 该功能验证“模块是否可调用”，不把 `CANVAS_BINDING_FAILED` 标记为模块权限错误。
- 画布关联仍需单独通过 `agent-canvas-binding-ipc` 的正常路径、损坏数据和诊断日志测试。

## 16. 回滚策略

1. 发现严重回归时把 `sessionModuleToggleEnabled` 设为 false；普通消息恢复旧 `moduleIds` 显式流程，已有策略和审计不删除。
2. 保留 `activation` 和插件包字段的解析兼容；旧版本主进程遇到新字段时按 `message-explicit` 读取，避免旧客户端自动扩权。
3. 不回滚用户 Session JSON、插件安装目录或历史 Journal；只回滚代码和功能开关。
4. 回滚后运行 `bun test` 中的模块 resolver、工具门禁、插件管理、队列恢复和 renderer 工具栏测试，再启动隔离 smoke。

## 17. 自检结果

- 已覆盖：功能目标、非目标、现有代码边界、状态模型、Session policy、插件 activation、动态右侧工具栏、四层 IPC、runtime 数据流、工具门禁、分支/恢复/队列/运行中切换、安装/启停/升级/卸载、迁移、性能、安全、测试、分阶段任务、验收和回滚。
- 计划中的类型名与文件名统一使用 `AgentModuleActivationMode`、`WorkspaceToolEntry`、`AgentSessionModuleCatalog`、`getAgentModuleEligibility`、`GET_SESSION_MODULE_CATALOG`。
- 已检查计划正文，没有空白占位或未定义的函数名。
- 每个任务都给出准确文件路径、失败测试、实现边界和验证命令；产品代码和 Git 提交留到用户选择执行方式后处理。
