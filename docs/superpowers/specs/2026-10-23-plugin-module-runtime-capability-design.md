# DutyDeck 插件模块通用运行时与能力底座设计

日期：2026-10-23

状态：用户已确认并进入实施；2026-10-23 已完成首个可运行能力底座。本文仍只定义插件能力底座，不迁移交互设计、影像创作、画布、服务器运维或接口工作台。

实施入口见[插件模块通用运行时与能力底座实施计划](../plans/2026-10-23-plugin-module-runtime-capability.md)。当前已具备 V3 包校验/签名/安装、utility runtime、工具与 Surface 贡献、Session 模块投影、Capability Broker、插件私有状态和运行时 fixture；项目文件、网络、远程运维、媒体与 Agent 委派 provider 仍需在后续按扩展点接入。

## 1. 结论先行

插件底座应新增一条与现有 `content` 插件并存的可执行模块路线：

- 开发者用统一 SDK 声明模块、Agent 工具、右侧 Surface、受控服务、状态、设置和所需宿主能力。
- 插件代码在独立 utility 进程运行，宿主主进程不直接 import 插件业务。
- Agent 与 Surface 只能通过宿主签发的能力 Broker 使用项目、文件、网络、凭据、媒体、远程任务等资源。
- 模块是否开放给 Agent 由 Session 激活策略决定；运行开始时冻结插件版本、包 hash、模块、权限、设置和资源引用。
- 插件包、脚手架、校验、签名、安装、启停、卸载和开发运行形成同一闭环，开发者无需修改 DutyDeck 宿主源码。
- 第一阶段不迁移五个既有业务模块，只提供通用能力并用无业务副作用的 fixture 插件验证。

这里说的“独立进程”用于故障隔离和资源释放，不等同于恶意代码沙箱。首期只支持经签名并由用户明确信任的开发者插件；未签名插件仅能在隔离开发数据根运行。任意不可信第三方代码的强隔离必须另立安全设计和验收，不能用本次能力底座冒充完成。

## 2. 目标与非目标

### 2.1 目标

1. 开发者只安装公开 SDK/CLI，即可开发包含可执行 runtime 的插件。
2. 插件可以为模块注册 Agent 工具、Surface、受控服务、状态、设置和产物类型。
3. 五个目标模块所需的通用能力都能通过公开合同表达，不需要在宿主中新增模块 ID 分支。
4. Agent 启用模块后，工具自动进入当前运行；Surface 可打开并调用授权能力。
5. 停用、升级、崩溃、超时、取消、排队和会话恢复都使用同一版本/权限快照。
6. 插件不能直接取得 Electron 对象、明文凭据、任意文件根、原始环境变量或任意 IPC。
7. 旧 `content` 插件、现有五个内置模块和未提交业务改动保持兼容。

### 2.2 非目标

- 本阶段不把任何既有业务目录移动到插件包。
- 本阶段不开放任意匿名或不可信第三方原生代码。
- 本阶段不实现插件市场、支付、评分或团队账号。
- 本阶段不允许插件自带 node_modules、安装脚本、原生二进制或远程运行时代码。
- 本阶段不允许插件直接访问完整 renderer preload、`ipcMain`、`BrowserWindow`、safeStorage 或 shell。
- 本阶段不保证被恶意插件攻破操作系统边界；信任与能力边界、进程隔离和资源撤销分别表达。
- 本阶段不修改五个模块现有的数据 schema、工具语义、审批规则或恢复合同。

## 3. 第一性原理与关键决策

### 3.1 为什么不能继续扩 manifest

Manifest 只能描述声明，不能提供执行入口、资源生命周期、工具处理函数或 Surface 通信。如果仍由宿主为每个声明配置回调，新增插件仍要求修改宿主，不能形成开发者生态。

因此本设计把插件拆成四个可独立验证的事实：

| 事实 | 权威来源 | 说明 |
| --- | --- | --- |
| 包是什么 | 签名 manifest 与 integrity | 身份、版本、资源、能力请求和贡献声明 |
| 代码能做什么 | 运行时握手 + manifest 对照 | 只能提供已声明贡献，不能握手时扩权 |
| 用户允许什么 | 安装信任 + 能力授权 + Session 快照 | 已安装、全局启用、模块激活和单次审批分别判断 |
| 实际发生了什么 | Run Journal、审计和结构化错误 | 不以安装、声明或启动成功推断调用成功 |

### 3.2 为什么使用独立 utility runtime

- 主进程导入插件代码会把插件异常、同步阻塞和升级生命周期扩散到应用核心。
- utility 进程可以独立启动、超时退出、崩溃回收和版本化，适合插件服务。
- 插件仍能使用 Node 能力，因此必须明确它不是恶意代码沙箱。
- 所有宿主资源通过 RPC/Broker 提供，使权限、审计、取消和版本核验集中在一处。

### 3.3 为什么 Surface 使用独立受限文档

直接动态 import 作者 React 代码会与宿主共享 renderer 全局、preload 和 DOM 权限。首期使用包内静态 Surface bundle，在隔离文档和受限 bridge 中运行：

- 不给完整 preload。
- 不共享宿主 localStorage、cookie、Jotai store 或全局对象。
- 只接收宿主签发的 Surface token 和显式 bridge 方法。
- 所有导航、文件、网络、弹窗和下载由宿主复核。

### 3.4 为什么工具由宿主注册而不是插件直接接触 Pi

- Pi 工具定义需要稳定的 Schema、审批分类、取消和结果预算。
- 插件不能自报 run、session、project 或权限身份。
- 宿主可从可信快照生成工具闭包，并在每次调用前复核插件版本和模块仍处于激活状态。
- 任何插件工具都继续经过现有 Agent 权限和业务审批。

### 3.5 为什么新增 package format 3

现有 V2 包合同是内容插件，且权限、依赖、导出均为空。可执行入口、宿主能力和 Surface 是实质新增，不应复用“content-only”语义。

- V1/V2 `content` 继续只读兼容。
- V3 `module-runtime` 是开发者可执行插件格式。
- 旧客户端遇到 V3 必须在解包前明确拒绝，不能部分加载。
- 新客户端可同时读取 V1/V2/V3。

## 4. 术语与身份

### 4.1 稳定身份

| 对象 | 格式 | 示例 |
| --- | --- | --- |
| 发布者 | 小写命名空间 | `acme` |
| 插件 | `<publisherId>.<pluginSlug>` | `acme.design-tools` |
| 模块 | `<pluginId>.<moduleSlug>` | `acme.design-tools.wireframe` |
| 工具贡献 | `<pluginId>/tools/<toolId>` | `acme.design-tools/tools/inspect` |
| Surface | `<pluginId>/surfaces/<surfaceId>` | `acme.design-tools/surfaces/workspace` |
| 服务 | `<pluginId>/services/<serviceId>` | `acme.design-tools/services/indexer` |
| 私有状态命名空间 | `<pluginId>/state/<stateSchema>` | `acme.design-tools/state/v1` |

显示名、中文标题和图标描述可以修改，稳定 ID 不可因文案修改而变化。

### 4.2 四种运行事实

| 状态 | 事实源 | 不能推断的结论 |
| --- | --- | --- |
| 已安装 | 安装 registry | 不能推断已启用或可信 |
| 已启用 | 当前数据根插件状态 | 不能推断当前 Session 已获得模块工具 |
| 本 Session 已激活 | Session `modulePolicy` | 不能推断工具调用已成功 |
| runtime 健康 | Runtime Supervisor | 不能推断依赖服务、模型或远端任务健康 |

面板打开仅是 renderer 导航状态，不授予 Agent 能力。模块能力已激活但面板未打开时，Agent 仍可调用；面板打开但模块未激活时，只能浏览和明确请求激活。

点击已启用模块的入口时，宿主可原子完成“附着到当前 Session 并打开 Surface”；关闭 Surface 只改变可见性，不撤销 Session 能力。明确“从本会话移除”才撤销模块工具和写能力。

## 5. 总体架构

```text
Developer package
  manifest + runtime bundle + surface bundle + prompts + optional assets
                         |
                         v
Package validator / signer / installer
                         |
                         v
Immutable package store -> Plugin registry
                         |
         +---------------+----------------+
         |                                |
Session module activation          Runtime supervisor
         |                                |
         v                                v
Run snapshot + tool proxy         utility plugin process
         |                                |
         +------ capability broker -------+
                         |
         project / state / network / secrets / media / remote ops

Plugin runtime ---- scoped events ---- Surface host iframe
```

### 5.1 宿主组件

| 组件 | 唯一责任 |
| --- | --- |
| Package reader/validator | 解析 V3 包、限制路径和大小、校验声明引用 |
| Trust/signature service | 验证 Ed25519 签名、发布者绑定和更新连续性 |
| Installation transaction | 安装、更新、回退、卸载和多实例协调 |
| Plugin registry | 只保存已接纳的不可变元数据和当前版本指针 |
| Runtime supervisor | 惰性启动、健康检查、崩溃退出、排空、停止和版本租约 |
| Runtime RPC client | 版本化消息、请求关联、取消、超时和消息预算 |
| Capability broker | 把插件请求转换为宿主受控能力，注入可信身份 |
| Contribution registry | 工具、Surface、服务和状态的唯一注册表 |
| Module activation service | 组合全局启用、Session 激活、版本/权限/项目条件 |
| Tool proxy | 为 Pi 生成闭包，转发调用并复核运行态 |
| Surface registry/host | 管理插件 Surface 元数据、token、隔离页面和 bridge |
| Audit/journal bridge | 记录激活、启动、调用、取消、错误和版本事实 |

### 5.2 建议源码边界

```text
packages/plugin-sdk/
  src/contracts.ts
  src/runtime-api.ts
  src/manifest-v3.ts
  src/capabilities.ts
  src/host-api.ts
  src/validation.ts

packages/plugin-kit/
  src/build.ts
  src/package.ts
  src/scaffold.ts
  templates/module-runtime/

apps/electron/src/main/lib/agent-plugins/
  package-reader.ts
  publisher-trust.ts
  runtime-supervisor.ts
  runtime-rpc.ts
  capability-broker.ts
  contribution-registry.ts
  surface-registry.ts
  plugin-run-snapshot.ts

apps/electron/src/utility/
  plugin-runtime.ts

apps/electron/src/preload/
  plugin-surface-preload.ts

apps/electron/src/renderer/components/plugins/
  PluginSurfaceHost.tsx
  PluginSurfaceError.tsx

examples/plugins/runtime-fixture/
  plugin.json
  runtime/main.mjs
  surfaces/workspace/index.html
  surfaces/workspace/main.js
  tests/
```

以上是目标边界。实施时可复用 `agent-modules/` 现有 registry、policy 和 host 能力，不另建两套模块状态。

## 6. V3 插件包合同

### 6.1 包目录

```text
acme.design-tools-1.0.0.ddplugin
  plugin.json
  integrity.json
  signature.json
  README.md
  LICENSE
  CHANGELOG.md
  THIRD_PARTY_NOTICES.md
  runtime/main.mjs
  surfaces/workspace/index.html
  surfaces/workspace/main.js
  surfaces/workspace/style.css
  prompts/workflow.md
  assets/icon.png
```

- `runtime` 只能是自包含 ESM bundle。
- `surfaces` 只能是静态 HTML/CSS/JS/图片字体等本地资源。
- 不允许 `node_modules`、`package.json`、安装脚本、`.node`、动态远程 import、绝对路径或符号链接。
- Runtime 和 Surface 文件都必须进入确定性 integrity 清单。
- `plugin.json` 由 integrity 保护；integrity 由 signature 保护。

### 6.2 Manifest 示例

```json
{
  "formatVersion": 3,
  "apiVersion": "1.0.0",
  "id": "acme.design-tools",
  "publisherId": "acme",
  "version": "1.0.0",
  "displayName": "设计工具",
  "description": "为当前项目提供页面排查与设计交接。",
  "license": "MIT",
  "profile": "module-runtime",
  "compatibility": {
    "hostApi": "^1.0.0",
    "runtimeProtocol": 1,
    "platforms": ["darwin", "win32", "linux"],
    "architectures": ["arm64", "x64"]
  },
  "runtime": {
    "entry": "runtime/main.mjs",
    "format": "module-esm"
  },
  "modules": [
    {
      "id": "inspector",
      "displayName": "页面检查",
      "description": "读取项目页面并生成检查结果。",
      "icon": "scan-search",
      "activation": "session-toggle",
      "skillRefs": [
        {
          "id": "interaction-design/page-design",
          "scope": "project",
          "versionRange": "^1.0.0",
          "required": false
        }
      ],
      "promptRefs": ["workflow"],
      "tools": ["inspect-project"],
      "surfaces": ["workspace"],
      "services": ["project-index"],
      "artifacts": ["page-review"]
    }
  ],
  "tools": [
    {
      "id": "inspect-project",
      "ownerModuleId": "inspector",
      "title": "检查项目页面",
      "description": "读取授权项目页面并返回结构摘要。",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "pageId": {"type": "string", "maxLength": 128}
        },
        "required": ["pageId"]
      },
      "annotations": {
        "readOnly": true,
        "destructive": false,
        "idempotent": true,
        "openWorld": false
      },
      "approval": "none",
      "timeoutMs": 30000
    }
  ],
  "surfaces": [
    {
      "id": "workspace",
      "ownerModuleId": "inspector",
      "title": "页面检查",
      "entry": "surfaces/workspace/index.html",
      "apiVersion": 1,
      "defaultPlacement": "right-panel",
      "methods": ["loadContext", "saveDraft"]
    }
  ],
  "services": [
    {
      "id": "project-index",
      "title": "项目索引",
      "start": "lazy",
      "idleStopMs": 300000
    }
  ],
  "artifacts": [
    {
      "id": "page-review",
      "ownerModuleId": "inspector",
      "title": "页面检查结果",
      "schemaVersion": 1,
      "mimeTypes": ["application/json"],
      "retention": "project"
    }
  ],
  "prompts": [
    {
      "id": "workflow",
      "version": "1.0.0",
      "kind": "workflow",
      "path": "prompts/workflow.md"
    }
  ],
  "settings": [],
  "capabilities": [
    "session.read",
    "project.files.read",
    "plugin.state.read",
    "plugin.state.write",
    "surface.emit"
  ],
  "dependencies": [],
  "exports": []
}
```

### 6.3 清单规则

- `modules`、`tools`、`surfaces`、`services`、`artifacts`、`prompts`、`settings` 的 ID 在各自命名空间内唯一。
- `ownerModuleId` 必须引用本插件模块；一个贡献默认只归属一个模块。
- 模块只能引用本插件声明的工具、Surface、提示、服务和产物类型。
- Surface 的 `methods` 必须显式声明 bridge 可调用的 runtime 方法；未声明方法不能通过“同在一个包内”自动获得。
- 工具 `inputSchema` 只允许宿主支持的 JSON Schema 子集；不能携带函数或运行表达式。
- `approval` 只能是 `none`、`per-call` 或 `write`。`readOnly=false` 不自动等于需要审批，但不得比宿主权限策略更宽松。
- `openWorld=true` 只说明工具可能接触外部环境，不授予网络或远程执行权限。
- 服务必须声明启动方式和空闲停止时间；安装插件不会启动服务。
- 产物类型的 `retention=project` 必须通过项目 artifact 能力写入；`retention=plugin` 只能进入插件私有状态/缓存，不得冒充用户项目产物。
- `capabilities` 只代表请求，不代表批准。运行时不申请或不在快照中的能力直接拒绝。
- 未知必需字段、未知工具、未知 Surface、未声明 package hash 或依赖错误一律阻断。
- 插件不能声明 `automatic` 模块；浏览器、终端等自动基础能力继续由宿主持有。

### 6.4 兼容层级

| 版本 | 行为 |
| --- | --- |
| V1 legacy | 继续只读、只清理清单，不执行代码 |
| V2 content | 继续支持 Skill 引用、提示与设计资源；不注册可执行能力 |
| V3 module-runtime | 支持 runtime、工具、Surface、服务、状态和能力 Broker |
| 未知 formatVersion/profile | 在解包/安装前拒绝，不忽略未知贡献 |

## 7. 公开开发者 SDK

### 7.1 定义方式

SDK 提供纯 TypeScript 合同与 `definePlugin()`，不依赖 Electron 或宿主源码。

```ts
import { definePlugin } from '@dutydeck/plugin-sdk'

export default definePlugin({
  async activate(context) {
    context.tools.handle('inspect-project', async (input, call) => {
      const page = await call.capabilities.project.readText({
        relativePath: input.pageId,
        maxBytes: 64 * 1024,
      })
      call.signal.throwIfAborted()
      return {
        summary: page.content.slice(0, 4000),
        truncated: page.truncated,
      }
    })

    context.events.emit({
      surfaceId: 'workspace',
      type: 'ready',
      payload: {},
    })

    context.surfaces.handle('workspace', 'loadContext', async (_input, call) => {
      const current = await call.capabilities.artifacts.readCurrent({
        artifactType: 'page-review',
      })
      return { artifact: current }
    })
  },

  async deactivate(context) {
    context.events.emit({
      surfaceId: 'workspace',
      type: 'closing',
      payload: {},
    })
  },
})
```

实际执行顺序是宿主创建插件实例上下文后调用 `activate`，再接受工具调用和 Surface 请求。`activate` 不得产生真实业务副作用，也不能把启动成功当作健康检查；健康检查和准备阶段必须无副作用。

### 7.2 Runtime Context

```ts
interface PluginRuntimeContext {
  readonly plugin: {
    id: string
    version: string
    packageHash: string
  }
  readonly declaredModules: ReadonlyArray<{
    id: string
    version: string
    activation: 'message-explicit' | 'session-toggle'
  }>
  readonly tools: ToolRegistry
  readonly services: ServiceRegistry
  readonly surfaces: SurfaceHandlerRegistry
  readonly events: EventEmitter
  readonly state: PluginStateApi
  readonly settings: Readonly<Record<string, PluginSettingValue>>
  readonly log: PluginLogger
}
```

Context 中的身份、声明模块、设置和插件级状态都绑定到插件实例。Session、项目、run 和项目级能力只出现在工具调用或 Surface 请求上下文中，不能从插件实例全局获取。插件无法通过参数覆盖任何宿主身份。

### 7.3 每次工具调用上下文

```ts
interface ToolCallContext {
  readonly invocationId: string
  readonly moduleId: string
  readonly sessionId: string
  readonly projectId: string | null
  readonly runId: string
  readonly signal: AbortSignal
  readonly deadline: number
  readonly settings: Readonly<Record<string, PluginSettingValue>>
  readonly capabilities: CapabilityClient
  progress(value: PluginProgress): void
}
```

- `sessionId`、`projectId` 和 `runId` 不来自模型参数。
- 插件必须尊重取消信号并在 deadline 前返回。
- `progress` 只发布有界进度事件，不改变工具最终结果。
- 工具结果必须是 JSON 可序列化值，默认上限 256 KiB；图片等大对象用 artifact/media 句柄传递。
- 每次工具调用同时携带本轮冻结的 settings revision/hash 和只读设置值；旧运行不读取刚修改的插件设置。

### 7.4 Surface 调用上下文

Surface bridge 调用 runtime 时使用独立上下文，而不是伪造一次 Agent 工具调用：

```ts
interface SurfaceCallContext {
  readonly requestId: string
  readonly surfaceId: string
  readonly sessionId: string
  readonly projectId: string | null
  readonly readOnly: boolean
  readonly signal: AbortSignal
  readonly deadline: number
  readonly settings: Readonly<Record<string, PluginSettingValue>>
  readonly capabilities: CapabilityClient
  progress(value: PluginProgress): void
}
```

- bridge 方法名必须同时存在于 Surface manifest 和 runtime handler 注册表。
- 模块未附着时，`readOnly=true`，写能力和 Agent 任务能力不可用。
- Surface 请求不能自行启动 Agent 运行；需要 Agent 时只能提交宿主审核的导航/草稿动作。

### 7.5 Service Registry

```ts
interface ServiceRegistry {
  handle(id: string, implementation: {
    start?(): Promise<void>
    health?(): Promise<PluginHealth>
    drain?(signal: AbortSignal): Promise<void>
    stop?(): Promise<void>
  }): void
}
```

- 服务实例归插件 runtime，不直接绑定某个 Session。
- 需要项目或 Session 的工作必须使用当前 invocation 的 capability，不得在进程级缓存未授权数据。
- `drain` 必须停止接收新工作；`stop` 必须释放连接、计时器和监听器。
- 服务实现缺失其 manifest 声明时 runtime 启动失败；manifest 未声明的服务 handler 被拒绝。

### 7.6 状态 API

```ts
interface PluginStateApi {
  read<T>(key: string): Promise<T | null>
  write<T>(key: string, value: T, options: {
    schemaVersion: number
    expectedRevision?: number
  }): Promise<{ revision: number }>
  transaction<T>(input: {
    schemaVersion: number
    mutate: (current: unknown) => unknown
  }): Promise<{ revision: number; value: T }>
}
```

- Key 只能是稳定 ASCII 标识，不映射为任意文件路径。
- 状态由宿主持有；宿主使用原子写、修订号和 schema 版本。
- 默认最大记录 1 MiB、单插件私有状态 100 MiB。
- 插件不能通过状态 API 读取另一个插件或用户项目数据。

### 7.7 设置与凭据

插件设置使用声明式 schema：

```ts
interface PluginSettingDeclaration {
  key: string
  type: 'boolean' | 'integer' | 'text' | 'enum' | 'credentialRef'
  label: string
  description?: string
  required?: boolean
  defaultValue?: unknown
  enumValues?: readonly string[]
  apply: 'next-run' | 'restart-runtime'
}
```

- 普通值随运行快照冻结。
- `credentialRef` 只返回不透明引用，不返回密钥正文。
- 设置修改不得热改写正在运行的旧快照：`next-run` 从下一轮 Agent 运行生效，`restart-runtime` 在插件安全排空并重启后生效。

## 8. Runtime 协议

### 8.1 启动顺序

1. 宿主选定已签名、已信任且版本匹配的不可变包目录。
2. 宿主以受限环境启动 utility child。
3. 插件加载包内唯一 runtime entry。
4. 插件发送 `runtime.hello`，包含协议版本、实际贡献 ID 和 bundle hash。
5. 宿主与签名 manifest 逐项核对；缺失、增加、改名或 Schema 不一致均失败。
6. 宿主下发插件实例的声明模块、设置和条件能力策略版本。Session/项目级 capability grant 不在此阶段常驻下发。
7. 插件返回 `runtime.ready`。
8. 仅完成 `ready` 后，工具代理和 Surface bridge 才可工作。

握手阶段不得产生业务副作用、读取项目正文、调用模型或发起网络请求。

### 8.2 RPC 消息

所有 RPC 使用版本化信封：

```ts
interface PluginRpcEnvelope<T> {
  protocolVersion: 1
  requestId: string
  kind: 'request' | 'response' | 'cancel' | 'event'
  method: string
  payload: T
}
```

首批方法：

| 方向 | 方法 | 语义 |
| --- | --- | --- |
| runtime → host | `runtime.hello` | 身份与贡献握手 |
| host → runtime | `runtime.activate` | 下发实例快照 |
| host → runtime | `tool.invoke` | 执行工具 |
| host → runtime | `tool.cancel` | 取消指定 invocation |
| host → runtime | `service.command` | 启动、健康、排空或停止服务 |
| host → runtime | `surface.invoke` | 执行已声明的 Surface bridge 方法 |
| host → runtime | `runtime.configure` | 在安全边界应用下一轮设置或服务配置 |
| host → runtime | `runtime.dispose` | 释放所有资源 |
| runtime → host | `capability.invoke` | 请求宿主能力 |
| runtime → host | `event.emit` | 向所属 Surface 或运行 journal 发布有界事件 |
| runtime → host | `log.write` | 写入允许级别的脱敏日志 |

- 单条 IPC 消息默认不超过 1 MiB。
- 每个 invocation 有 deadline、结果上限和取消令牌。
- 未知 method、未知字段、错误版本或重复 requestId 均拒绝。
- 主进程按连接绑定 pluginId/version/hash，不信任消息自报身份。
- 进程退出后所有未完成 invocation 返回 `PLUGIN_RUNTIME_EXITED`，迟到结果丢弃。

### 8.3 Runtime 环境

- 清除产品凭据和无关环境变量。
- 工作目录指向不可变包根或临时目录。
- stdout/stderr 由宿主有界采集，不能直接进入用户可见日志。
- 不注入 Electron；不允许打开窗口、修改应用文件或直接访问 IPC。
- 只允许从包内已签名文件加载 runtime 和静态资源。
- 不允许动态远程代码、即时安装依赖或修改活动包目录。

## 9. Capability Broker

### 9.1 设计原则

- Manifest 声明请求，Host policy 决定可用，Session/run 决定本次能否使用，单次审批决定高风险动作。
- 每次 Broker 调用都从连接上下文取得 plugin/module/session/project/run，不接受调用方自报。
- 文件参数只接受作用域内相对路径；凭据只接受 `credentialRef`；进程和网络请求必须受审批策略约束。
- 返回值有字节预算、脱敏和稳定错误码，不允许透传任意宿主异常。
- 能力提供者由宿主注册并版本化，插件不能把自身新增为宿主级能力提供者。

### 9.2 核心能力

| Capability | 主要方法 | 必须校验 |
| --- | --- | --- |
| `session.read` | 读取当前会话摘要 | Session 可见、未归档、仍是同一 run |
| `project.files.read` | 读取授权项目内的相对文件 | root、realpath、大小、符号链接、路径逃逸 |
| `project.files.write` | 原子写入授权范围 | 写锁、revision、用户覆盖、权限模式 |
| `plugin.state.read/write` | 私有 JSON 状态 | 插件命名空间、schema、大小、CAS |
| `artifact.read/write` | 版本化产物和句柄 | 产物归属、版本、摘要、项目边界 |
| `project.changes.subscribe` | 订阅授权范围内的变化 | 路径范围、取消、事件预算、重连快照 |
| `job.runtime` | 创建、更新、查询和取消持久任务 | 幂等键、运行租约、终态、恢复引用 |
| `agent.delegate` | 在宿主限定的范围内启动委派运行 | 模块归属、工具白名单、预算、审批和会话边界 |
| `surface.emit` | 向指定 Surface 发事件 | Surface owner、订阅 token、消息预算 |
| `agent.progress` | 当前工具调用进度 | run 仍活跃、invocation 匹配 |
| `http.request` | 受控 HTTP | 方法、协议、origin、正文预算、审批和重定向 |
| `remote.execute` | 受控远程命令 | host/resource 授权、命令/参数、确认、审计 |
| `media.catalog` | 读取可用模型/工作流目录 | 当前项目、服务身份、无凭据泄露 |
| `media.execute` | 提交和查询媒体任务 | 媒体授权、任务归属、预算、重复提交保护 |
| `media.export` | 导出受控媒体 | 目标格式、大小、路径和用户确认 |

`remote.execute` 不是通用 shell 句柄：能力提供者只能是宿主已注册的服务器运维或等价受信服务，调用仍需原有审批与审计。

凭据不提供“读取明文”的通用 API。`credentialRef` 只作为 `http.request`、`remote.execute` 或宿主注册的受信能力参数，由能力提供者在宿主内解析。

`agent.delegate` 不是任意提示词执行器。委派运行必须由宿主使用当前 Session、项目、预算和显式工具白名单创建；插件不能指定模型凭据、突破父运行权限或接触无关会话。

### 9.3 能力提供者

```ts
interface HostCapabilityProvider<TRequest, TResponse> {
  readonly id: string
  readonly version: string
  readonly permissions: readonly string[]
  invoke(input: {
    request: TRequest
    caller: TrustedPluginCaller
    signal: AbortSignal
  }): Promise<TResponse>
}
```

- 只有宿主编译期注册的模块能成为 capability provider。
- 每个 provider 有独立的输入 Schema、输出预算和审计策略。
- 插件之间的依赖不能传递宿主能力；依赖插件只能调用公开插件 export。
- 能力增加必须提升 Host API minor；删除、语义变化或收紧返回结构提升 major。

### 9.4 并发

- 单插件默认最多 8 个并发 invocation，达到上限返回 `PLUGIN_RUNTIME_BUSY`，不静默排队到无限。
- 同一工具声明 `concurrencyKey` 后，宿主按 plugin + key 串行化；写文件和项目产物另由业务租约串行化。
- 每个 invocation 有独立取消和 deadline；取消一个调用不影响其它调用。
- Runtime 实例可服务多个 Session，但不能把 Session 私密数据写进进程级全局缓存；所有访问都必须使用当前调用签发的 capability 上下文。

### 9.5 撤销与迟到调用

- 模块从 Session 移除后，宿主立即撤销新工具/能力调用资格。
- 当前 invocation 默认继续到安全点，除非用户明确停止或插件停用。
- 插件升级或卸载先停止新准入；有活动 invocation 时进入 draining。
- broker 在每次副作用提交前重新检查运行租约；旧 token 不得提交新结果。
- 远端副作用终态不确定时返回 `PLUGIN_SIDE_EFFECT_UNKNOWN`，不得自动重试。

## 10. Agent 工具贡献

### 10.1 工具命名

manifest 的 `tools[].id` 是稳定插件内 ID。Pi 可见名默认由分配器生成：

```text
plugin_<publisher>_<plugin>_<tool>
```

- 只允许 `[a-z][a-z0-9_]{0,63}`。
- 冲突时安装失败，不按加载顺序覆盖。
- 现有五个内置模块的旧工具名暂由兼容映射保留，不要求迁移。
- `module-tool-policy` 从 Contribution Registry 取得工具所属模块，不再要求每次新增模块都改前缀表。

### 10.2 工具装配

1. 从 Session 策略与显式调用解析激活模块。
2. 解析 Skill 引用、提示、插件版本/hash 和权限快照。
3. 从 Contribution Registry 查询激活模块声明的工具。
4. 宿主创建闭包；闭包只引用冻结的 plugin/module/run 快照。
5. 与现有 MCP、自定义工具和内置工具合并，检测名称冲突。
6. 每次执行复核模块仍激活、插件仍运行、版本/hash 未漂移。
7. 将结果按 JSON 预算、错误码和审计规则回传 Pi。

### 10.3 审批

工具声明不能绕过宿主审批：

- `readOnly` 只是提示，实际只读准入由宿主能力与业务策略决定。
- `approval=per-call` 由宿主在每次调用前进入现有审批 UI。
- 工具调用网络、凭据、项目写入或远程操作时，最终审批以 Broker 能力为准。
- 模型提供的参数只能决定业务输入，不能指定审批结果、凭据正文或调用者身份。

## 11. Surface 贡献

### 11.1 Surface 生命周期

- 插件模块激活时，Surface 元数据进入 Session 目录。
- 用户打开 Surface 才加载静态 bundle，不预加载所有插件 UI。
- 插件全局启用但模块未附着时，Surface 可进入明确的只读浏览模式；只允许宿主签发的只读 artifact/project 能力，不允许 Agent 工具、项目写入或外部副作用。插件全局停用时，Surface bundle 不启动，只通过宿主通用只读查看器访问历史产物。
- Surface 发起需要 Agent/写入能力的动作前再次校验模块激活。
- 关闭 Surface 只释放可见文档；模块激活仍保留。停用模块或插件才撤销能力。
- 同一 Surface 可同时出现在一个 Session 的右侧主机；首期不允许跨窗口复制可写状态。

### 11.2 隔离与资源

- 每个 Surface 在独立 iframe 文档加载，使用 `sandbox="allow-scripts"`，不加 `allow-same-origin`。
- iframe 用于权限隔离和宿主 DOM 分隔，不承诺抵御已信任插件代码对宿主的人为攻击；插件代码的可信前提仍成立。
- 资源通过宿主注册的只读协议加载，URL 包含不可伪造的 Surface token。
- CSP 默认禁止外部连接、表单提交、顶层导航、弹窗、下载和外部字体。
- 外部网络只能通过 `http.request` 能力，不得由页面直接 fetch。
- 图片和媒体通过宿主签发的短时只读 asset token 展示；token 绑定 plugin、surface、session、project 和过期时间。
- Surface 文档不继承宿主 CSS、全局变量、preload API 或 localStorage。

### 11.3 Bridge

```ts
interface PluginSurfaceBridge {
  ready(): Promise<SurfaceContext>
  invoke(method: string, input: unknown): Promise<unknown>
  on(event: string, listener: (payload: unknown) => void): () => void
}
```

- bridge 方法白名单来自 manifest 和授权能力。
- `bridge.invoke(method, input)` 由宿主核对 Surface token、method 声明和只读写状态，再通过 `surface.invoke` RPC 转给 runtime handler。
- `SurfaceContext` 只包含 surface 身份、显示名、当前 project/session 摘要和主题 token。
- 写操作返回结构化回执；页面不能直接修改宿主 Jotai store。
- 事件由 MessageChannel 传递并带 request/event 序号与预算。
- bridge 断开后所有 pending 请求失败；重新打开生成新 token，不恢复旧 JS 状态。

### 11.4 Surface 错误

区分 `PLUGIN_SURFACE_ENTRY_MISSING`、`PLUGIN_SURFACE_CSP_VIOLATION`、`PLUGIN_SURFACE_BRIDGE_DENIED`、`PLUGIN_SURFACE_DISCONNECTED`、`PLUGIN_SURFACE_VERSION_CHANGED`。界面显示可行动原因，不能用空白面板替代。

## 12. 会话激活与运行快照

### 12.1 激活条件

模块可被当前 Session 激活，必须同时满足：

- 安装版本完整、签名可信且已全局启用；
- 平台、架构、Host API 和 runtime protocol 兼容；
- 模块 `activation=session-toggle`；
- 当前 Session 可见且满足模块 scope；
- 项目模块有有效项目和写权限；
- 依赖和必需 Skill 引用可解析；
- 所需能力至少获得最低授权；
- 当前没有不兼容的升级/draining 事务。

目录投影返回状态、版本、hash、来源和稳定 reason code。renderer 不复制安全判断。

### 12.2 冻结快照

```ts
interface PluginRunSnapshot {
  pluginId: string
  pluginVersion: string
  packageHash: string
  runtimeProtocol: 1
  modules: Array<{
    moduleId: string
    moduleVersion: string
    skillLocks: Array<{
      id: string
      scope: 'project' | 'workspace' | 'builtin'
      revision: string
      hash: string
    }>
    promptHashes: Record<string, string>
  }>
  capabilityGrants: string[]
  permissionRevision: number
  settingsRevision: number
  settingsHash: string
  sessionPolicyRevision: number
  frozenAt: number
}
```

- 当前运行只使用冻结快照。
- 插件升级、停用、权限撤销和设置修改从下一轮开始生效。
- 恢复必须核验原包、runtime、资源、权限和模块仍可用；不兼容时明确阻断。
- 旧运行完成前不删除其包和引用对象。

## 13. 生命周期与状态机

### 13.1 插件状态

```text
installed -> disabled -> enabling -> running -> draining -> disabled
                    \-> failed -> enabling
```

- `enabling` 只做启动和握手，不能产生业务副作用。
- `running` 才允许工具调用和 Surface bridge。
- `draining` 拒绝新 invocation，等待或按用户选择取消旧 invocation。
- `failed` 可从设置显式重试；不无限自动重启。
- 进程异常退出撤销当前运行工具，向用户报告 `PLUGIN_RUNTIME_EXITED`。
- 无可恢复 invocation 后释放监听器、Surface token、计时器、连接和临时文件。

### 13.2 启动策略

- 应用启动不自动拉起所有已安装插件。
- 全局启用只登记可启动资格。
- 首次 Session 激活或 Surface 需要时才启动 runtime。
- 无活动 Session 达 `idleStopMs` 后可停止；存在排队、运行、draining 或重连任务时不停止。
- 一个插件版本默认一个 runtime 实例，多个模块共享进程但 invocation 严格隔离。

### 13.3 崩溃与超时

- `tool.invoke` 超过声明 deadline 时先取消，再在宽限期后结束进程。
- RPC 无响应、进程退出或协议破坏都使实例失败。
- 同一异常不自动无限重启；用户可显式重试一次。
- 迟到工具结果、Surface event 和 capability response 带原实例 epoch，新实例忽略。

## 14. 数据、设置与产物所有权

### 14.1 插件私有数据

```text
<dataRoot>/agent-plugins/data/<pluginId>/
  state/<schemaVersion>/<key>.json
  cache/
  runtime/
```

- `state` 由宿主原子写入，是行为真相。
- `cache` 可回收，不承诺恢复。
- `runtime` 只存在临时的进程会话信息。
- 插件不能自行选择数据根。

### 14.2 项目数据

项目业务产物通过 `project.files` 或 `artifact` 能力访问。宿主为插件分配项目内命名空间，并继续使用现有项目写锁、权限、revision 和用户覆盖规则。

- 第三方插件默认只能访问自己的命名空间。
- 五个既有模块后续迁移时，可通过宿主登记的兼容适配器读取旧目录。
- 本次设计不改变任何现有模块数据位置。

### 14.3 卸载

默认保留：

- 插件私有状态；
- 项目产物和媒体；
- 用户设置；
- 审计和历史版本。

默认移除：

- runtime/Surface 准入；
- 活动工具和 bridge；
- 可安全回收的缓存。

必须保留有恢复引用或无替代版本的包。删除插件状态是单独确认动作，不从普通卸载隐式执行。

## 15. 信任、签名与授权

### 15.1 开发与生产

| 环境 | 未签名包 | 已签名但未信任 | 已信任 |
| --- | --- | --- | --- |
| 隔离开发数据根 | 可显式加载 | 可加载并显示指纹 | 可加载 |
| 普通用户数据根 | 拒绝 module-runtime | 只预览，拒绝运行 | 可安装/运行 |

- 未签名 runtime 只允许隔离测试根，并有持续可见的“开发中”标记。
- 开发包不能覆盖正式安装版本。
- 已签名包仍需用户确认插件身份、发布者指纹和能力清单。
- 同一 ID/版本不同摘要一律拒绝。
- 信任按 publisher key + plugin ID 绑定，不自动扩展到作者命名空间。

### 15.2 能力授权

安装确认页显示能力、影响和可能外部费用。应用更新若增加能力，必须在下次运行前重新确认。

- 读取项目、写项目、网络、凭据、远程操作、媒体执行分别授权。
- 单次高风险动作仍在调用时审批。
- 撤销能力立即阻止新 invocation；活动 invocation 到安全点停止。
- 插件 prompt、Skill 引用或工具注解不能自行批准或扩大能力。

## 16. 错误与可观测性

### 16.1 稳定错误分类

| 分类 | 示例 |
| --- | --- |
| 包与兼容 | `PLUGIN_PACKAGE_UNSUPPORTED`、`PLUGIN_HOST_API_UNSUPPORTED` |
| 信任与授权 | `PLUGIN_PUBLISHER_UNTRUSTED`、`PLUGIN_CAPABILITY_NOT_GRANTED` |
| 模块准入 | `PLUGIN_MODULE_NOT_ATTACHED`、`PLUGIN_MODULE_IDENTITY_CHANGED` |
| Runtime | `PLUGIN_RUNTIME_START_FAILED`、`PLUGIN_RUNTIME_EXITED`、`PLUGIN_RPC_TIMEOUT` |
| 工具 | `PLUGIN_TOOL_INPUT_INVALID`、`PLUGIN_TOOL_CANCELLED`、`PLUGIN_TOOL_RESULT_TOO_LARGE` |
| Surface | `PLUGIN_SURFACE_ENTRY_MISSING`、`PLUGIN_SURFACE_BRIDGE_DENIED` |
| Broker | `PLUGIN_CAPABILITY_SCOPE_DENIED`、`PLUGIN_SIDE_EFFECT_UNKNOWN` |

### 16.2 审计

每轮记录：

- 激活的 plugin/module/version/hash；
- Host API、runtime protocol、权限 revision 和设置 hash；
- 解析的 Skill revision/hash；
- runtime 启动/退出与 crash；
- 工具调用开始、结果、稳定错误码、耗时和是否审批；
- Surface 打开、bridge 授权、断连；
- 能力请求类型与结果，不记录密钥、完整用户正文或隐私参数。

工具声明、安装成功或 runtime ready 都不能计作业务调用成功。

## 17. 性能与资源边界

- 未选中模块时 runtime 启动次数、插件源码读取次数和工具注册次数均为 0。
- 插件目录只加载 manifest 摘要，不读取 runtime/Surface 正文。
- 每个插件 runtime 默认最多 1 个进程；进程复用不共享 invocation 状态。
- 每个插件最多 32 个模块、128 个工具、16 个 Surface、16 个服务。
- Runtime bundle 默认 16 MiB，Surface bundle 默认 32 MiB，V3 包沿用现有 50 MiB/200 MiB/2000 文件边界。
- 单 invocation 结果默认 256 KiB，progress 事件累计默认 1 MiB。
- 私有状态单条 1 MiB、单插件默认 100 MiB；Cache 单独计量且可回收。
- RPC 队列、stdout/stderr、Surface event 和日志都有固定上限，满时 fail closed 并提示。
- 停止/崩溃后活动监听器、计时器、Surface token 和 pending invocation 必须归零。

性能验收需记录设备、插件样本、冷/热启动、激活延迟、内存和空闲退出时间；没有实测不得宣称达标。

## 18. 开发者工作流

### 18.1 脚手架

新增 `module-runtime` 模板：

```text
my-plugin/
  plugin.json
  src/runtime.ts
  src/surfaces/workspace/
    index.html
    main.ts
    style.css
  prompts/workflow.md
  tests/plugin.contract.test.ts
  package.json
  README.md
  LICENSE
  CHANGELOG.md
  THIRD_PARTY_NOTICES.md
```

模板包含：

- 一个只读 echo 工具；
- 一个最小 Surface；
- 一个懒启动服务；
- 声明式设置；
- capability 拒绝用例；
- 无宿主内部 import 的构建检查。

### 18.2 CLI

```bash
dutydeck-plugin init my-plugin --id acme.my-plugin --profile module-runtime
dutydeck-plugin validate my-plugin
dutydeck-plugin build my-plugin
dutydeck-plugin test my-plugin
dutydeck-plugin pack my-plugin --out my-plugin.ddplugin --development
dutydeck-plugin publisher init --config-dir ../keys
dutydeck-plugin pack my-plugin --out my-plugin.ddplugin --release --config-dir ../keys
dutydeck-plugin verify my-plugin.ddplugin --trusted-key <fingerprint>
```

- `build` 产生自包含 runtime 和 Surface bundle。
- `validate` 检查 manifest、贡献、能力、路径和 bundle。
- `test` 只运行插件公开契约夹具，不执行任意用户安装脚本。
- `pack` 只收录白名单文件。
- 开发者可在隔离数据根加载未签名包；正式分发必须签名。

### 18.3 本地开发

- 开发 root 与真实业务 root 分离，或显式启用测试项目副本。
- 插件热重载只作用于开发实例；工具和 Surface 请求在重载时 fail closed。
- 每次构建提升 dev runtime epoch；旧请求和旧 Surface 不能把结果写入新 epoch。

### 18.4 UI 开发约定

- Surface 可以使用作者自选框架，但最终必须构建成自包含静态 bundle。
- SDK 可另外提供可选 `@dutydeck/plugin-ui` 主题 token 与基础组件；它是构建期资源，不提供宿主 store、IPC 或隐藏 preload。
- 宿主向 Surface 注入 `light`/`dark`、字体、间距、圆角、危险色和 reduced-motion 等语义 token。
- 插件必须处理加载、空、错误、禁用、键盘焦点和窄窗口；不得覆盖宿主根样式或依赖宿主内部 class name。
- 首期不开放插件自定义 Agent 消息渲染器。工具返回结构化 JSON 和 artifact 句柄，由宿主通用渲染；需要专用交互时使用插件 Surface。

## 19. Host 与现有代码的兼容策略

### 19.1 本轮不迁移

- `agent-orchestrator.ts` 中五个模块的现有 Facade 和工具装配保持。
- 现有内置模块 manifest、右侧静态 Surface 和数据位置保持。
- 内容插件 V1/V2 读取、安装、关闭和卸载保持。
- 当前未提交的影像改动不纳入本设计实施，也不被回退。

### 19.2 通用接入点

实施只增加与现有代码并存的通用入口：

- V3 contribution registry 与现有 `AgentPluginRegistry` 合并投影。
- `module-tool-policy` 优先查 registry 的工具归属；无登记时保留旧前缀兼容。
- `SidePanel` 增加动态 Surface host；现有五个分支继续保留。
- Plugin Host 增加 runtime contribution 生命周期；现有内置虚拟包继续使用旧 adapter。
- Agent resolver 继续处理 Skill/prompt；V3 runtime 只增加工具和 Surface 执行贡献。

### 19.3 后续迁移适配方式

五个模块未来迁移时：

1. 在各自插件中实现同一 V3 合同。
2. 用宿主 capability adapter 包装共享媒体、项目存储和远程服务。
3. 先让插件贡献与旧实现并存，通过比对测试确认行为一致。
4. 再删除对应 orchestrator 分支和静态 renderer import。
5. 历史会话通过稳定模块 ID 和兼容数据 adapter 继续读取。

本次底座设计完成不等于任何模块已完成迁移。

## 20. 测试与验收

### 20.1 SDK/包校验

- V1/V2 仍可解析；旧客户端拒绝 V3。
- V3 模块/工具/Surface/服务 ID 唯一且 owner 引用有效。
- 未声明 runtime、错误 entry、远程 URL、绝对路径和未知字段被拒绝。
- content 插件不能声明 runtime capability。
- runtime/Surface 文件缺失、摘要不符、未列入 integrity 时拒绝。
- 签名变化、同版本不同摘要和扩展 capability 的更新被识别。

### 20.2 Runtime

- 冷启动、握手、ready、工具调用、取消、超时、排空和释放。
- 握手贡献多于/少于 manifest 时失败。
- 两个插件工具同名时拒绝，不覆盖。
- 插件崩溃只影响自身；其他插件继续工作。
- 旧 instance epoch 的 response/event 不写入新实例。
- stdout/stderr、RPC 和结果超出预算时稳定失败。

### 20.3 Broker

- 插件不能读取未授权项目、插件私有目录之外的路径或另一个插件状态。
- 未授权网络、凭据、远程执行和媒体任务在执行前被拒绝。
- 项目写入遵循 CAS、租约和用户审批。
- 插件停用或版本变化后旧 capability token 不能提交新副作用。
- 终态不明的外部操作不自动重试。

### 20.4 Agent

- 模块未激活时没有工具、prompt 和 Surface 写入口。
- Session 激活后工具进入下一轮，运行中开关只下一轮生效。
- 工具闭包身份来自宿主编织器，模型不能伪造 pluginId/moduleId/projectId。
- 队列、恢复、Automation 和委派均经过同一快照校验。
- 工具结果被 Pi 正常读取，错误码和取消可被模型与 UI 识别。

### 20.5 Surface

- 未打开 Surface 时不加载 bundle。
- iframe 不能读取宿主 preload、cookie、localStorage 或任意项目 URL。
- 未声明 bridge 方法被拒绝。
- 停用模块、项目切换和版本变化使旧 token 失效。
- 深浅主题、窄窗口、键盘和错误状态可用；插件 CSS 不污染宿主。
- 大事件、断连、崩溃和迟到消息不阻塞宿主。

### 20.6 开发者闭环

在仓库外临时目录仅安装 SDK/CLI 发行物，执行：

1. 创建 module-runtime 插件；
2. 实现 echo 工具和 Surface；
3. validate/build/test；
4. 在隔离开发数据根加载；
5. 用真实 Electron preload/main 运行工具与 Surface；
6. 签名打包；
7. 安装、激活、停用、重载、卸载；
8. 确认无需修改宿主业务代码。

该验收不调用收费模型、不接触真实用户作品或凭据。

### 20.7 必跑命令

```bash
bun test packages/plugin-sdk
bun test packages/plugin-kit
bun test apps/electron/src/main/lib/agent-modules
bun test apps/electron/src/main/lib/agent-plugins
bun test apps/electron/src/main/lib/agent-orchestrator.test.ts
bun run typecheck
bun run electron:build
```

若新增真实 Electron Surface smoke，还需在目标平台执行打包后应用验证；受限沙箱无法启动 Chromium 时按项目规则申请沙箱外执行。

## 21. 实施拆分建议

本轮能力底座拆成六步，不迁移五模块：

1. **公开合同**：V3 manifest、runtime API、capability API、错误类型和纯校验器。
2. **打包与脚手架**：SDK/CLI 支持 runtime/Surface 构建、白名单打包和 module-runtime fixture。
3. **Runtime Supervisor**：utility 启动、握手、RPC、取消、崩溃与 epoch 隔离。
4. **Broker 与 Registry**：注册核心能力、工具/Surface 贡献和运行身份。
5. **Agent 与 Surface 集成**：动态工具闭包、Session 激活、受限 Surface host 和 bridge。
6. **外部作者验收**：仓库外安装发行物，完成从脚手架到本地运行/签名/卸载的闭环。

每一步先写 BDD 失败测试，再实现，最后提供定向测试、类型检查、构建和差异检查证据。没有宿主源码导入、没有五模块业务迁移，才符合本轮目标。

## 22. 完成定义

只有同时满足以下条件，才能声称“插件模块已能支持五类业务并开放开发者能力”：

- 开发者能从公开脚手架创建 module-runtime 插件；
- 插件可注册 Agent 工具、Surface、服务、状态和所需能力；
- 工具与 Surface 只能访问当前 Session/run 已授权的资源；
- 停用、崩溃、取消和版本变化能撤销贡献且不破坏其它插件；
- 无业务模块迁移也能用 fixture 在真实 Electron 中完成安装、激活、调用、打开界面、停用和卸载；
- V1/V2 content 插件与现有五个模块行为保持；
- 文档明确 utility 进程不是恶意代码沙箱，第三方未签名可执行包仍被拒绝。

仅新增 manifest 字段、空 lifecycle adapter、只移动文件或一个单元测试通过，都不能算完成。
