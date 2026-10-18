# DutyDeck 模块插件化与 Agent Skill 路由改造实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Canvas、影像、浏览器、终端、交互设计等能力改造成用户可见的模块插件，并让当前 Session 选中的模块稳定映射到对应 Skills、模块提示词和工具，同时保持 Agent 会话、路由、权限、恢复和历史的一致性。

**Architecture:** DutyDeck 保留一个主 Agent 和一个宿主编排层。宿主维护 `WorkContext`、Session 模块策略、Skill/提示词解析、命令回执、权限和运行日志；模块插件只声明界面、Skills、提示词、工具和 Artifact 能力。内置模块先使用与外部插件相同的合同，第三方代码在 API 稳定后通过受限 utility process 接入。用户选择模块只改变当前 Session 的能力范围，不直接执行全部 Skill；明确的模块动作才会触发指定 Skill。

**Tech Stack:** Bun、TypeScript、Electron、React、Jotai、现有 preload/main IPC 四层合同、Pi Agent runtime、JSON/JSONL 原子持久化、Bun test/Vitest 风格测试。

---

## 1. 范围、边界与交付拆分

本总计划拆成三个可独立验收的交付包：

1. **模块协议与 Agent 路由**：共享类型、模块注册、Session 策略、Skill/提示词绑定、命令回执。
2. **聊天模块栏与工作区衔接**：模块显示、选择、`/module`/`@module` 调用、状态条、统一工作上下文和错误态。
3. **插件运行时与可靠恢复**：插件生命周期、权限、Artifact、Run Journal、恢复和版本迁移。

第一阶段不做在线插件市场，也不允许第三方插件直接运行在 Electron 主进程。所有新增能力先以内置插件形式验证合同。

必须保持的兼容行为：

- 原有 `/` Skill 引用继续可用；
- 原有 workspace Skill 启用/禁用继续有效；
- 没有模块策略的旧 Session 默认使用 `auto`，不会因为升级突然减少能力；
- `SKILL.md` 的 frontmatter 版本规则继续遵守，默认 Skill 改动必须递增 patch 版本；
- Pi Agent runtime 仍是唯一 Agent runtime，不引入 Claude Agent SDK；
- 所有 JSON/Session/插件元数据写入继续经过 `safe-file.ts` 的原子写封装。

## 2. 文件和模块边界

### 新增文件

- `packages/shared/src/types/agent-modules.ts`：模块、插件、Session 策略、命令回执、模块激活记录的跨进程类型。
- `packages/shared/src/types/agent-run-journal.ts`：运行日志事件、恢复状态和幂等性类型。
- `apps/electron/src/main/lib/agent-modules/module-registry.ts`：内置模块和已安装插件的注册、查询、版本校验。
- `apps/electron/src/main/lib/agent-modules/module-skill-resolver.ts`：根据 Session 策略解析 Skill、提示词和工具集合。
- `apps/electron/src/main/lib/agent-modules/module-policy-store.ts`：Session/项目模块策略的持久化和迁移。
- `apps/electron/src/main/lib/agent-modules/module-command-bus.ts`：模块命令提交、排队、取消、状态回执。
- `apps/electron/src/main/lib/agent-modules/plugin-host.ts`：插件生命周期、贡献注册和内置插件适配。
- `apps/electron/src/main/lib/agent-modules/plugin-permission-service.ts`：插件能力权限校验。
- `apps/electron/src/main/lib/agent-run-journal.ts`：按运行边界追加事件、扫描未完成运行、创建恢复计划。
- `apps/electron/src/renderer/atoms/agent-module-atoms.ts`：当前 Session 模块选择、模块目录、命令回执和模块运行状态。
- `apps/electron/src/renderer/atoms/work-context-atoms.ts`：项目、Session、Run、工作区和返回入口的派生上下文。
- `apps/electron/src/renderer/components/agent/AgentModuleBar.tsx`：输入框上方的模块栏。
- `apps/electron/src/renderer/components/agent/AgentModulePicker.tsx`：模块搜索、启用、禁用和组合选择。
- `apps/electron/src/renderer/components/agent/AgentModuleReceipt.tsx`：消息中的模块调用和结果回执。
- `apps/electron/src/renderer/components/agent/AgentStatusBar.tsx`：统一 Agent 状态和下一步动作。
- `apps/electron/src/renderer/components/agent-skills/ModuleCatalog.tsx`：Skills 页面中的模块目录和详情。

### 修改文件

- `packages/shared/src/types/index.ts`：导出新增共享类型。
- `packages/shared/src/types/agent.ts`：为 `AgentSendInput`、`SDKUserMessage`、`SkillActivation` 增加模块策略和来源字段，保持字段可选以兼容旧 JSONL。
- `apps/electron/src/main/ipc.ts`：注册模块目录、Session 策略、命令回执、取消和恢复检查 IPC handler。
- `apps/electron/src/preload/index.ts`：暴露与 `ipc.ts` 一致的类型安全 bridge。
- `apps/electron/src/renderer/atoms/workspace-tools.ts`：将工具请求从“导航变化即清理”改为 Session 命令和工作区路由。
- `apps/electron/src/renderer/components/app-shell/AppShell.tsx`：使用 `WorkContext` 派生布局，保留工具返回当前 Agent 任务入口。
- `apps/electron/src/renderer/components/agent/AgentView.tsx`：挂载模块栏、状态条、模块上下文和回执；Composer 阻塞时保持可见并显示 CTA。
- `apps/electron/src/main/lib/agent-orchestrator.ts`：解析模块策略、注入模块提示词/Skill 引用、记录 module/skill 激活、写入运行日志。
- `apps/electron/src/utility/agent-runtime.ts`：透传模块运行元数据和 Skill 激活事件，不保存新的业务事实源。
- `apps/electron/src/main/lib/agent-session-manager.ts`：读取旧 Session、恢复模块策略和未完成 Run。
- `apps/electron/src/main/lib/agent-prompt-builder.ts`：增加模块路由提示和安全边界，不允许模块提示覆盖宿主权限规则。
- `apps/electron/src/main/lib/agent-session-context-prompt.ts`：生成当前模块和工作上下文的短摘要。
- `apps/electron/src/renderer/components/agent-skills/AgentSkillsView.tsx`：增加模块目录入口，复用现有 Skill/MCP 管理能力。
- `apps/electron/src/renderer/atoms/active-view.ts`：扩展 Agent Skills 视图的模块目录 Tab 类型。
- `apps/electron/src/renderer/atoms/skill-mention-atoms.ts`：保留原有全量 Skill 展示，增加模块绑定 Skill 的派生读取。

## 3. 目标数据模型

### 3.1 模块与插件合同

在 `packages/shared/src/types/agent-modules.ts` 中定义以下合同。插件实现使用稳定 ID，UI 使用人类可读名称。

```ts
export type AgentModuleMode = 'auto' | 'available' | 'pinned'
export type AgentModuleInvocationMode = 'available' | 'pinned' | 'invoke'
export type AgentModuleScope = 'session' | 'project' | 'global'
export type AgentModuleContribution = 'surface' | 'skill' | 'prompt' | 'tool' | 'artifact'

export interface AgentModuleManifest {
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
  minHostVersion?: string
}

export interface AgentSessionModulePolicy {
  mode: AgentModuleMode
  enabledModuleIds: string[]
  disabledModuleIds: string[]
  pinnedModuleIds: string[]
  revision: number
  updatedAt: number
}

export interface AgentModuleActivation {
  moduleId: string
  moduleVersion: string
  mode: AgentModuleMode
  invocationMode?: AgentModuleInvocationMode
  skillRefs: string[]
  promptRefs: string[]
  activatedAt: number
  sessionId: string
  policyRevision: number
}
```

约束：`auto` 表示沿用现有能力发现；`available` 表示模块可被 Agent 选用；`pinned` 表示任务匹配时必须优先使用该模块。点击模块不会自动执行全部 `skillRefs`，明确的模块命令才使用 `mentionedSkills` 强制调用某个 Skill。

### 3.2 模块命令回执

```ts
export type AgentModuleCommandStatus = 'draft' | 'queued' | 'running' | 'applied' | 'canceled' | 'expired' | 'failed'

export interface AgentModuleCommand {
  commandId: string
  sessionId: string
  moduleId: string
  capabilityId: string
  baseRevision: number
  invocationMode: AgentModuleInvocationMode
  deliveryMode: 'draft' | 'enqueue' | 'auto'
  requestSummary: string
  input: Record<string, unknown>
  idempotencyKey: string
  status: AgentModuleCommandStatus
  createdAt: number
  updatedAt: number
  errorCode?: string
}
```

命令执行前由宿主校验模块、Session、权限、revision 和幂等键。`invocationMode: invoke` 只用于用户明确触发的单次模块动作；它不改变 Session 的长期策略。Agent 不能通过自然语言伪造 `moduleId` 或权限票据。

### 3.3 Run Journal

`packages/shared/src/types/agent-run-journal.ts` 定义 `user_turn`、`assistant_turn`、`tool_started`、`tool_result`、`permission_requested`、`permission_resolved`、`checkpoint`、`run_completed`、`run_failed`、`run_stopped` 事件。每个事件包含 `runId`、`sequence`、`parentEventId`、`branchId`、`idempotencyKey` 和 `createdAt`。

JSONL 展示记录和 Pi artifact 作为投影或缓存，DutyDeck Run Journal 作为运行事实源。事件只在工具开始/结束、审批、检查点和终态写盘，不逐 token 写盘。

## 4. 分阶段实施任务

### Task 1: 建立共享模块、命令和 Journal 类型

**Files:**
- Create: `packages/shared/src/types/agent-modules.ts`
- Create: `packages/shared/src/types/agent-run-journal.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/shared/src/types/agent.ts`
- Test: `packages/shared/src/types/agent-modules.test.ts`
- Test: `packages/shared/src/types/agent-run-journal.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖以下规则：manifest 缺少 `id`/`version`/`apiVersion` 时拒绝；模块策略去重并保持稳定顺序；`pinned` 模式只能从 `enabledModuleIds` 中选择；旧缺失策略默认得到 `auto`；Journal sequence 必须递增；同一 `idempotencyKey` 不得生成第二次副作用事件。

- [ ] **Step 2: 运行测试确认失败**

```bash
bun test packages/shared/src/types/agent-modules.test.ts packages/shared/src/types/agent-run-journal.test.ts
```

预期：因类型和校验函数尚未存在而失败。

- [ ] **Step 3: 实现共享类型和纯函数校验**

新增 `parseAgentModuleManifest`、`normalizeAgentSessionModulePolicy`、`isJournalEventSequenceValid` 和 `isIdempotentReplay`。所有新增函数写清晰中文注释，输入输出使用接口类型，不使用 `any`。

- [ ] **Step 4: 运行测试确认通过**

```bash
bun test packages/shared/src/types/agent-modules.test.ts packages/shared/src/types/agent-run-journal.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/types/agent-modules.ts packages/shared/src/types/agent-run-journal.ts packages/shared/src/types/index.ts packages/shared/src/types/agent.ts packages/shared/src/types/agent-modules.test.ts packages/shared/src/types/agent-run-journal.test.ts
git commit -m "新增模块插件与 Agent 运行合同"
```

### Task 2: 建立内置模块注册表和 Skill 绑定

**Files:**
- Create: `apps/electron/src/main/lib/agent-modules/module-registry.ts`
- Create: `apps/electron/src/main/lib/agent-modules/module-skill-resolver.ts`
- Create: `apps/electron/src/main/lib/agent-modules/module-registry.test.ts`
- Create: `apps/electron/src/main/lib/agent-modules/module-skill-resolver.test.ts`
- Modify: `apps/electron/src/main/lib/agent-workspace-manager.ts`
- Modify: `apps/electron/src/main/lib/agent-prompt-builder.ts`

- [ ] **Step 1: 为内置模块写注册表测试**

注册以下模块：`canvas`、`visual-production`、`interaction-design`、`browser`、`terminal`。每个模块必须包含用户可见名称、Skill 引用、提示词引用、工具引用、界面 surface 和权限列表。测试缺失 Skill 时返回 `skill_unavailable`，不会静默切换到另一个模块。

- [ ] **Step 2: 实现注册表和解析器**

`module-registry.ts` 提供 `listModules()`、`getModule(id)`、`resolveModuleVersion(id, version)`。`module-skill-resolver.ts` 提供：

```ts
resolveActiveModuleContext(input: {
  workspaceSlug: string
  sessionId: string
  policy: AgentSessionModulePolicy
  explicitModuleIds?: string[]
}): Promise<{
  modules: AgentModuleActivation[]
  skillMentions: string[]
  promptFragments: string[]
  allowedToolNames: string[]
  unavailable: Array<{ moduleId: string; reason: string }>
}>
```

Skill 解析必须复用 workspace Skill 目录和现有启用状态；只把 Skill ID、短摘要和按需引用传给 Agent，避免每轮把所有 `SKILL.md` 全文塞入上下文。

- [ ] **Step 3: 在 prompt builder 中加入模块边界**

增加模块摘要块，明确：当前启用模块、可调用 Skill、不能调用的模块和权限限制。宿主系统规则、项目指令、权限规则优先级高于模块提示词。模块提示词不能覆盖项目 `AGENTS.md` 或宿主安全规则。

- [ ] **Step 4: 运行测试**

```bash
bun test apps/electron/src/main/lib/agent-modules/module-registry.test.ts apps/electron/src/main/lib/agent-modules/module-skill-resolver.test.ts apps/electron/src/main/lib/agent-session-context-prompt.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add apps/electron/src/main/lib/agent-modules apps/electron/src/main/lib/agent-workspace-manager.ts apps/electron/src/main/lib/agent-prompt-builder.ts
git commit -m "建立模块注册与 Skill 绑定解析"
```

### Task 3: 持久化 Session 模块策略和迁移旧会话

**Files:**
- Create: `apps/electron/src/main/lib/agent-modules/module-policy-store.ts`
- Create: `apps/electron/src/main/lib/agent-modules/module-policy-store.test.ts`
- Modify: `apps/electron/src/main/lib/agent-session-manager.ts`
- Modify: `packages/shared/src/types/agent.ts`

- [ ] **Step 1: 写迁移和并发测试**

覆盖：旧 Session 缺少 `modulePolicy` 时读取为 `auto`；重复模块 ID 被去重；revision 过期写入被拒绝；禁用模块优先于自动选择；项目默认策略不会覆盖已有 Session 策略；损坏 JSON 恢复为上一次有效快照并返回错误码。

- [ ] **Step 2: 实现原子策略存储**

策略使用 Session 元数据现有持久化路径，通过 `safe-file.ts` 原子写入。写入内容至少包含 `schemaVersion`、`sessionId`、`modulePolicy` 和更新时间。不得另建第二套 Session 目录。

- [ ] **Step 3: 接入 Session manager**

创建 Session 时写入默认 `auto`；加载时执行一次迁移；删除或归档 Session 时清理其未完成模块命令，但保留可审计的失败回执。

- [ ] **Step 4: 运行测试并提交**

```bash
bun test apps/electron/src/main/lib/agent-modules/module-policy-store.test.ts apps/electron/src/main/lib/agent-internal-session-boundaries.test.ts
git add apps/electron/src/main/lib/agent-modules/module-policy-store.ts apps/electron/src/main/lib/agent-modules/module-policy-store.test.ts apps/electron/src/main/lib/agent-session-manager.ts packages/shared/src/types/agent.ts
git commit -m "为 Agent 会话增加模块策略持久化"
```

### Task 4: 接入 IPC 四层合同和模块命令总线

**Files:**
- Create: `apps/electron/src/main/lib/agent-modules/module-command-bus.ts`
- Create: `apps/electron/src/main/lib/agent-modules/module-command-bus.test.ts`
- Modify: `packages/shared/src/types/agent-modules.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/index.ts`
- Create: `apps/electron/src/preload/agent-modules-preload.test.ts`

- [ ] **Step 1: 定义 IPC 通道**

增加 `GET_AGENT_MODULES`、`GET_SESSION_MODULE_POLICY`、`SET_SESSION_MODULE_POLICY`、`SUBMIT_AGENT_MODULE_COMMAND`、`CANCEL_AGENT_MODULE_COMMAND`、`GET_AGENT_MODULE_COMMANDS`、`GET_AGENT_RUN_RECOVERY`。请求和响应类型全部来自 `@dutydeck/shared`。

- [ ] **Step 2: 写 handler 和 bridge 测试**

测试：不存在模块、没有权限、Session 不属于当前项目、base revision 过期、重复 idempotency key、取消已完成命令和后台 Session 命令隔离。

- [ ] **Step 3: 实现命令总线**

`module-command-bus.ts` 把命令写入 Session outbox，状态按 `draft → queued → running → applied/failed/canceled/expired` 更新。实际 Agent 调用统一转给 `agent-orchestrator.ts` 的现有 `sendMessage`/`sendQueuedMessage`，不创建第二个 Agent runtime。

- [ ] **Step 4: 运行 IPC 回归**

```bash
bun test apps/electron/src/preload/agent-modules-preload.test.ts apps/electron/src/main/lib/agent-modules/module-command-bus.test.ts apps/electron/src/main/lib/agent-renderer-session-access.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/types/agent-modules.ts apps/electron/src/main/lib/agent-modules/module-command-bus.ts apps/electron/src/main/lib/agent-modules/module-command-bus.test.ts apps/electron/src/main/ipc.ts apps/electron/src/preload/index.ts apps/electron/src/preload/agent-modules-preload.test.ts
git commit -m "接入模块策略与命令回执 IPC"
```

### Task 5: 将模块策略注入 Agent 和 Skill 激活记录

**Files:**
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `apps/electron/src/main/lib/agent-service.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify: `apps/electron/src/main/lib/agent-session-context-prompt.ts`
- Modify: `apps/electron/src/main/lib/agent-prompt-builder.ts`
- Modify: `apps/electron/src/utility/agent-runtime.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.test.ts`
- Modify: `apps/electron/src/main/lib/agent-session-context-prompt.test.ts`

- [ ] **Step 1: 扩展 Agent 输入和 Skill 激活类型**

给共享的 `AgentSendInput`、main 层的 `AgentRunInput` 别名和队列消息增加可选的 `moduleActivations`、`moduleCommandId`、`modulePolicyRevision`。给 `SkillActivation` 增加可选 `moduleId` 和 `activationMode`，保留旧 `source` 值兼容历史记录。

- [ ] **Step 2: 写路由测试**

测试以下四种路由路径，其中 `invocationMode` 是单次运行字段，`AgentModuleMode` 仍只表示 Session 长期策略：

```text
auto：根据当前上下文选择可用模块
available：模块可用但不强制调用 Skill
pinned：任务匹配时必须优先使用固定模块
invoke：用户明确点击模块动作，强制调用指定 Skill
```

另测：模块 Skill 不存在时返回可执行错误；模块已禁用时拒绝命令；用户显式 `/skill` 引用仍按原链路工作；普通对话不增加全量 Skill 正文。

- [ ] **Step 3: 实现动态注入**

`sendMessage` 和 `sendQueuedMessage` 在构造 prompt 前调用 `resolveActiveModuleContext`。将模块短摘要写入 prompt，将明确的 `invoke` Skill 传给现有 `mentionedSkills`/`skillMentions`，并在 `onSkillActivated` 中写入 moduleId。用户可见历史只保存原始用户消息和结构化模块元数据，不保存重复的内部 prompt 工程块。

- [ ] **Step 4: 验证 Agent runtime 透传**

runtime 只透传 `moduleCommandId`、激活事件和回执，不在内存中建立第二份模块状态。检查 Pi session resume、retry、queue message 和 compact 后模块策略仍然一致。

- [ ] **Step 5: 运行测试并提交**

```bash
bun test apps/electron/src/main/lib/agent-orchestrator.test.ts apps/electron/src/main/lib/agent-session-context-prompt.test.ts apps/electron/src/utility/agent-runtime.test.ts
git add packages/shared/src/types/agent.ts apps/electron/src/main/lib/agent-orchestrator.ts apps/electron/src/main/lib/agent-session-context-prompt.ts apps/electron/src/main/lib/agent-prompt-builder.ts apps/electron/src/utility/agent-runtime.ts
git commit -m "让 Agent 按 Session 模块策略调用 Skills"
```

### Task 6: 建立统一 WorkContext 和工作区路由

**Files:**
- Create: `apps/electron/src/renderer/atoms/work-context-atoms.ts`
- Create: `apps/electron/src/renderer/atoms/work-context-atoms.test.ts`
- Modify: `apps/electron/src/renderer/atoms/workspace-tools.ts`
- Modify: `apps/electron/src/renderer/components/app-shell/AppShell.tsx`
- Modify: `apps/electron/src/renderer/atoms/agent-atoms.ts`

- [ ] **Step 1: 写路由测试**

覆盖：有当前 Agent Session 时模块 surface 进入右侧工作区；无 Session 时进入全屏并显示关联任务入口；切换 Session 不会执行旧命令；切换 Tab 不会自动删除后台命令；用户明确取消时才清理命令。

- [ ] **Step 2: 定义 `WorkContext`**

```ts
export interface WorkContext {
  projectId: string | null
  sessionId: string | null
  runId: string | null
  surfaceId: string | null
  activeModuleIds: string[]
  returnRoute: 'agent' | 'project' | 'module'
  revision: number
}
```

由 Session、当前路由和模块策略派生，不允许各个组件自行拼接项目和 Session。

- [ ] **Step 3: 修正 workspace tool 生命周期**

把 `workspaceToolRequestsAtom` 变成命令 outbox 的 UI 投影。导航变化只改变前台焦点，不再直接撤销尚未完成的命令；取消按钮调用 `CANCEL_AGENT_MODULE_COMMAND`。右侧工作区顶部显示任务名称、模块、运行状态和返回 Agent。

- [ ] **Step 4: 运行 UI atom 测试并提交**

```bash
bun test apps/electron/src/renderer/atoms/work-context-atoms.test.ts apps/electron/src/renderer/atoms/workspace-tools.test.ts
git add apps/electron/src/renderer/atoms/work-context-atoms.ts apps/electron/src/renderer/atoms/work-context-atoms.test.ts apps/electron/src/renderer/atoms/workspace-tools.ts apps/electron/src/renderer/components/app-shell/AppShell.tsx apps/electron/src/renderer/atoms/agent-atoms.ts
git commit -m "统一 Agent 工作上下文与工具路由"
```

### Task 7: 实现聊天模块栏、模块目录和模块调用语法

**Files:**
- Create: `apps/electron/src/renderer/atoms/agent-module-atoms.ts`
- Create: `apps/electron/src/renderer/components/agent/AgentModuleBar.tsx`
- Create: `apps/electron/src/renderer/components/agent/AgentModulePicker.tsx`
- Create: `apps/electron/src/renderer/components/agent-skills/ModuleCatalog.tsx`
- Create: `apps/electron/src/renderer/components/agent/AgentModuleReceipt.tsx`
- Modify: `apps/electron/src/renderer/components/agent/AgentView.tsx`
- Modify: `apps/electron/src/renderer/components/agent-skills/AgentSkillsView.tsx`
- Modify: `apps/electron/src/renderer/atoms/active-view.ts`
- Modify: `apps/electron/src/renderer/atoms/skill-mention-atoms.ts`
- Test: `apps/electron/src/renderer/components/agent/AgentModuleBar.test.tsx`
- Test: `apps/electron/src/renderer/components/agent/AgentModulePicker.test.tsx`

- [ ] **Step 1: 写模块栏交互测试**

测试默认显示“自动选择”；点击 Canvas 后 Session 策略变为 `pinned`；再次点击取消固定；选择多个模块显示组合；模块不可用时展示原因且不改变策略；键盘可聚焦、Enter 可切换、Esc 可关闭目录。

- [ ] **Step 2: 实现模块栏**

输入框上方显示 4 个核心模块和“更多”。模块栏只修改 Session policy，不直接执行。模块卡片显示名称、图标、配置状态、权限提示和当前模式。

- [ ] **Step 3: 支持 `/module` 和 `@module`**

在现有 RichTextInput 解析器中增加模块 mention，复用 `mentionedSkills` 的解析结构但使用独立字段。`/canvas 创建分镜` 生成 `invocationMode: invoke` 的模块命令；普通点击只生成 `available/pinned` 策略变更。

- [ ] **Step 4: 显示模块调用回执**

每条 Agent 结果显示“已使用：画布 / 影像”等模块标签、具体 Skill、命令状态和可回到工作区的按钮。历史消息读取缺失字段时按普通消息展示。

- [ ] **Step 5: 将模块目录嵌入 Agent Skills 页面**

新增“模块”Tab，复用已有搜索、工作区选择、Skill 详情和 MCP 状态组件。模块详情显示绑定 Skills、提示词摘要、工具、权限、配置状态和版本。

- [ ] **Step 6: 运行测试并提交**

```bash
bun test apps/electron/src/renderer/components/agent/AgentModuleBar.test.tsx apps/electron/src/renderer/components/agent/AgentModulePicker.test.tsx apps/electron/src/renderer/atoms/skill-mention-atoms.test.ts
git add apps/electron/src/renderer/atoms/agent-module-atoms.ts apps/electron/src/renderer/components/agent/AgentModuleBar.tsx apps/electron/src/renderer/components/agent/AgentModulePicker.tsx apps/electron/src/renderer/components/agent/AgentModuleReceipt.tsx apps/electron/src/renderer/components/agent-skills/ModuleCatalog.tsx apps/electron/src/renderer/components/agent/AgentView.tsx apps/electron/src/renderer/components/agent-skills/AgentSkillsView.tsx apps/electron/src/renderer/atoms/active-view.ts apps/electron/src/renderer/atoms/skill-mention-atoms.ts
git commit -m "增加聊天模块栏与模块调用回执"
```

### Task 8: 统一 Agent 状态条和阻塞态 CTA

**Files:**
- Create: `apps/electron/src/renderer/components/agent/AgentStatusBar.tsx`
- Create: `apps/electron/src/renderer/lib/agent-run-status.ts`
- Create: `apps/electron/src/renderer/lib/agent-run-status.test.ts`
- Modify: `apps/electron/src/renderer/components/agent/AgentView.tsx`
- Modify: `apps/electron/src/renderer/atoms/agent-atoms.ts`

- [ ] **Step 1: 定义派生状态**

将现有 stream、permission、AskUser、Plan、hydration、retry、background 状态派生为：`recovering`、`queued`、`running`、`waiting_permission`、`waiting_answer`、`background_waiting`、`completed`、`failed`、`stopping`。

- [ ] **Step 2: 写状态优先级测试**

测试等待授权优先于运行中、恢复中优先于历史完成、413 映射为 `failed` 且显示压缩上下文 CTA、Composer 在所有阻塞态保持可见但按状态禁用。

- [ ] **Step 3: 实现状态条和动作**

每种状态只显示一个主要动作。失败状态显示错误代码和重试/新建任务；等待回答显示回答入口；没有模型显示配置入口；恢复状态显示恢复步骤。

- [ ] **Step 4: 运行测试并提交**

```bash
bun test apps/electron/src/renderer/lib/agent-run-status.test.ts apps/electron/src/renderer/atoms/agent-atoms.test.ts
git add apps/electron/src/renderer/components/agent/AgentStatusBar.tsx apps/electron/src/renderer/lib/agent-run-status.ts apps/electron/src/renderer/lib/agent-run-status.test.ts apps/electron/src/renderer/components/agent/AgentView.tsx apps/electron/src/renderer/atoms/agent-atoms.ts
git commit -m "统一 Agent 运行状态与阻塞操作"
```

### Task 9: 引入 Run Journal 和恢复检查点

**Files:**
- Create: `apps/electron/src/main/lib/agent-run-journal.ts`
- Create: `apps/electron/src/main/lib/agent-run-journal.test.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify: `apps/electron/src/utility/agent-runtime.ts`
- Modify: `apps/electron/src/main/lib/agent-session-manager.ts`
- Modify: `packages/shared/src/types/agent-run-journal.ts`

- [ ] **Step 1: 写故障恢复测试**

覆盖：用户消息落盘后应用崩溃；tool start 后无 tool result；审批等待中退出；幂等工具可恢复；文件写入/终端命令/媒体生成恢复时必须确认；重复恢复不会生成第二个 tool result；JSONL、Pi artifact 和 Journal runId 不一致时进入需检查状态。

- [ ] **Step 2: 实现边界追加**

在编排器中接入 `appendRunEvent`，只在用户 turn、assistant turn、tool start/result、审批、checkpoint 和终态追加。写入使用原子追加和单进程写队列，保留最近活动 Run 索引，避免逐 token 写盘。

- [ ] **Step 3: 实现恢复扫描**

启动或打开 Session 时扫描未完成 Run，生成 `resume`、`confirm` 或 `abandon` 计划。恢复 UI 通过 IPC 获取计划，用户确认后才重放非幂等操作。

- [ ] **Step 4: 接入 Pi artifact 和 JSONL 对账**

每个 projection 写入 `runId`、`branchId`、`sequence` 和 checksum。对账失败不得覆盖胜者，只显示“需要修复”的回执。

- [ ] **Step 5: 运行测试并提交**

```bash
bun test apps/electron/src/main/lib/agent-run-journal.test.ts apps/electron/src/main/lib/agent-run-lifecycle.test.ts apps/electron/src/main/lib/agent-orchestrator.test.ts
git add packages/shared/src/types/agent-run-journal.ts apps/electron/src/main/lib/agent-run-journal.ts apps/electron/src/main/lib/agent-run-journal.test.ts apps/electron/src/main/lib/agent-orchestrator.ts apps/electron/src/utility/agent-runtime.ts apps/electron/src/main/lib/agent-session-manager.ts
git commit -m "增加 Agent 运行日志与安全恢复检查点"
```

### Task 10: 将现有能力迁移为内置插件

**Files:**
- Create: `apps/electron/src/main/lib/agent-modules/builtin-modules.ts`
- Create: `apps/electron/src/main/lib/agent-modules/builtin-modules.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-agent-execution-service.ts`
- Modify: `apps/electron/src/main/lib/visual-production/agent-run.ts`
- Modify: `apps/electron/src/main/lib/visual-production/media-tool-binding.ts`
- Modify: `apps/electron/src/main/lib/browser-controller.ts`
- Modify: `apps/electron/src/main/lib/agent-server-ops-tool-mode.test.ts`
- Modify: `apps/electron/src/renderer/components/design/CanvasAgentConversation.test.tsx`
- Modify: `apps/electron/src/main/lib/visual-production/media-tool-binding.test.ts`

- [ ] **Step 1: 为 Canvas 编写首个完整内置插件适配**

声明 Canvas surface、分镜/节点 Skills、Canvas tools、Artifact 类型和 `project.files.read/write` 权限。Canvas 现有的 Session、项目绑定、版本和权限校验继续由宿主服务执行。

- [ ] **Step 2: 迁移影像和交互设计**

影像模块绑定 `visual-production` Skills、媒体工具和已冻结的制作配置；交互设计模块绑定其预览、资源和回传命令。模块不能绕过现有媒体来源、任务归属和版本合同。

- [ ] **Step 3: 迁移浏览器和终端**

浏览器声明网络访问权限，终端声明命令执行权限；默认 `available`，涉及外部网络或写入命令时要求宿主确认。工具结果统一写入 Run Journal 和 Artifact/文件变更回执。

- [ ] **Step 4: 验证旧入口兼容**

原有工具栏、右侧面板、Canvas Agent Conversation、影像任务和 `/` Skill 调用都必须通过模块注册表找到同一内置插件，不再维护平行的模块清单。

- [ ] **Step 5: 运行定向回归并提交**

```bash
bun test apps/electron/src/main/lib/agent-modules/builtin-modules.test.ts apps/electron/src/renderer/components/design/CanvasAgentConversation.test.tsx apps/electron/src/main/lib/visual-production/media-tool-binding.test.ts apps/electron/src/main/lib/agent-server-ops-tool-mode.test.ts
git add apps/electron/src/main/lib/agent-modules/builtin-modules.ts apps/electron/src/main/lib/agent-modules/builtin-modules.test.ts apps/electron/src/main/lib/design/canvas-agent-execution-service.ts apps/electron/src/main/lib/visual-production/agent-run.ts apps/electron/src/main/lib/visual-production/media-tool-binding.ts apps/electron/src/main/lib/browser-controller.ts apps/electron/src/main/lib/agent-server-ops-tool-mode.test.ts apps/electron/src/renderer/components/design/CanvasAgentConversation.test.tsx apps/electron/src/main/lib/visual-production/media-tool-binding.test.ts
git commit -m "将核心工作区能力迁移为内置插件"
```

### Task 11: 增加插件生命周期、权限和版本迁移

**Files:**
- Create: `apps/electron/src/main/lib/agent-modules/plugin-host.ts`
- Create: `apps/electron/src/main/lib/agent-modules/plugin-host.test.ts`
- Create: `apps/electron/src/main/lib/agent-modules/plugin-permission-service.ts`
- Create: `apps/electron/src/main/lib/agent-modules/plugin-permission-service.test.ts`
- Modify: `apps/electron/src/main/index.ts`
- Modify: `apps/electron/src/main/lib/config-paths.ts`

- [ ] **Step 1: 实现生命周期**

支持 `discover → validate → install → enable → load → running → disable → uninstall`。插件元数据存储在默认 DutyDeck 数据根的 `plugins/<pluginId>/manifest.json`，项目级插件使用明确的项目目录并通过 locator 校验。

- [ ] **Step 2: 实现默认拒绝权限**

权限至少包括 `project.files.read`、`project.files.write`、`network.request`、`process.spawn`、`secrets.read`、`agent.command.submit`。未声明权限的插件调用直接返回稳定错误码并在模块回执中显示。

- [ ] **Step 3: 实现 API 版本和禁用回滚**

`apiVersion` 不兼容时插件进入 disabled；升级前保存 manifest 和策略快照；升级失败恢复上一版本，不删除 Session、Artifact 或 Journal。插件 ID、版本和 manifest checksum 写入模块激活事件。

- [ ] **Step 4: 限制第三方运行边界**

内置插件允许宿主直接注册；未来第三方插件只能在 utility process 或隔离渲染上下文中运行，通过类型化 RPC 获取宿主能力，禁止直接访问 Electron 主进程和任意文件路径。此阶段不引入在线市场。

- [ ] **Step 5: 运行测试并提交**

```bash
bun test apps/electron/src/main/lib/agent-modules/plugin-host.test.ts apps/electron/src/main/lib/agent-modules/plugin-permission-service.test.ts
git add apps/electron/src/main/lib/agent-modules/plugin-host.ts apps/electron/src/main/lib/agent-modules/plugin-host.test.ts apps/electron/src/main/lib/agent-modules/plugin-permission-service.ts apps/electron/src/main/lib/agent-modules/plugin-permission-service.test.ts apps/electron/src/main/index.ts apps/electron/src/main/lib/config-paths.ts
git commit -m "增加插件生命周期与权限隔离"
```

### Task 12: 完成初始化、错误态、侧栏和子 Agent 语义

**Files:**
- Modify: `apps/electron/src/renderer/components/welcome/WelcomeView.tsx`
- Modify: `apps/electron/src/renderer/components/app-shell/LeftSidebar.tsx`
- Modify: `apps/electron/src/renderer/components/agent/AgentView.tsx`
- Create: `apps/electron/src/renderer/components/agent/AgentRecoveryPanel.tsx`
- Create: `apps/electron/src/renderer/components/agent/AgentRecoveryPanel.test.tsx`

- [ ] **Step 1: WelcomeView 增加失败状态**

初始化超时或失败时显示错误原因、重试和新建任务 CTA，不允许永久停留在加载态。

- [ ] **Step 2: 整理侧栏层级**

视觉上分出当前项目、当前任务、历史会话；子 Agent 显示父任务、子任务状态和返回父任务操作。点击子 Agent 进入观察页，不隐式跳回父会话。

- [ ] **Step 3: 实现恢复面板**

显示 Run、模块、最后事件和恢复动作；非幂等恢复显示确认按钮。恢复失败提供新建分支和保留证据选项。

- [ ] **Step 4: 运行 UI 回归并提交**

```bash
bun test apps/electron/src/renderer/components/agent/AgentRecoveryPanel.test.tsx apps/electron/src/renderer/components/app-shell/LeftSidebar.project-new-session.test.ts
git add apps/electron/src/renderer/components/welcome/WelcomeView.tsx apps/electron/src/renderer/components/app-shell/LeftSidebar.tsx apps/electron/src/renderer/components/agent/AgentView.tsx apps/electron/src/renderer/components/agent/AgentRecoveryPanel.tsx apps/electron/src/renderer/components/agent/AgentRecoveryPanel.test.tsx
git commit -m "补齐模块初始化错误态与任务层级"
```

## 5. 迁移顺序和开关策略

### 阶段 A：只读目录和观测

- 注册内置模块；
- 在 Skills 页面显示模块目录；
- 记录 Agent 当前实际使用的 Skill/module，不改变执行策略；
- 监控模块匹配率、未知模块、Skill 缺失和权限拒绝。

### 阶段 B：Session 模块策略

- 开放模块栏；
- 默认 `auto`；
- 用户选择后采用 `available`；
- 明确选择“只使用此模块”后采用 `pinned`；
- 所有模块命令均生成回执。

### 阶段 C：模块强制调用和工作区衔接

- 支持 `/canvas`、`/media`、`@browser` 等显式调用；
- 统一右侧工作区和返回 Agent；
- 启用模块绑定其 Skills、提示词和工具；
- 高风险操作接入确认。

### 阶段 D：可靠恢复和插件运行时

- Run Journal 进入默认路径；
- 内置插件全部使用同一合同；
- 外部插件只开放受限 utility process 试验；
- 在线市场和自动更新在权限、版本迁移和回滚通过后再评估。

建议增加可关闭的 feature flag：`agentModulesV1`、`agentModuleRoutingV1`、`agentRunJournalV1`。旧开关关闭时继续使用现有入口，但仍保留只读模块观测数据。

## 6. 测试和验收矩阵

### 核心用户场景

1. 用户点击 Canvas，输入“把三张图整理成分镜”：只调用 Canvas 绑定 Skill，创建节点后显示模块回执。
2. 用户启用 Canvas + 影像，输入“创建分镜并生成第二镜头”：先完成 Canvas，再按确认进入影像任务。
3. 用户固定 Canvas，却要求“执行终端命令”：Agent 明确提示当前策略不允许终端，不静默切换。
4. 用户切换到浏览器后返回 Agent：仍回到同一 Session、同一 Run 和同一模块命令。
5. Agent 等待权限或回答：Composer 保留，状态条只显示一个主要 CTA。
6. 应用在 tool start 后退出：重启显示恢复面板；媒体生成、文件写入和终端命令需要确认，不自动重放。
7. Skill 被禁用或版本不兼容：模块显示不可用原因，命令失败可追踪，不调用其他模块代替。
8. 旧 Session 没有模块字段：按 `auto` 正常工作，原有 `/` Skill mention 不受影响。

### 必跑验证

```bash
bun test packages/shared/src/types/agent-modules.test.ts packages/shared/src/types/agent-run-journal.test.ts
bun test apps/electron/src/main/lib/agent-modules apps/electron/src/main/lib/agent-orchestrator.test.ts apps/electron/src/main/lib/agent-run-journal.test.ts
bun test apps/electron/src/renderer/components/agent apps/electron/src/renderer/atoms/workspace-tools.test.ts
bun run typecheck
bun run electron:build
```

涉及 external 清单、preload、主进程或打包规则时，`electron:build` 是最低验证要求。完成后执行一次隔离 Electron UI 烟测：默认自动模式、固定 Canvas、组合 Canvas+影像、禁用模块、等待授权、恢复未完成 Run、窄窗口模块栏。

## 7. 性能、资源和安全评估

- 模块目录只加载 manifest 和摘要；Skill 正文按需读取并缓存 checksum，避免每轮扩大上下文。
- 模块状态使用 Jotai 派生 atom，模块栏只订阅当前 Session，减少全局重渲染。
- Run Journal 只在边界批量写入；按活动 Run 保留索引，历史运行按需加载。
- 模块插件不增加远端轮询；外部服务状态由执行时验证，页面只显示“已配置/未验证”。
- 所有插件权限默认拒绝；第三方代码不能直接调用 Electron 主进程、Node 文件系统或任意命令。
- 模块提示词和 Skill 不能覆盖宿主权限、项目指令、Session 归属和 Artifact 版本合同。
- 失败插件只关闭自身 surface，Agent Session、历史和 Journal 保持可读。

## 8. 完成标准和回滚条件

改造完成必须同时满足：

- 每个内置模块有唯一 manifest、绑定 Skills、提示词、工具、权限和 surface；
- 模块选择能持久化到 Session，并在重启、retry、queue、compact 后保持一致；
- 所有模块命令具有可见状态和 `commandId`；
- Agent 能区分 `available`、`pinned` 和 `invoke`；
- Canvas、影像、浏览器、终端至少各有一条正常路径和一条主要边界测试；
- Run Journal 能发现未完成 Run，且不会自动重放非幂等操作；
- `bun run typecheck`、定向测试和 `bun run electron:build` 通过；
- 关闭 feature flag 后旧 Session 和原有 Skill 调用仍可工作。

出现以下情况时停止扩大范围并回滚对应 feature flag：模块命令跨 Session 执行、旧 Skill 行为改变、Journal 与 JSONL/Pi artifact 产生无法解释的分叉、插件权限绕过、或恢复逻辑可能重复执行非幂等工具。

## 9. 计划自检

- 需求覆盖：模块可见、Session 选择、Skill/提示词绑定、Agent 精确调用、插件生命周期、工作区衔接、错误态、恢复、权限、性能和测试均有对应任务。
- 类型一致性：`AgentModuleManifest`、`AgentSessionModulePolicy`、`AgentModuleCommand`、`AgentModuleActivation` 和 Journal 事件在共享包定义，main/preload/renderer 只引用共享类型。
- 兼容性：旧 `mentionedSkills`、workspace Skill 开关、Pi runtime、旧 Session 和 JSONL 字段均保留兼容路径。
- 范围控制：先完成内置插件和统一合同，再考虑第三方插件和在线市场；不新增外部依赖。

