# 服务器运维插件化迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将服务器运维从宿主内置的硬编码模块迁移为 DutyDeck 官方受信插件，同时保留 SSH、数据库、Redis、Docker、文件、日志、任务、凭据、审批和审计的安全边界。

**Architecture:** 采用两阶段迁移。第一阶段只迁移模块身份、能力注册、会话激活和右侧面板来源，现有主进程服务与 Facade 继续由宿主持有；项目/工作区 Skills 继续由既有 Skill 系统提供，插件只保存稳定 Skill 引用。第二阶段再将运维 runtime 提取为官方 `trusted-runtime` provider，通过宿主 capability broker/RPC 使用受控能力。插件包不能因为声明 `toolRefs`、签名或来自私有源而自动获得网络、凭据、远程命令或数据库写入权限。

**Tech Stack:** Bun、TypeScript、Electron main/preload/renderer、React、Jotai、Pi Agent runtime、现有 Server Ops utility process、JSON/JSONL 原子持久化、Vitest/BDD 风格测试。

---

## 1. 结论先行

服务器运维目前已经有稳定的业务边界，但还不是可迁移的插件：

- `module-registry.ts` 只声明 `server-ops`，真正的工具装配和权限判断仍在 `agent-orchestrator.ts`、`module-tool-policy.ts` 和 `pi-builtin-tools.ts` 中硬编码。
- `server-ops-agent-facade.ts` 与 `server-ops-agent-read-facade.ts` 已经是较好的安全接缝，分别限制远程命令/写能力和只读数据能力，但创建时仍由 Orchestrator 直接闭包捕获服务。
- `AgentPluginHost` 目前只允许主进程注册生命周期适配器；第三方插件仍是 `manifest-only`，`toolRefs` 只是声明，不会带来执行权。现有 Skills 已由项目/工作区系统维护，不应随服务器运维插件复制。
- 服务器运维 Renderer 已经拥有完整工作区、连接、数据库、Docker、文件、日志和任务面板；迁移不应先重写这些 UI，而应先把其 `surfaceId`、IPC handler 和 Session 权限投影到插件 provider。

推荐顺序是“逻辑插件化 → 受信 runtime broker → 再评估第三方 runtime”。这样用户看到的是同一个服务器运维工作区和同一套审批语义，但宿主可以逐步删除专用硬编码；性能上不会因安装插件而启动 SSH、数据库连接或后台轮询，只有当前 Session 真正附着并调用时才创建能力。

## 2. 目标与非目标

### 2.1 目标

1. `server-ops` 具有标准插件身份：`pluginId`、模块版本、包 hash、provider 版本和可见来源。
2. 右侧工具目录、Session `modulePolicy`、Agent 运行快照、Queue/Recovery、调用审计和服务器运维面板都使用同一个 `ModuleActivationSnapshot`。
3. 服务器运维能力由明确的 provider/capability 注册表提供，Orchestrator 不再直接判断 `server-ops` 是否存在来拼装工具。
4. 读、写、凭据、Host Key、数据库表范围、Docker 动作、文件写入和交互任务各自保持最小权限；插件关闭或版本变化时旧闭包 fail closed。
5. 支持安装、启用、会话附着、停用、升级、运行中排空、恢复和回滚，历史会话与审计记录可读。
6. 通过 BDD、主进程集成、utility runtime、真实 Electron/preload smoke 验证迁移行为。

### 2.2 非目标

- 本计划不把任意第三方 Node/原生代码放进主进程或 utility process。
- 本计划不重新设计 SSH 协议、数据库驱动、Docker API、文件传输协议或服务器运维 UI 的领域交互。
- 本计划不改变现有用户授权、逐次写入确认、Host Key 确认、数据库禁表和审计合同。
- 本计划不把浏览器、终端、Automation 等宿主基础能力迁入服务器运维插件。
- 本计划不允许插件自行读取凭据、safeStorage、私钥、服务器配置文件或任意绝对路径。
- 本计划不在未具备 broker 隔离、撤销、签名、审计和升级回退合同前开放第三方 `trusted-runtime`。

## 3. 现状与迁移边界

### 3.1 当前调用链

```text
Session/Agent 输入
  -> agent-orchestrator.ts
     -> module-tool-policy.ts 判断 server-ops
     -> createServerOpsAgentFacade / createServerOpsAgentReadFacade
     -> pi-builtin-tools.ts 注入 server_* / ops_* / data_* 工具
     -> server-ops/* service + server-ops-runtime-client
     -> utility/server-ops/server-ops-runtime-protocol.ts
```

对应的 UI 链路为：

```text
右侧工具目录 / server-ops surface
  -> preload IPC
  -> apps/electron/src/main/lib/server-ops/server-ops-ipc.ts
  -> ServerOpsWorkspace 及其子面板
```

### 3.2 第一阶段迁移边界

第一阶段新增 `ServerOpsPluginAdapter`，由宿主创建并注入：

- 标准插件 manifest 与虚拟/受管安装记录；
- `server-ops` 模块目录投影、Session 激活和 `surfaceId`；
- Agent tool provider：把现有两个 Facade 暴露为能力集合；
- 运行快照、provider 版本/hash、取消信号和 `assertRunActive`；
- 生命周期 start/stop/dispose 与正在运行任务排空；
- 统一审计贡献和健康诊断。

以下内容第一阶段继续归宿主所有：

- `server-ops/*` 领域服务、凭据存储、Host Trust、审计存储；
- `server-ops-runtime-client.ts` 和 utility runtime 协议；
- 现有 IPC handler、preload 类型和 Renderer 面板；
- Pi runtime 本身以及基础工具权限。

第二阶段才允许把 provider 运行逻辑移到独立官方 runtime 包；第三方包在更晚阶段只能通过 broker 合同调用能力。

## 4. 方案对比与 ADR

| 方案 | 用户影响 | 风险/成本 | 结论 |
| --- | --- | --- | --- |
| 继续宿主硬编码 | 使用方式不变 | 每增加插件都复制 Orchestrator 分支；关闭、升级和审计容易漏路径 | 淘汰 |
| 直接把服务器运维代码搬进任意插件包 | 表面上扩展最快 | 插件代码可接触 SSH、凭据、数据库写入、Docker 和远端命令；当前没有沙箱、broker、撤销和租约合同 | 拒绝 |
| 官方受信 adapter → broker → 再开放第三方 runtime | 先保持功能与 UI 稳定，再逐步解耦 | 需要 provider 接口、版本绑定和两阶段迁移 | **采用** |

### ADR

- **Decision:** `server-ops` 先作为宿主受信插件适配器接入标准 Plugin Host；所有可执行能力只能由 `ServerOpsCapabilityProvider` 在主进程按 Session 快照创建。runtime broker 完成前不接受第三方可执行入口。
- **Drivers:** 保留现有安全边界；让右侧面板、Agent 和恢复使用同一能力事实；控制迁移回归面和常驻资源成本。
- **Alternatives considered:** 继续硬编码；任意插件直接执行；为服务器运维单独维护另一套运行时。
- **Why chosen:** 现有 Facade 已具备会话身份、审计、版本和取消检查，最小改动是把它们包装成 provider，而不是重新实现远程能力。
- **Consequences:** 第一阶段仍是“受信插件”而不是任意第三方业务插件；需要同时维护宿主 adapter 和新 provider 合同；旧会话必须绑定 provider 版本/hash，升级后按 fail closed 处理。
- **Follow-ups:** 第二阶段实现 broker/RPC、能力租约和撤销；完成独立 runtime 的隔离、签名和回退验收后，再决定是否开放第三方 runtime。

## 5. 统一数据与接口设计

### 5.1 插件 manifest 扩展

修改 `packages/shared/src/types/agent-plugin.ts`，保持旧 `manifest-only` 可解析，并增加受宿主校验的 profile 和 provider 声明：

```ts
export type AgentPluginProfile = 'content' | 'module-runtime' | 'trusted-runtime'

export interface AgentPluginEntry {
  kind: 'manifest-only' | 'trusted-host-adapter'
  providerId?: string
  providerApiVersion?: number
}

export interface AgentPluginManifest {
  id: string
  version: string
  apiVersion: 1
  displayName: string
  description: string
  profile: AgentPluginProfile
  modules: AgentModuleManifest[]
  entry: AgentPluginEntry
  skillRefs?: AgentPluginSkillRef[]
  prompts?: Record<string, string>
  packageHash?: string
}

export interface AgentPluginSkillRef {
  id: string
  scope: 'project' | 'workspace' | 'builtin'
  versionRange?: string
  required: boolean
}
```

解析规则：

- `content` 只能使用 `manifest-only`，只允许声明已有 Skill 引用和静态元数据；不得携带 Skill 正文。
- `module-runtime`/`trusted-runtime` 的工具、Surface、服务和生命周期只能通过宿主 allowlist 的 provider 注册；未经宿主 allowlist 的 providerId 一律拒绝。
- `skillRefs` 只解析项目/工作区/Builtin Skill 注册表，解析结果进入运行快照，不产生插件对 Skill 正文的所有权。
- `packageHash` 由安装服务计算并写入，不能相信清单自报值；模块目录显示安装记录的 hash。
- 旧清单没有 `profile` 时按 `content` 解析，旧模块按 `message-explicit` 兼容，避免升级时意外扩权。

测试：`packages/shared/src/types/agent-plugin.test.ts` 覆盖旧清单兼容、未知 profile、第三方伪造 trusted entry、provider API 版本不兼容、hash 字段来源和大小边界。

### 5.2 模块能力声明与 provider 注册表

新增 `apps/electron/src/main/lib/agent-modules/plugin-capability-registry.ts`：

```ts
export interface ModuleActivationSnapshot {
  sessionId: string
  moduleId: string
  pluginId: string
  moduleVersion: string
  packageHash?: string
  providerId: string
  providerVersion: string
  policyRevision: number
  activatedAt: number
  surfaceIds: string[]
  capabilityIds: string[]
  permissions: string[]
}

export interface AgentModuleCapabilityProvider {
  readonly pluginId: string
  readonly providerId: string
  readonly providerVersion: string
  canProvide(snapshot: ModuleActivationSnapshot): boolean
  createForRun(input: {
    snapshot: ModuleActivationSnapshot
    runSignal: AbortSignal
    taskSignal?: AbortSignal
    assertRunActive: () => void
    triggeredBy: 'user' | 'automation' | 'delegation' | 'external'
  }): Promise<AgentModuleCapabilityHandle>
  drain(snapshot: ModuleActivationSnapshot): Promise<void>
  dispose(snapshot: ModuleActivationSnapshot): Promise<void>
}

export interface AgentModuleCapabilityHandle {
  toolNames: string[]
  buildTools(input: { sdk: PiSdk }): ToolDefinition[]
  surfaces: string[]
  audit: AgentModuleAuditContribution
  release(): Promise<void>
}
```

`createForRun` 只能接收主进程创建的快照和信号，不能接收 Renderer 输入的任意 hostId、credentialRef 或文件根。provider 返回的工具仍必须经过现有 `agent-permission-service.ts` 和 `module-tool-policy.ts`。

### 5.3 服务器运维 provider

新增 `apps/electron/src/main/lib/agent-modules/server-ops-plugin-adapter.ts`，职责是：

1. 声明官方 `builtin.server-ops` 插件 manifest 和 `server-ops` 模块。
2. 在注册时注入 `ServerOpsServiceContext` 的只读依赖，不复制服务实例。
3. 按运行快照创建 `createServerOpsAgentFacade`、`createServerOpsAgentReadFacade` 和连接草稿 Agent。
4. 把 `buildServerOpsTools`、`buildServerOpsReadTools`、`buildServerOpsReadWriteTools` 与 `buildServerOpsConnectionTools` 组合成 capability handle。
5. 把 `assertRunActive`、`runSignal`、`taskSignal`、`triggeredBy` 传给两个 Facade，阻止旧闭包跨 run 使用。
6. 统一生成 `AgentModuleAuditContribution`，记录 pluginId/moduleId/providerVersion/packageHash/capabilityId，不写凭据和命令原文。
7. 在 `drain` 中关闭新任务准入并等待已有 server-ops task/SSH/Docker/文件操作；在 `dispose` 中释放监听器和连接租约。

现有 Facade 的服务类型保持最小 `Pick`，不改成“传入完整 service context”。如果 provider 需要新能力，先在 Facade 合同增加最小接口和测试，再接入 provider。

### 5.4 Session 与运行快照

复用 `packages/shared/src/types/agent-modules.ts` 的 `moduleBindings`，增加 provider 绑定信息：

```ts
export interface AgentSessionModuleBinding {
  moduleId: string
  moduleVersion: string
  packageHash?: string
  pluginId?: string
  providerId?: string
  providerVersion?: string
}
```

主进程在每轮开始时只生成一次快照：

```text
Session modulePolicy + plugin catalog + provider health
  -> resolveModuleActivationSnapshot()
  -> Skill reference/prompt resolver
  -> capability registry
  -> Pi tool builder
  -> queue/recovery/audit binding
```

运行中右侧开关、插件升级或面板关闭不能改变快照；下一轮重新解析。快照无法匹配 provider、版本、hash、作用域或必需 surface 时，运行在工具创建前 fail closed，并写入可展示错误码。

### 5.5 Surface 与右侧面板

`server-ops` 继续使用既有 `surfaceId: 'server-ops'`。新增目录投影字段：

- `source: 'builtin' | 'installed'`；
- `pluginId`、`packageHash`、provider 健康状态；
- `state: available | attached | unavailable`；
- `reason` 只返回稳定错误码，如 `PLUGIN_PROVIDER_UNAVAILABLE`、`PLUGIN_VERSION_CHANGED`、`PLUGIN_DISABLED`。

无 surface 的内容插件仍显示为“可用能力”，不伪造右侧面板；服务器运维有 surface，因此点击目录条目按现有 Session CAS 规则附着并打开/聚焦面板。关闭面板只改变可见性；“从本会话移除”才撤销能力。

## 6. 权限与安全合同

### 6.1 分层权限

| 层 | 允许内容 | 不能做的事 |
| --- | --- | --- |
| 插件安装 | 读取并校验 manifest、hash、签名/来源 | 执行安装脚本、读取凭据 |
| Session 附着 | 绑定 module/provider/version/hash | 授予远程命令或数据库写入 |
| 只读 provider | 已授权资源的概览、服务、日志、表结构/行读取 | 解密凭据、任意 SQL、任意路径 |
| 写 provider | 既有逐次审批通过的命令、SQL、Redis、Docker、文件动作 | 绕过审批、扩大 host/table/path 范围 |
| runtime broker（二阶段） | 精确 capability token、租约、取消、审计 | 直接拿到 safeStorage、原始 SSH key、宿主 IPC |

### 6.2 必须保留的 fail-closed 规则

- `ServerOpsAgentFacade` 和 `ServerOpsAgentReadFacade` 每次调用继续复核 session、run、连接身份、credential version、授权 revision 和数据库策略。
- Host Key 确认仍只在服务器运维 UI；Agent 只能读取候选指纹和稳定错误码。
- 写操作仍先走 `agent-permission-service.ts`，再进入服务；`bypassPermissions`、插件 prompt、Skill 引用和 `toolRefs` 都不能绕过。
- Server Ops audit append 失败时保持现有降级 warning；不得因为插件化吞掉审计结果或把原始命令写入模块日志。
- plugin disable、provider stop、版本/hash 变化和旧 run 恢复都要阻止新副作用；不确定的远端终态显示“结果待核实”。
- 任何插件 API 错误只持久化稳定 error code，不持久化异常正文、凭据、私钥、SQL 原文或命令参数。

### 6.3 凭据和数据根

服务器运维插件只能通过 `ServerOpsServiceContext` 的最小接口访问已保存资源。凭据仍由 `server-ops-credential-store.ts`/`server-ops-data-credential-store.ts` 管理，插件 adapter 只允许读取不可逆 credential version。所有配置和授权 JSON 继续使用 `apps/electron/src/main/lib/safe-file.ts` 原子写；不引入数据库。

## 7. 分阶段实施任务

### Task 1: 固化服务器运维插件身份与兼容清单

**Files:**
- Modify: `packages/shared/src/types/agent-plugin.ts`
- Modify: `packages/shared/src/types/agent-modules.ts`
- Modify: `apps/electron/src/main/lib/agent-modules/module-registry.ts`
- Create: `apps/electron/src/main/lib/agent-modules/server-ops-plugin-manifest.ts`
- Test: `packages/shared/src/types/agent-plugin.test.ts`
- Test: `apps/electron/src/main/lib/agent-modules/module-registry.test.ts`

- [ ] 写失败测试：旧 manifest 无 `profile` 时解析为 `content`；官方 adapter manifest 必须是 `trusted-runtime`；普通安装包尝试声明 `trusted-host-adapter` 时返回 `AGENT_PLUGIN_TRUST_REQUIRED`；包内出现 Skill 正文路径时返回 `AGENT_PLUGIN_SKILL_EMBEDDING_FORBIDDEN`。
- [ ] 运行 `bun test packages/shared/src/types/agent-plugin.test.ts apps/electron/src/main/lib/agent-modules/module-registry.test.ts`，确认新断言先失败。
- [ ] 增加 `AgentPluginProfile`、provider 字段和 `builtin.server-ops` 虚拟包记录；禁止把 `toolRefs` 当作授权来源。
- [ ] 运行同一命令，确认旧插件兼容和新校验通过。
- [ ] 更新内置模块目录投影，使 `server-ops` 带 `pluginId: 'builtin.server-ops'`、`source: 'builtin'`、`resourceSource: 'package'`，历史 `moduleId: 'server-ops'` 保持可解析。

### Task 2: 建立 provider 注册表和统一运行快照

**Files:**
- Create: `apps/electron/src/main/lib/agent-modules/plugin-capability-registry.ts`
- Modify: `apps/electron/src/main/lib/agent-modules/plugin-host.ts`
- Modify: `apps/electron/src/main/lib/agent-modules/module-tool-policy.ts`
- Modify: `apps/electron/src/main/lib/agent-modules/module-skill-resolver.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Test: `apps/electron/src/main/lib/agent-modules/plugin-capability-registry.test.ts`
- Test: `apps/electron/src/main/lib/agent-modules/module-tool-policy.test.ts`

- [ ] 写 BDD：同一个 Session revision 生成的快照在 UI 切换后保持不变；provider 版本/hash 不匹配时返回 `PLUGIN_CAPABILITY_SNAPSHOT_INVALID`；未附着模块不能创建 handle。
- [ ] 运行 `bun test apps/electron/src/main/lib/agent-modules/plugin-capability-registry.test.ts apps/electron/src/main/lib/agent-modules/module-tool-policy.test.ts`，确认失败。
- [ ] 实现 registry 的注册、查询、按 providerId 精确创建、drain、dispose；拒绝重复 providerId 和 moduleId。
- [ ] 让 `module-tool-policy.ts` 只接收 snapshot 提供的精确 `toolNames`，保留 `server_`/`ops_` 旧前缀作为兼容诊断，不再决定 provider 是否存在。
- [ ] 让 Orchestrator 在构建 Pi runtime 前解析一次 Skill 引用/模块快照，并将同一对象传给 Skill/prompt、provider、队列和审计上下文。
- [ ] 运行上述测试和 `bun run typecheck`，确认类型边界完整。

### Task 3: 实现 ServerOpsPluginAdapter，复用现有 Facade

**Files:**
- Create: `apps/electron/src/main/lib/agent-modules/server-ops-plugin-adapter.ts`
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-agent-facade.ts`
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-agent-read-facade.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Test: `apps/electron/src/main/lib/agent-modules/server-ops-plugin-adapter.test.ts`
- Test: `apps/electron/src/main/lib/server-ops/server-ops-agent-facade.test.ts`
- Test: `apps/electron/src/main/lib/server-ops/server-ops-agent-read-facade.test.ts`

- [ ] 写 BDD：普通用户 Session 附着 `builtin.server-ops` 后创建只读/读写 handle；automation/delegation/external 仍按现有规则拒绝高权限；旧 run 的 `assertRunActive` 失效时工具返回稳定错误码且不触发远程副作用。
- [ ] 写 BDD：provider 使用最小 `Pick` 服务依赖；不能从 handle 取得 credential plaintext、Host Key confirm 或任意 IPC sender。
- [ ] 运行三个测试文件，确认 provider 尚未存在时失败。
- [ ] 实现 adapter 的 manifest、provider 注册、`createForRun`、工具构建、audit contribution、`drain` 和 `dispose`；保持 Facade 的参数校验和审计逻辑不变。
- [ ] 将 `pi-builtin-tools.ts` 改为消费 capability handle；删除同一运行内重复创建 Server Ops Facade 的分支。
- [ ] 运行 `bun test apps/electron/src/main/lib/agent-modules/server-ops-plugin-adapter.test.ts apps/electron/src/main/lib/server-ops/server-ops-agent-facade.test.ts apps/electron/src/main/lib/server-ops/server-ops-agent-read-facade.test.ts`。

### Task 4: 将 Plugin Host 生命周期接入运维服务排空

**Files:**
- Modify: `apps/electron/src/main/lib/agent-modules/plugin-host.ts`
- Modify: `apps/electron/src/main/lib/agent-modules/builtin-plugin-adapters.ts`
- Modify: `apps/electron/src/main/lib/agent-modules/server-ops-plugin-adapter.ts`
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-task-service.ts`
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-runtime-client.ts`
- Modify: `apps/electron/src/main/lib/agent-service.ts`
- Test: `apps/electron/src/main/lib/agent-modules/plugin-host.test.ts`
- Test: `apps/electron/src/main/lib/server-ops/server-ops-runtime-client.test.ts`
- Test: `apps/electron/src/main/lib/server-ops/server-ops-task-service.test.ts`

- [ ] 写 BDD：停用顺序为 `enabled -> draining -> disabled`；新 run 被拒绝；已有 SSH/Docker/文件/任务按租约排空；强制停止后迟到结果不能写入新 run。
- [ ] 写 BDD：provider 启动失败只影响服务器运维，其他插件继续运行；健康快照返回稳定 `PLUGIN_PROVIDER_START_FAILED`。
- [ ] 运行定向测试确认失败。
- [ ] 扩展 Plugin Host 生命周期接口，区分插件级 `stop` 和运行级 `drain`；让 runtime client 对旧 generation 的消息丢弃。
- [ ] 在 Agent service 的 stop/complete/error/quit 路径统一释放 capability handle，避免重复 stop 或泄漏监听器。
- [ ] 运行定向测试和 `bun run typecheck`。

### Task 5: 迁移 Agent 工具与权限门禁，删除运维专用硬编码

**Files:**
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify: `apps/electron/src/main/lib/agent-modules/module-tool-policy.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts`
- Modify: `apps/electron/src/main/lib/agent-permission-service.ts`
- Modify: `apps/electron/src/main/lib/agent-session-context-prompt.ts`
- Test: `apps/electron/src/main/lib/agent-orchestrator.test.ts`
- Test: `apps/electron/src/main/lib/agent-modules/module-tool-policy.test.ts`
- Test: `apps/electron/src/main/lib/server-ops/server-ops-ipc.test.ts`

- [ ] 写 BDD：选中插件模块后工具、prompt、Skill revision 和审计均携带同一 plugin/module/provider 版本；只声明 `ops_*` 的兼容内容插件不能得到工具。
- [ ] 写 BDD：普通模块、服务器专用 read/write 模式、探索分支、automation、delegation 的准入矩阵与现有结果一致。
- [ ] 运行测试确认失败。
- [ ] 用 `resolveModuleActivationSnapshot()` 替代 `runToolMode === 'server-ops-*'` 的服务创建判断；专用 read/write 模式只作为 legacy source 输入，最终仍映射到 provider capability。
- [ ] 将 `buildReferencedServerOpsPrompt()` 的来源绑定到快照，旧消息引用只读保留；插件关闭或版本变化时禁止重新注入。
- [ ] 删除确认无调用方的 server-ops 专用工具分支，并通过 `rg` 验证 Orchestrator 只保留 provider 注册和兼容映射。
- [ ] 运行 `bun test apps/electron/src/main/lib/agent-orchestrator.test.ts apps/electron/src/main/lib/agent-modules/module-tool-policy.test.ts apps/electron/src/main/lib/server-ops/server-ops-ipc.test.ts`。

### Task 6: 接通四层 IPC 与右侧服务器运维面板来源

**Files:**
- Modify: `packages/shared/src/types/agent-modules.ts`
- Modify: `packages/shared/src/ipc-channels.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/index.ts`
- Modify: `apps/electron/src/renderer/atoms/agent-module-atoms.ts`
- Modify: `apps/electron/src/renderer/components/agent/agent-module-loader.ts`
- Modify: `apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.tsx`
- Modify: `apps/electron/src/renderer/components/app-shell/AppShell.tsx`
- Test: `apps/electron/src/renderer/components/agent/agent-module-loader.test.ts`
- Test: `apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.test.tsx`
- Test: `apps/electron/src/renderer/components/app-shell/AppShell.server-ops-access.test.ts`

- [ ] 写 BDD：目录条目显示 `builtin.server-ops` 来源、provider 健康、版本/hash；点击条目使用 revision CAS 附着并打开面板；关闭面板不撤销权限；“从本会话移除”后图标回到可用态。
- [ ] 写 BDD：provider 不可用、版本变化或插件停用时条目显示 unavailable 原因；刷新目录可重新接入；不会把无 surface 内容插件伪造成面板。
- [ ] 运行 renderer 测试确认失败。
- [ ] 同步 shared channel、main handler、preload bridge、renderer 调用，禁止只改其中一层。
- [ ] 让面板初始化从 Session module catalog 读取 pluginId/provider 绑定，避免通过 moduleId 反查宿主硬编码。
- [ ] 运行 `bun test apps/electron/src/renderer/components/agent/agent-module-loader.test.ts apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.test.tsx apps/electron/src/renderer/components/app-shell/AppShell.server-ops-access.test.ts`。

### Task 7: 迁移队列、恢复、审计和会话历史绑定

**Files:**
- Modify: `apps/electron/src/main/lib/agent-module-command-service.ts`
- Modify: `apps/electron/src/main/lib/agent-recovery-service.ts`
- Modify: `apps/electron/src/main/lib/agent-run-journal.ts`
- Modify: `apps/electron/src/main/lib/agent-session-context-prompt.ts`
- Modify: `packages/shared/src/types/agent-modules.ts`
- Test: `apps/electron/src/main/lib/agent-module-command-service.test.ts`
- Test: `apps/electron/src/main/lib/agent-recovery-service.test.ts`
- Test: `apps/electron/src/main/lib/agent-run-journal.test.ts`

- [ ] 写 BDD：排队命令保存 pluginId/moduleVersion/packageHash/providerVersion；恢复发现版本/hash 变化时标记 `PLUGIN_CAPABILITY_SNAPSHOT_INVALID`，不重放远程副作用。
- [ ] 写 BDD：运行中停用保留历史命令和结果，但未派发命令变为可见阻断；重新启用后由用户明确重试，不自动重放。
- [ ] 写 BDD：Run Journal 的 tool_start/tool_result/audit 绑定同一 capability snapshot；旧闭包结果到达时被丢弃并写诊断。
- [ ] 运行定向测试确认失败。
- [ ] 扩展 outbox、journal 和 recovery schema，使用 `safe-file.ts` 原子写；旧记录缺少 provider 字段时按内置兼容映射只读恢复，不能隐式扩权。
- [ ] 在 recovery CAS 前复核插件启用、provider 健康、权限 revision、run generation 和远端终态。
- [ ] 运行三个测试文件及 `bun run typecheck`。

### Task 8: 插件管理中的服务器运维虚拟包与升级/停用事务

**Files:**
- Modify: `apps/electron/src/main/lib/agent-modules/plugin-management-service.ts`
- Modify: `apps/electron/src/main/lib/agent-modules/plugin-loader.ts`
- Modify: `apps/electron/src/main/lib/agent-modules/plugin-host.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/renderer/components/settings/PluginSettings.tsx`
- Modify: `apps/electron/src/renderer/components/settings/builtin-module-documentation.ts`
- Test: `apps/electron/src/main/lib/agent-modules/plugin-management-service.test.ts`
- Test: `apps/electron/src/renderer/components/settings/PluginSettings.test.tsx`

- [ ] 写 BDD：`builtin.server-ops` 显示“内置·随应用更新”，不可卸载、覆盖或从市场安装同名包；可全局停用但会展示影响范围。
- [ ] 写 BDD：升级/停用请求先阻止新准入，再等待运行租约；超时可选择停止任务；历史记录保留，下一轮重新解析。
- [ ] 写 BDD：工作区和开发版共享数据根时，插件目录事务不会产生半写入或同时激活两个版本。
- [ ] 运行测试确认失败。
- [ ] 将虚拟包参与 catalog 解析，但不写入可下载插件目录；安装/刷新事务保存 providerDigest 和健康状态。
- [ ] 在设置 UI 展示“模块已启用/当前 Session 已接入/运行健康”三个独立事实，避免用户误以为打开面板就已授权或安装即运行。
- [ ] 运行定向设置测试。

### Task 9: 第二阶段 capability broker 与官方 runtime 提取（第一阶段验收后执行）

**Files:**
- Create: `packages/shared/src/types/server-ops-capability-broker.ts`
- Create: `apps/electron/src/main/lib/server-ops/server-ops-capability-broker.ts`
- Create: `apps/electron/src/utility/server-ops/server-ops-broker-protocol.ts`
- Modify: `apps/electron/src/main/lib/agent-modules/server-ops-plugin-adapter.ts`
- Modify: `apps/electron/src/main/lib/server-ops/server-ops-runtime-client.ts`
- Test: `packages/shared/src/types/server-ops-capability-broker.test.ts`
- Test: `apps/electron/src/main/lib/server-ops/server-ops-capability-broker.test.ts`
- Test: `apps/electron/src/utility/server-ops/server-ops-broker-protocol.test.ts`

- [ ] 写 BDD：broker token 只包含 capabilityId、sessionId、runId、scope、expiry、revision 和 nonce；不包含凭据、私钥、原始 SQL/命令。
- [ ] 写 BDD：token 过期、撤销、scope/host/table/path 不匹配、旧 generation 请求均在副作用前拒绝。
- [ ] 写 BDD：utility runtime 崩溃后只能按原 run/branch/sequence 恢复；不自动重试未知远端副作用。
- [ ] 先实现纯合同解析与 token 绑定测试，再实现主进程 broker；禁止在 broker 中复制领域权限规则。
- [ ] 将官方 runtime provider 迁移到 broker client；主进程仍持有凭据、审计和审批权。
- [ ] 只有 broker 安全审计、独立进程隔离、签名验证、撤销和升级回退全部通过后，才评估第三方 runtime。

### Task 10: 删除宿主专用分支并完成兼容回滚

**Files:**
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts`
- Modify: `apps/electron/src/main/lib/agent-modules/module-tool-policy.ts`
- Modify: `apps/electron/src/main/lib/agent-modules/module-registry.ts`
- Create: `apps/electron/src/main/lib/agent-modules/server-ops-plugin-compat.ts`
- Test: `apps/electron/src/main/lib/agent-modules/server-ops-plugin-compat.test.ts`

- [ ] 写 BDD：feature flag 关闭时仍能以兼容 adapter 启动旧服务器运维会话；新会话不会同时装配旧分支和 provider。
- [ ] 写 BDD：回滚期间旧历史消息、审计和面板引用仍可读；未完成写任务保持明确的 pending/unknown，不自动重放。
- [ ] 运行测试确认失败。
- [ ] 加入一次性兼容映射和可观测指标；删除确认无引用的 `server-ops` 专用工具分支。
- [ ] 运行完整验证后再移除 feature flag 默认分支，保留一个版本周期的只读诊断。

## 8. Agent、Session、停用和恢复语义

### 8.1 准入矩阵

| 来源 | 可附着 | 默认能力 | 额外限制 |
| --- | --- | --- | --- |
| 普通顶层用户 Session | 是 | 按当前授权提供只读，写能力逐次确认 | 必须显式附着或兼容旧专用模式 |
| 用户探索分支 | 按现有项目归属规则 | 继承本分支自己的 Session 策略 | 不继承父 Session 的授权快照 |
| Automation | 仅已有明确受信任务合同 | 不自动新增 server-ops 写能力 | provider 只能使用任务声明的 capability |
| Collaboration/delegation | 默认否 | 无远程命令、数据库写入或凭据能力 | 需要后续单独的受信委派合同 |
| External/imported run | 默认否 | 无 server-ops provider | 只保留历史只读引用 |

### 8.2 运行中停用

状态机固定为：`enabled -> draining -> disabled`。

1. 事务先把 provider 标记为 draining，拒绝新 run、队列和恢复请求。
2. 运行中的 SSH、数据库、Redis、Docker、文件和任务操作继续使用原快照，等待完成或用户选择停止。
3. 迟到结果必须携带原 run generation；generation 不匹配时丢弃副作用并写诊断。
4. 完成后移除工具 handle、释放监听器/连接租约，Session 保留 enabled 偏好但标为 `blocked-dependency` 或 `disabled`。
5. 重新启用只恢复可用性，不恢复旧任务、不自动重放旧命令、不自动打开面板。

### 8.3 升级与恢复

插件版本、模块版本、provider 版本或 packageHash 任一变化，都使旧快照失效。恢复服务必须在 CAS 提交前重新解析当前 catalog、Session policy、权限 revision、连接身份和 provider 健康；无法完全匹配时返回可操作错误并保留历史记录。

## 9. UI 与插件中心表现

- 插件中心“已安装”显示 `builtin.server-ops`，标明“内置·随应用更新”，并展示能力说明、权限边界、连接数据根和审计说明。
- 右侧菜单显示服务器运维图标；绿色表示当前 Session 已附着权限，选中背景表示面板可见，两者不能混用。
- 面板打开后保持 Session 附着；关闭只隐藏面板。用户从菜单执行“从本会话移除”才撤销能力。
- provider 启动失败显示“已启用但运行失败”，提供重试和诊断入口，不自动无限重启。
- 内容型插件可以出现在模块目录，但没有 `surfaceId` 时只显示能力入口，不伪造服务器运维面板。
- Agent 消息中不恢复旧的底部模块选择器；旧 `/module:server-ops` 和 `@module:server-ops` 数据继续解析为兼容显式调用。

## 10. 性能与资源影响

| 变化 | 预期影响 | 约束 |
| --- | --- | --- |
| 每轮解析一次 catalog + snapshot | 增加一次内存查找和小型 JSON 投影 | 不扫描所有插件正文；catalog 以版本/hash 缓存 |
| provider handle 创建 | 只在 Session 运行时创建两个 Facade 和工具 schema | 不在安装、打开设置或打开面板时建立 SSH/数据库连接 |
| broker（第二阶段） | 增加一次 IPC/RPC 往返 | 批量只读请求可合并；写请求仍逐次审批和审计 |
| 停用排空 | 短期保留运行资源 | UI 显示任务数/超时；超过租约上限才由用户选择强停 |
| 审计字段扩展 | JSONL 少量增大 | 只写稳定身份和 hash，不写命令、SQL、凭据或返回正文 |

基准验收：100 个已安装模块插件时，右侧目录加载不读取项目 Skill 正文；普通无运维 Session 不创建 Server Ops Facade；已附着但空闲的 Session 不启动远程连接、不新增后台轮询；provider 创建和释放不产生监听器泄漏。

## 11. 测试与验收矩阵

### 11.1 单元/合同

- manifest profile、provider allowlist、版本/hash 兼容和旧格式迁移；
- snapshot 冻结、revision CAS、重复 provider、能力精确工具名；
- Facade 最小依赖、旧 run 失效、凭据版本变化、审计降级 warning；
- broker token 解析、scope、expiry、nonce、撤销和旧 generation。

### 11.2 集成

- Orchestrator → registry → ServerOpsPluginAdapter → Pi tools；
- Session catalog → main IPC → preload → renderer attach/detach；
- stop/drain → task/runtime client → late result discard；
- queue/outbox/journal/recovery 使用同一 snapshot；
- 插件管理事务与开发版/打包版共享数据根。

### 11.3 Electron smoke

使用隔离 `DUTYDECK_DATA_ROOT` 和测试用 utility runtime：

1. 打开右侧服务器运维面板，确认目录条目来源为 `builtin.server-ops`。
2. 点击条目，确认绿色 Session 权限、面板打开和 Agent 只读工具装配。
3. 关闭面板，确认权限仍在；从会话移除后确认工具不再装配。
4. 模拟 provider 失败、升级和停用，确认 UI 状态、错误码和恢复入口。
5. 启动一个可取消的 utility 任务，停用插件，确认排空、迟到结果丢弃和历史保留。

### 11.4 必跑命令

```bash
bun test packages/shared/src/types/agent-plugin.test.ts packages/shared/src/types/agent-modules.test.ts
bun test apps/electron/src/main/lib/agent-modules apps/electron/src/main/lib/server-ops
bun test apps/electron/src/renderer/components/agent apps/electron/src/renderer/components/server-ops
bun run typecheck
SWIFT_MODULECACHE_PATH=/private/tmp/dutydeck-swift-cache CLANG_MODULE_CACHE_PATH=/private/tmp/dutydeck-clang-cache bun run electron:build
bun run electron:smoke
git diff --check
```

如果完整仓库测试仍有与本计划无关的失败，必须记录失败基线、受影响包和已完成的定向证据，不能用“定向测试通过”代替全仓验收。

## 12. 发布、兼容与回滚

- 第一阶段作为一个可关闭的 feature flag 发布，旧 `server-ops` 运行模式保留一个版本周期；新旧路径不能同时向同一 run 注入工具。
- 版本发布前更新 `release-notes/v<版本>.md`，核对 `apps/electron/package.json`、`bun.lock`、正式标签和安装包；不覆盖已发布标签。
- 插件 schema/API 版本、provider API 版本和应用 SemVer 分开管理；provider 不兼容时显示“需要升级应用”，不自动降级到不安全能力。
- 回滚只切换新会话的 provider 解析路径；已有运行按旧快照排空，历史审计、任务和面板引用继续只读可见。
- 卸载第三方内容插件保留历史包 hash 和用户产物；`builtin.server-ops` 不可卸载。服务器运维配置、凭据和审计数据不随 UI 插件状态删除。

## 13. 风险与缓解

| 风险 | 触发条件 | 缓解与停止条件 |
| --- | --- | --- |
| 工具权限扩大 | provider 直接使用 manifest `toolRefs` | registry 只接受宿主注册的 capability；没有 provider 就没有工具 |
| 凭据泄漏 | runtime/插件得到完整 service context | Facade 继续使用最小 Pick；凭据只返回不可逆版本；测试扫描序列化载荷 |
| 旧闭包跨 run | Session 切换或插件升级时迟到工具结果 | snapshot + generation + `assertRunActive`；迟到结果丢弃 |
| 审计断裂 | adapter 捕获异常后直接返回结果 | audit contribution 由 provider 统一包装；append 失败保持 warning 和错误码 |
| 停用卡死 | 远程任务不响应取消 | draining 有可见计数和用户强停；未知远端状态不自动重放 |
| UI 与 Agent 状态不一致 | 面板打开被误当作权限 | 目录、工具装配和面板都读取同一 Session catalog/snapshot |
| 迁移回归过大 | 一次移动所有 server-ops 服务 | 第一阶段只包装 Facade；第二阶段通过 broker 分离；每阶段可回滚 |
| 资源常驻增加 | 安装或设置页面启动 runtime | provider 仅按 Session run 创建；空闲面板不建立远程连接 |

## 14. 交付停止条件

第一阶段只有同时满足以下条件才可标记完成：

- `builtin.server-ops` 能从标准插件目录投影到右侧菜单和插件中心；
- Agent 只通过 provider handle 装配服务器运维工具，Orchestrator 不再直接 new Facade；
- 只读、写入、数据库、Docker、文件、任务、凭据、Host Key 和审计回归均通过；
- 停用、升级、排空、恢复、旧闭包失效和回滚 smoke 通过；
- `bun run typecheck`、相关 `bun test`、Electron build/smoke 和 `git diff --check` 有新鲜证据；
- release note、兼容开关和错误诊断已写明；
- 未满足 broker 隔离、签名、撤销、审计和升级回退前，不得宣称已开放第三方可执行服务器运维插件。

本计划只完成规划文档，不修改业务代码、不提交 Git、不推送和不发布版本。
