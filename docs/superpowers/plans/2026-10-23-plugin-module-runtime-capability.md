# 插件模块通用运行时与能力底座实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不迁移五个既有业务模块的前提下，交付可被开发者使用、能承载模块工具/Surface/服务/状态/宿主能力的 V3 插件运行时底座。

**Architecture:** V1/V2 内容插件保持原路径；新增 V3 `module-runtime` 合同和独立 utility runtime。宿主将 manifest 与 runtime 握手冻结为贡献清单，通过 Capability Broker、Agent 工具代理和隔离 Surface bridge 提供受控能力。现有 Canvas、影像、交互设计、服务器运维和接口工作台继续走原实现，只用 echo fixture 验证新底座。

**Tech Stack:** Bun、TypeScript、Electron utility process、Pi Agent runtime、React、Jotai、JSON Schema、Ed25519、现有 safe-file/原子写。

---

## 实施状态

2026-10-23 首个能力底座已落地：

- V3 manifest、公开 Schema、runtime API、RPC 合同和能力 ID 已加入 `@dutydeck/plugin-sdk`。
- `@dutydeck/plugin-kit` 支持 module-runtime 脚手架、build、V3 白名单打包和 Surface/runtime 资源。
- Electron 已接入 V3 安装服务、不可变包展开、持久注册、启停/卸载、utility runtime supervisor、Runtime RPC、Contribution Registry、工具代理和插件私有状态。
- Session 目录、右侧工具栏、动态插件 Pane、sandboxed iframe、MessagePort bridge、CSP 自定义协议和设置安装入口已接通。
- 真实 Electron smoke 已验证包安装、utility 握手、Agent 工具调用、Surface 调用和释放，包 hash 为 `b4ce63b24c8cfc5550fe4fed4e4bae43091fc4bce1da536b6510ee3d83b9bffe`。
- 五个既有业务模块没有迁移；V1/V2 content 路径继续保留。

仍明确保留的后续边界：

- Capability Broker 已能注册宿主 provider；当前生产 provider 为 `session.read`、`plugin.state.read/write`。项目文件、网络、远程运维、媒体、导出和 Agent 委派 provider 需要在后续按现有业务 Facade 或独立受信服务接入，不能直接向插件开放底层能力。
- V3 安装使用文件锁和 revision，但跨应用实例的完整管理租约尚未接入现有 data-root lease。
- Surface sandbox 不是恶意代码安全沙箱；V3 仍只允许签名且经用户明确信任的开发者插件，utility 进程用于故障隔离。
- 本轮 UI 定向测试覆盖渲染和状态合同；完整设置页点击到真实安装、Surface 打开、停用和卸载的 BrowserWindow 自动化尚未执行。

## 约束

- 不修改五个业务模块的数据位置、工具语义、审批边界或现有未提交改动。
- 所有生产代码先写失败测试并确认 RED，再写最小实现。
- V1/V2 content 行为必须保持；V3 必须与旧解析器隔离。
- 公共 SDK 不依赖 Electron、宿主 shared 或 monorepo 内部路径。
- utility 进程不是恶意代码沙箱；生产 V3 包必须签名并由用户建立发布者信任。
- 没有用户明确要求时不提交 Git；每个任务完成后执行定向测试和差异检查。

## 文件边界

```text
packages/plugin-sdk/src/v3.ts                          V3 manifest 和 runtime API 纯合同
packages/plugin-sdk/src/v3-validation.ts               V3 结构/引用/跨字段校验
packages/plugin-sdk/src/runtime-protocol.ts            RPC 消息和稳定错误
packages/plugin-sdk/src/capabilities.ts                能力 ID、请求/响应合同
packages/plugin-sdk/tests/v3.test.ts                    SDK 契约测试

packages/plugin-kit/src/build.ts                       把源工程构建为 runtime/Surface bundle
packages/plugin-kit/src/package.ts                     V3 文件白名单和打包
packages/plugin-kit/templates/module-runtime/          开发者运行时模板

apps/electron/src/main/lib/agent-plugins/runtime-rpc.ts
apps/electron/src/main/lib/agent-plugins/runtime-supervisor.ts
apps/electron/src/main/lib/agent-plugins/capability-broker.ts
apps/electron/src/main/lib/agent-plugins/contribution-registry.ts
apps/electron/src/main/lib/agent-plugins/surface-registry.ts
apps/electron/src/utility/plugin-runtime.ts
apps/electron/src/renderer/components/plugins/PluginSurfaceHost.tsx

examples/plugins/runtime-fixture/
  plugin.json
  src/runtime.ts
  src/surfaces/workspace/index.html
  src/surfaces/workspace/main.ts
  tests/runtime-contract.test.ts
```

公共入口、主 IPC、preload 和 orchestrator 只由一个集成分支修改，避免并行覆盖。

### Task 1: 冻结 V3 manifest 与运行时 API

**Files:**
- Create: `packages/plugin-sdk/src/v3.ts`
- Create: `packages/plugin-sdk/src/v3-validation.ts`
- Create: `packages/plugin-sdk/src/runtime-protocol.ts`
- Create: `packages/plugin-sdk/src/capabilities.ts`
- Modify: `packages/plugin-sdk/src/index.ts`
- Modify: `packages/plugin-sdk/scripts/generate-schema.ts`
- Modify: `packages/plugin-sdk/package.json`
- Test: `packages/plugin-sdk/tests/v3.test.ts`

- [ ] **Step 1: 写 V3 失败测试**

```ts
import { describe, expect, test } from 'bun:test'
import { parsePluginManifestV3 } from '../src/index.js'

const manifest = {
  formatVersion: 3,
  apiVersion: '1.0.0',
  id: 'acme.design-tools',
  publisherId: 'acme',
  version: '1.0.0',
  displayName: '设计工具',
  description: '运行模块',
  license: 'MIT',
  profile: 'module-runtime',
  compatibility: {
    hostApi: '^1.0.0',
    runtimeProtocol: 1,
    platforms: ['darwin'],
    architectures: ['arm64'],
  },
  runtime: { entry: 'runtime/main.mjs', format: 'module-esm' },
  modules: [{
    id: 'inspector',
    displayName: '检查',
    description: '检查项目',
    icon: 'search',
    activation: 'session-toggle',
    skillRefs: [],
    promptRefs: ['workflow'],
    tools: ['inspect'],
    surfaces: ['workspace'],
    services: ['index'],
    artifacts: ['report'],
  }],
  tools: [{
    id: 'inspect',
    ownerModuleId: 'inspector',
    title: '检查',
    description: '检查项目',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
    approval: 'none',
    timeoutMs: 30000,
  }],
  surfaces: [{
    id: 'workspace',
    ownerModuleId: 'inspector',
    title: '检查',
    entry: 'surfaces/workspace/index.html',
    apiVersion: 1,
    defaultPlacement: 'right-panel',
    methods: ['load'],
  }],
  services: [{ id: 'index', title: '索引', start: 'lazy', idleStopMs: 300000 }],
  artifacts: [{
    id: 'report',
    ownerModuleId: 'inspector',
    title: '报告',
    schemaVersion: 1,
    mimeTypes: ['application/json'],
    retention: 'project',
  }],
  prompts: [{ id: 'workflow', version: '1.0.0', kind: 'workflow', path: 'prompts/workflow.md' }],
  settings: [{
    key: 'limit',
    type: 'integer',
    label: '上限',
    defaultValue: 10,
    minimum: 1,
    maximum: 100,
    apply: 'next-run',
  }],
  capabilities: ['session.read', 'project.files.read'],
  dependencies: [],
  exports: [],
}

describe('Given V3 module-runtime manifest', () => {
  test('When 完整合同 Then 规范化模块 ID 与默认工具名', () => {
    const parsed = parsePluginManifestV3(manifest)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.modules[0]?.id).toBe('acme.design-tools.inspector')
    expect(parsed.value.tools[0]?.agentName).toBe('plugin_acme_design_tools_inspect')
  })

  test('When 工具 owner 不存在 Then 返回字段定位', () => {
    const parsed = parsePluginManifestV3({
      ...manifest,
      tools: [{ ...manifest.tools[0], ownerModuleId: 'missing' }],
    })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.issues[0]?.field).toContain('ownerModuleId')
  })

  test('When 使用 V3 runtime 执行字段但 profile 为 content Then 拒绝', () => {
    expect(parsePluginManifestV3({ ...manifest, profile: 'content' }).ok).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
bun test packages/plugin-sdk/tests/v3.test.ts
```

Expected: FAIL，`parsePluginManifestV3` 尚未导出。

- [ ] **Step 3: 增加合同与解析器**

`v3.ts` 定义 V3 manifest、模块、工具、Surface、服务、产物、设置和 capability 请求。`v3-validation.ts` 复用现有严格对象/Schema 子集，完成：

- 身份与 SemVer；
- 模块、工具、Surface、服务、产物 ID 唯一；
- owner/reference 必须存在；
- tool schema 仅 JSON Schema 数据；
- Surface entry 和 runtime entry 必须是 portable path；
- 模块/工具总数和字符串长度预算；
- `plugin_<publisher>_<plugin>_<tool>` 工具名生成与冲突检查；
- content 包不得进入 V3 解析。

`runtime-protocol.ts` 定义 `PluginRpcEnvelope`、`RuntimeHello`、`ToolInvoke`、`SurfaceInvoke`、`CapabilityInvoke` 和稳定错误码。`capabilities.ts` 定义首批能力 ID 与 JSON-safe 请求/响应联合。

- [ ] **Step 4: 生成公开 Schema**

在 `generate-schema.ts` 同时输出 `plugin-manifest-v3.schema.json`，在 `package.json.files` 中加入该文件并增加 `./schema-v3` export。

- [ ] **Step 5: 运行 GREEN**

Run:

```bash
bun test packages/plugin-sdk/tests
bun run --cwd packages/plugin-sdk build
```

Expected: 全部通过且两份 Schema 由 TypeScript 定义生成。

### Task 2: 支持 V3 打包与开发者模板

**Files:**
- Modify: `packages/plugin-kit/src/package.ts`
- Modify: `packages/plugin-kit/src/scaffold.ts`
- Modify: `packages/plugin-kit/src/cli.ts`
- Modify: `packages/plugin-kit/src/package.test.ts`
- Modify: `packages/plugin-kit/src/cli.test.ts`
- Create: `packages/plugin-kit/src/build.ts`
- Create: `packages/plugin-kit/templates/module-runtime/plugin.json.template`
- Create: `packages/plugin-kit/templates/module-runtime/src/runtime.ts`
- Create: `packages/plugin-kit/templates/module-runtime/src/surfaces/workspace/index.html`
- Create: `packages/plugin-kit/templates/module-runtime/src/surfaces/workspace/main.ts`
- Create: `packages/plugin-kit/templates/module-runtime/src/surfaces/workspace/style.css`
- Create: `packages/plugin-kit/templates/module-runtime/tests/plugin.contract.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
test('Given V3 runtime 工程 When pack Then 只收录声明入口和静态 Surface', () => {
  const files = createModuleRuntimePluginFiles('acme.echo', '回显')
  files.set('runtime/main.mjs', new TextEncoder().encode('export {}'))
  files.set('surfaces/workspace/index.html', new TextEncoder().encode('<html></html>'))
  const packed = inspectPluginPackage(createPluginPackage(files))
  expect(packed.manifest.formatVersion).toBe(3)
  expect(packed.files.has('runtime/main.mjs')).toBe(true)
  expect(packed.files.has('src/runtime.ts')).toBe(false)
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
bun test packages/plugin-kit/src/package.test.ts
```

Expected: FAIL，V3 runtime 文件被当前白名单过滤。

- [ ] **Step 3: 实现 V3 白名单和构建**

- V2 `RESOURCE_FILE` 保持。
- V3 增加 `runtime/**/*.mjs`、`surfaces/**/*.{html,js,css,png,jpg,jpeg,webp,gif,svg,woff2}`。
- 所有 runtime/Surface 文件必须在 manifest 声明范围内，或属于其目录内的相对静态依赖。
- `build` 使用 Bun 构建自包含 ESM 和静态 Surface；不新增第三方依赖。
- `init --profile module-runtime` 生成可构建的 echo 插件。
- V2 `init` 默认行为保持，V3 必须显式选择，避免悄悄改变现有作者合同。

- [ ] **Step 4: GREEN**

Run:

```bash
bun test packages/plugin-kit/src
bun run --cwd packages/plugin-kit build
```

Expected: V2/V3 测试通过；输出名称、入口和资源归属一致。

### Task 3: Runtime RPC、Supervisor 与崩溃边界

**Files:**
- Create: `apps/electron/src/main/lib/agent-plugins/runtime-rpc.ts`
- Create: `apps/electron/src/main/lib/agent-plugins/runtime-supervisor.ts`
- Create: `apps/electron/src/main/lib/agent-plugins/runtime-supervisor.test.ts`
- Create: `apps/electron/src/utility/plugin-runtime.ts`

- [ ] **Step 1: 写 RPC/生命周期失败测试**

```ts
test('Given runtime 握手贡献多于 manifest When 启动 Then 失败且不注册工具', async () => {
  const supervisor = createTestSupervisor({
    hello: { tools: ['forged'] },
  })
  await expect(supervisor.start(snapshot())).rejects.toThrow('PLUGIN_RUNTIME_CONTRIBUTION_MISMATCH')
  expect(supervisor.listInvocations()).toEqual([])
})

test('Given tool invocation pending When process exits Then 返回稳定错误', async () => {
  const supervisor = createTestSupervisor({ hangTool: true })
  const running = supervisor.start(snapshot())
  await running
  const call = supervisor.invokeTool('inspect', {}, new AbortController().signal)
  supervisor.simulateExit(1)
  await expect(call).rejects.toThrow('PLUGIN_RUNTIME_EXITED')
})
```

- [ ] **Step 2: RED**

Run:

```bash
bun test apps/electron/src/main/lib/agent-plugins/runtime-supervisor.test.ts
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现运行时监督**

- 使用可注入 child transport 包装 Electron utility process，让测试不启动真实 Electron。
- 每个实例有 `pluginId/version/packageHash/epoch` 和唯一 `AbortController`。
- 握手严格比较 manifest 的工具/Surface/服务集合。
- 维护 invocation map、deadline、取消、结果预算和迟到结果拒绝。
- stdout/stderr 有界采集；只把稳定 error code 暴露给 Agent。
- 正常停止顺序：stop new → drain → dispose → kill grace → kill。
- 崩溃不会自动无限重启。

`plugin-runtime.ts` 负责动态 import 包内 runtime、调用 `definePlugin()`、建立 RPC。它不 import 宿主业务。

- [ ] **Step 4: GREEN**

Run:

```bash
bun test apps/electron/src/main/lib/agent-plugins/runtime-supervisor.test.ts
bun run --filter @dutydeck/electron typecheck
```

Expected: runtime 生命周期、cancellation、exit 和 epoch 测试通过。

### Task 4: Capability Broker

**Files:**
- Create: `apps/electron/src/main/lib/agent-plugins/capability-broker.ts`
- Create: `apps/electron/src/main/lib/agent-plugins/capability-broker.test.ts`

- [ ] **Step 1: 写权限失败测试**

```ts
test('Given 未授权 project.write When 插件请求 Then 在 provider 前拒绝', async () => {
  let providerCalls = 0
  const broker = createCapabilityBroker({
    providers: new Map([['project.files.write', async () => { providerCalls += 1 }]]),
  })
  await expect(broker.invoke(caller({ grants: ['project.files.read'] }), {
    capability: 'project.files.write',
    input: { relativePath: 'a.md', content: 'x' },
  })).rejects.toThrow('PLUGIN_CAPABILITY_NOT_GRANTED')
  expect(providerCalls).toBe(0)
})
```

- [ ] **Step 2: RED**

Run:

```bash
bun test apps/electron/src/main/lib/agent-plugins/capability-broker.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现最小安全 Broker**

- 能力 ID allowlist；
- caller 从宿主上下文注入，拒绝自报 plugin/module/run；
- manifest grant、当前快照、运行租约三次检查；
- provider 注册表与稳定错误；
- JSON 输入/输出大小预算；
- invocation cancel 传递；
- 副作用提交前复核租约。

首批 provider 只实现与 fixture 无关的测试 provider；真实项目/网络/媒体 provider 后续以适配器加入，不在本轮替换业务服务。

- [ ] **Step 4: GREEN**

Run:

```bash
bun test apps/electron/src/main/lib/agent-plugins/capability-broker.test.ts
bun run --filter @dutydeck/electron typecheck
```

Expected: 未授权、身份伪造、旧租约和输出超预算均被拒绝。

### Task 5: 动态贡献注册与 Agent 工具代理

**Files:**
- Create: `apps/electron/src/main/lib/agent-plugins/contribution-registry.ts`
- Create: `apps/electron/src/main/lib/agent-plugins/contribution-registry.test.ts`
- Create: `apps/electron/src/main/lib/agent-plugins/tool-proxy.ts`
- Create: `apps/electron/src/main/lib/agent-plugins/tool-proxy.test.ts`
- Modify: `apps/electron/src/main/lib/agent-modules/module-tool-policy.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify: `apps/electron/src/main/lib/agent-service.ts`

- [ ] **Step 1: 写注册冲突与身份测试**

```ts
test('Given 两个插件生成相同 agentName When 注册 Then 拒绝第二个', () => {
  const registry = new ContributionRegistry()
  registry.register(pluginContribution('a.demo', 'inspect', 'plugin_a_demo_inspect'))
  expect(() => registry.register(pluginContribution('b.demo', 'inspect', 'plugin_a_demo_inspect')))
    .toThrow('PLUGIN_TOOL_NAME_CONFLICT')
})
```

- [ ] **Step 2: RED**

Run:

```bash
bun test apps/electron/src/main/lib/agent-plugins/contribution-registry.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 registry 和 proxy**

- registry 按 plugin/version/hash 保存工具、Surface、服务、artifacts；
- `module-tool-policy` 先查 registry 的 owner mapping，未登记时保留现有前缀规则；
- 工具闭包捕获运行快照，不在执行时读取 renderer 或当前全局模块状态；
- 每次调用检查插件 running、模块 active、version/hash、租约和 deadline；
- 工具结果转换为 Pi 允许的内容；
- 旧五个内置工具不迁移，现有测试必须保持通过。

只在 Agent prepare 阶段将激活模块对应的插件工具加入 `piCustomTools`。普通消息未激活模块时，不启动 runtime、不读取插件代码。

- [ ] **Step 4: GREEN**

Run:

```bash
bun test apps/electron/src/main/lib/agent-plugins
bun test apps/electron/src/main/lib/agent-modules/module-tool-policy.test.ts
bun test apps/electron/src/main/lib/agent-orchestrator.test.ts
```

Expected: 新插件工具被装配，旧模块前缀门禁无回归。

### Task 6: Surface Registry、隔离页面与 Bridge

**Files:**
- Create: `apps/electron/src/main/lib/agent-plugins/surface-registry.ts`
- Create: `apps/electron/src/main/lib/agent-plugins/surface-registry.test.ts`
- Create: `apps/electron/src/preload/plugin-surface-preload.ts`
- Create: `apps/electron/src/renderer/components/plugins/PluginSurfaceHost.tsx`
- Create: `apps/electron/src/renderer/components/plugins/PluginSurfaceHost.test.tsx`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/index.ts`
- Modify: `apps/electron/src/renderer/components/agent/SidePanel.tsx`

- [ ] **Step 1: 写 Surface token 和 bridge 失败测试**

```ts
test('Given Surface token 来自旧 epoch When 调用 bridge Then 拒绝', () => {
  const registry = new SurfaceRegistry()
  const token = registry.open(surfaceContext({ epoch: 1 }))
  registry.rotateEpoch('acme.echo', 2)
  expect(() => registry.authorize(token, 'load')).toThrow('PLUGIN_SURFACE_VERSION_CHANGED')
})
```

- [ ] **Step 2: RED**

Run:

```bash
bun test apps/electron/src/main/lib/agent-plugins/surface-registry.test.ts
bun test apps/electron/src/renderer/components/plugins/PluginSurfaceHost.test.tsx
```

Expected: FAIL。

- [ ] **Step 3: 实现通用 Surface**

- main 注册 custom protocol 并仅服务不可变包内声明资源；
- renderer 用 sandboxed iframe 和 MessageChannel；
- Surface 只获得 `ready/invoke/on`；
- bridge 校验 token、surface、method、session/project、epoch 和只读状态；
- 未附着模块只能 read-only；
- 关闭 Surface 使 token/pending request 失效；
- `SidePanel` 在旧静态分支前增加动态插件 Surface 分发，旧五模块不变。

- [ ] **Step 4: GREEN**

Run:

```bash
bun test apps/electron/src/main/lib/agent-plugins/surface-registry.test.ts
bun test apps/electron/src/renderer/components/plugins/PluginSurfaceHost.test.tsx
bun run --filter @dutydeck/electron typecheck
```

Expected: token 撤销、只读、方法白名单和卸载清理通过。

### Task 7: Runtime fixture 与开发者闭环

**Files:**
- Create: `examples/plugins/runtime-fixture/plugin.json`
- Create: `examples/plugins/runtime-fixture/src/runtime.ts`
- Create: `examples/plugins/runtime-fixture/src/surfaces/workspace/index.html`
- Create: `examples/plugins/runtime-fixture/src/surfaces/workspace/main.ts`
- Create: `examples/plugins/runtime-fixture/src/surfaces/workspace/style.css`
- Create: `examples/plugins/runtime-fixture/tests/runtime-contract.test.ts`
- Create: `apps/electron/scripts/plugin-module-runtime-smoke.ts`
- Modify: `apps/electron/package.json`

- [ ] **Step 1: 写 fixture 测试**

```ts
test('Given fixture 插件 When 调用 echo Then 返回 v3 候选摘要', () => {
  const result = buildEchoResult({ message: 'hello' })
  expect(result).toEqual({
    pluginId: 'acme.runtime-fixture',
    message: 'hello',
    protocolVersion: 1,
  })
})
```

- [ ] **Step 2: RED**

Run:

```bash
bun test examples/plugins/runtime-fixture/tests
```

Expected: FAIL。

- [ ] **Step 3: 实现 fixture**

fixture 包含：

- 一个 `echo` 只读工具；
- 一个 `loadContext` Surface 方法；
- 一个懒启动服务；
- 只请求 `session.read`、`plugin.state.read/write`、`surface.emit`；
- 故意请求一次未授权 `http.request`，验证稳定拒绝。

增加 `plugin:module-runtime-smoke` 脚本，构建并打包 fixture，在隔离数据根中完成安装、激活、调用、Surface、停用和卸载。

- [ ] **Step 4: GREEN**

Run:

```bash
bun run --cwd apps/electron plugin:module-runtime-smoke
```

Expected: 真实 Electron 进程完成 fixture 全生命周期；不调用模型、网络或用户业务数据。

### Task 8: 全量验证与文档

**Files:**
- Modify: `docs/superpowers/plans/2026-10-23-plugin-module-runtime-capability.md`
- Modify: `MEMORY.md`

- [ ] **Step 1: 验证本计划覆盖**

检查设计中的 V3 manifest、runtime、broker、tools、Surface、snapshot、trust、error、performance、developer loop 均有对应实现或明确边界。

- [ ] **Step 2: 运行定向和全仓检查**

```bash
bun test packages/plugin-sdk/tests
bun test packages/plugin-kit/src
bun test apps/electron/src/main/lib/agent-plugins
bun test apps/electron/src/main/lib/agent-modules
bun test apps/electron/src/renderer/components/plugins
bun run typecheck
bun run electron:build
git diff --check
```

- [ ] **Step 3: 更新完成证据**

在计划和 MEMORY 中记录准确命令、通过数、构建范围、未验证供应商/真实用户数据边界和失败项。不得把 fixture 通过称为五个业务模块已迁移。

## 验收矩阵

| 场景 | 期望 |
| --- | --- |
| 未安装 V3 支持 | 旧客户端拒绝 V3，不部分加载 |
| V1/V2 content | 原安装、启用、提示和资源解析保持 |
| module 未激活 | runtime 不启动，无工具、无 Surface 写 bridge |
| module 已激活 | 工具进入下一轮，版本/hash/权限冻结 |
| 插件崩溃 | 当前 invocation 失败，其它插件不受影响 |
| 未授权能力 | provider 调用次数为 0 |
| Surface 旧 token | 项目/版本变化后拒绝 |
| 停用/卸载 | 新调用拒绝，旧调用到安全点，作品保留 |
| fixture 开发者流程 | 无需修改宿主业务即可构建、安装、运行和卸载 |
| 五模块迁移 | 本轮不执行；不能宣称已迁出 |
