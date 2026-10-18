# DutyDeck 去 Proma 品牌与兼容迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清理 DutyDeck 当前产品、包元数据和内部命名中的 Proma 品牌呈现，同时保留旧用户数据、升级路径、外部协议和上游归属信息，使 DutyDeck 成为独立维护的产品。

**Architecture:** 采用“新写入使用 DutyDeck、旧输入只读兼容”的迁移策略。用户可见界面、包描述、帮助链接和新代码使用 DutyDeck；`.proma` 数据根、旧 Safe Storage 名称、旧环境变量、旧 CLI、`proma_event`/`proma-file` 等已有协议值保留兼容，不改变存量 JSON/JSONL 字段和跨进程 wire value。每个阶段单独可测试、可回滚、可提交。

**Tech Stack:** Bun monorepo、TypeScript、Electron、React、Jotai、Vite、electron-builder、Bun test。

---

## 已确认基线与边界

- 当前正式仓库是 `https://github.com/taokoplay/DutyDeck.git`，`v0.20.0` 已公开发布。
- Electron 包名、appId、更新地址和发布来源已经是 DutyDeck；本计划不重复迁移这些已完成内容。
- 当前工作树有影像剪辑功能的未提交改动，包含 `apps/electron/src/main/lib/visual-production/*`、`apps/electron/src/renderer/components/visual-production/*`、`packages/shared/src/types/visual-editing*` 和 `MEMORY.md`。执行本计划时不得 reset、rebase、全量暂存或提交这些文件。
- 本计划只允许把计划文件本身作为本轮新增文件；执行阶段每次只按任务列出的路径暂存。

### Proma 兼容白名单

以下命中属于兼容、历史或外部协议，不能用全局替换删除：

| 类别 | 必须保留的值 | 原因 |
| --- | --- | --- |
| 旧数据根 | `~/.proma`、项目内 `.proma`、`.proma-location.json` | 旧用户数据、工作区和 locator 仍需读取；新写入走 `~/.DutyDeck` |
| 加密兼容 | `@proma/electron`、旧 Safe Storage 迁移标记 | 旧凭据需要解密后迁移到 `@dutydeck/electron` |
| 环境变量 | `PROMA_CONFIG_DIR`、`PROMA_DEV` 及 smoke 专用 `PROMA_*` | 旧脚本和用户启动方式不能突然失效 |
| CLI 过渡 | `proma` bin 名称 | 先打印弃用提示并继续工作，至少保留两个稳定版本 |
| 协议值 | `proma_event`、`proma-file://`、`proma-media://`、`proma_knowledge_*`、`proma-api-catalog`、`PROMA_SCHEDULED_RUN` | 会话 JSONL、LAN Bridge、Slack、Canvas 和导出文件中的持久化/跨进程标识不能改值 |
| 历史与归属 | `upstream=https://github.com/proma-ai/Proma.git`、README 上游致谢、AGPL 版权、历史 release notes | 法律归属和历史事实不能被品牌清理覆盖 |
| 测试夹具 | 只用于验证旧数据的 `.proma` 路径和 `proma-*` fixture | 测试必须继续证明旧数据可读 |
| 上游服务 | `proma.cool` provider 的旧配置 | 连接能力继续可用；仅移除产品内置 Proma 图标，回退到通用图标 |

命中以下位置才算本计划的非兼容残留：用户可见的产品名称、错误帮助链接、移动端文案、Proma Logo 下载功能、包描述、默认写入 key、未加兼容说明的新类型/变量名。

## 目标版本与发布顺序

> 执行时 `v0.20.1` 已作为 Safe Storage 修复版本公开发布，本计划的独立迁移版本顺延为 `v0.20.2`，避免复用已存在的标签。

1. `v0.20.2`：修复用户可见品牌残留、包描述、CLI 弃用提示、README 默认目录和资源打包；保留兼容值。
2. `v0.21.0`：完成内部 TypeScript 命名迁移和 localStorage 双读单写；新代码只引用 DutyDeck 名称，旧别名集中在兼容模块。
3. `v0.22.0` 之后：在至少两个稳定版本的弃用提示后，另行评估是否移除 `proma` CLI bin。移除前必须提供迁移说明和明确的失败提示；本计划不直接删除该别名。

## 任务 1：建立自动化残留检查和执行基线

**Files:**
- Create: `scripts/check-deproma-residue.ts`
- Create: `scripts/check-deproma-residue.test.ts`
- Modify: `package.json`

- [ ] **Step 1: 写失败测试，锁定用户可见残留规则**

在 `scripts/check-deproma-residue.test.ts` 中定义固定规则：以下文件必须不再出现对应残留：

```ts
const forbidden = [
  ['apps/electron/src/main/menu.ts', 'https://github.com/yourusername/proma'],
  ['apps/mobile/index.html', '<title>Proma</title>'],
  ['apps/mobile/src/components/layout/AuthPage.tsx', 'Proma 手机端'],
  ['apps/mobile/src/components/layout/AuthPage.tsx', '连接到桌面 Proma'],
  ['packages/core/package.json', 'proma core'],
  ['packages/session-core/package.json', 'Proma agent sessions'],
  ['apps/mobile/package.json', 'Proma mobile'],
  ['apps/electron/electron-builder.yml', 'resources/proma-logos'],
] as const
```

测试同时断言兼容值仍存在：`apps/cli/package.json` 保留 `proma` bin、`apps/cli/src/paths.ts` 保留 `PROMA_CONFIG_DIR` 回退、`packages/shared/src/types/agent.ts` 保留 `proma_event` wire value。

- [ ] **Step 2: 运行测试确认基线失败**

运行：

```bash
bun test scripts/check-deproma-residue.test.ts
```

预期：失败并列出帮助菜单、移动端、包描述或 builder 仍存在的命中。

- [ ] **Step 3: 实现检查器和白名单匹配**

在 `scripts/check-deproma-residue.ts` 中使用 `Bun.file(...).text()` 读取仓库文件，只报告 forbidden 列表和不在兼容白名单中的 `Proma`/`proma` 命中。检查器输出文件路径、行号、命中片段和建议动作；不要扫描 `node_modules`、`dist`、`.git`、历史 release notes 和测试 fixture 目录。

在根 `package.json` 增加：

```json
"check:deproma": "bun scripts/check-deproma-residue.ts"
```

- [ ] **Step 4: 运行检查器确认仍能指出当前残留**

运行：

```bash
bun run check:deproma
```

预期：命令以非零状态列出当前残留；在后续任务完成后再要求零非白名单命中。

- [ ] **Step 5: 提交独立基线**

```bash
git add package.json scripts/check-deproma-residue.ts scripts/check-deproma-residue.test.ts
git commit -m "chore: 增加去 Proma 残留检查"
```

## 任务 2：清理用户可见品牌和错误链接

**Files:**
- Modify: `apps/electron/src/main/menu.ts:149`
- Modify: `apps/mobile/index.html:11`
- Modify: `apps/mobile/src/components/layout/AuthPage.tsx:44,47-48,67,112,121`
- Modify: `apps/mobile/src/atoms/index.ts`
- Modify: `apps/mobile/src/App.tsx`
- Modify: `apps/mobile/src/lib/device-credentials.ts`
- Modify: `apps/mobile/src/utils/storage.ts`
- Create: `apps/mobile/src/utils/storage.test.ts`
- Modify: `apps/mobile/src/index.test.ts`

- [ ] **Step 1: 先为移动端旧 key 迁移写测试**

在 `apps/mobile/src/utils/storage.test.ts` 覆盖三个场景：

```ts
test('新 key 存在时优先读取新 key', () => {
  const storage = fakeStorage({ dutydeck_mobile_host: 'new-host', proma_mobile_host: 'old-host' })
  expect(readStorageWithLegacy(storage, 'dutydeck_mobile_host', 'proma_mobile_host', '')).toBe('new-host')
})

test('只有旧 key 时读取旧值并写入新 key', () => {
  const storage = fakeStorage({ proma_mobile_host: 'old-host' })
  expect(readStorageWithLegacy(storage, 'dutydeck_mobile_host', 'proma_mobile_host', '')).toBe('old-host')
  expect(storage.getItem('dutydeck_mobile_host')).toBe('old-host')
})

test('新写入只写 DutyDeck key，不删除旧 key', () => {
  const storage = fakeStorage({ proma_mobile_token: 'old-token' })
  writeStorage(storage, 'dutydeck_mobile_token', 'new-token')
  expect(storage.getItem('proma_mobile_token')).toBe('old-token')
  expect(storage.getItem('dutydeck_mobile_token')).toBe('new-token')
})
```

实现 `readStorageWithLegacy`、`writeStorage` 和 `removeStorage` 的兼容参数，所有新增方法写中文注释说明用途、入参和返回值。

- [ ] **Step 2: 运行移动端迁移测试确认失败**

```bash
bun test apps/mobile/src/utils/storage.test.ts
```

预期：因新 helper 尚不存在而失败。

- [ ] **Step 3: 切换移动端新写入并保留旧读取**

将移动端 key 前缀从 `proma_mobile_` 改为 `dutydeck_mobile_`，覆盖 token、host、port、active conversation、view、workspace、device id、device credential。读取顺序固定为新 key → 旧 key；读到旧值时立即复制到新 key，旧 key 保留。`AuthPage.tsx` 的设备名改为 `DutyDeck 手机端`，标题、按钮 aria-label、PIN 说明改为 DutyDeck；`index.html` 标题改为 `DutyDeck`。

所有 `App.tsx`、`atoms/index.ts`、`device-credentials.ts`、`ws-client.ts` 的直接 `localStorage` 访问改为 helper，确保退出登录只清理新旧 token/credential，不清理 host 和设备 ID。

- [ ] **Step 4: 修复帮助菜单 URL**

将 `apps/electron/src/main/menu.ts` 的占位地址替换为：

```ts
await shell.openExternal('https://github.com/taokoplay/DutyDeck')
```

- [ ] **Step 5: 运行移动端和菜单相关测试**

```bash
bun test apps/mobile/src/utils/storage.test.ts apps/mobile/src/index.test.ts
bun run --filter @dutydeck/mobile typecheck
bun run --filter @dutydeck/mobile build
```

预期：旧 localStorage 数据可恢复，新安装显示 DutyDeck，移动端构建通过。

- [ ] **Step 6: 提交用户可见品牌修复**

```bash
git add apps/electron/src/main/menu.ts apps/mobile/index.html apps/mobile/src/components/layout/AuthPage.tsx apps/mobile/src/atoms/index.ts apps/mobile/src/App.tsx apps/mobile/src/lib/device-credentials.ts apps/mobile/src/utils/storage.ts apps/mobile/src/utils/storage.test.ts apps/mobile/src/index.test.ts
git commit -m "feat: 清理桌面与移动端 Proma 品牌残留"
```

## 任务 3：移除 Proma Logo 功能和内置图标呈现

**Files:**
- Delete: `apps/electron/src/renderer/components/settings/PromaLogoSettings.tsx`
- Modify: `apps/electron/src/renderer/components/settings/BotHubSettings.tsx`
- Modify: `apps/electron/src/renderer/components/settings/AppearanceSettings.tsx`
- Modify: `apps/electron/src/renderer/components/settings/SettingsPanel.tsx`
- Modify: `apps/electron/src/main/ipc.ts:2229`
- Modify: `apps/electron/src/main/lib/settings-service.ts`
- Modify: `apps/electron/electron-builder.yml:106-108`
- Modify: `apps/electron/src/renderer/lib/model-logo.ts`
- Modify: `apps/electron/src/renderer/normal-renderer-main.tsx`
- Create: `apps/electron/src/main/lib/app-icon-path.test.ts`
- Delete: `apps/electron/src/renderer/assets/bots/proma-logos/*`
- Delete: `apps/electron/resources/proma-logos/*`
- Modify: `apps/electron/scripts/media-image-picker-smoke-renderer.tsx`
- Modify: `apps/electron/scripts/media-workbench-layout-smoke-renderer.tsx`
- Modify: `apps/electron/scripts/canvas-media-organization-smoke-renderer.tsx`
- Modify: affected renderer tests that mock `PromaLogo`

- [ ] **Step 1: 锁定删除功能后的设置入口行为**

新增或调整设置组件测试，断言 Settings 面板不再出现“Proma Logo/Proma 品牌 Logo”入口；Bot Hub 和外观设置仍能打开、保存机器人头像和主题。已有用户自定义头像路径不删除、不改写，只移除内置素材下载入口。

- [ ] **Step 2: 运行相关测试确认当前实现仍失败**

```bash
bun test apps/electron/src/renderer/components/settings apps/electron/src/renderer/lib/model-logo.ts
```

预期：新断言因旧入口和旧资源仍存在而失败。

- [ ] **Step 3: 删除 Proma Logo 设置入口和资源 IPC**

从 `BotHubSettings.tsx`、`AppearanceSettings.tsx`、`SettingsPanel.tsx` 移除 `PromaLogoSettings` 导入、品牌素材路由和下载按钮；从 `ipc.ts` 删除只服务于下载 `proma-logos` 的资源 IPC handler。`resolveAppIconPath` 不再按旧变体拼接路径，未知或旧变体统一回退到 `resources/icon.png`；从 `electron-builder.yml` 删除 `proma-logos` 的资源复制条目。

删除两组只用于品牌选择器和 smoke fixture 的 Proma 资源。已有设置中的 `appIconVariant` 不能直接删除：启动读取时将任意旧变体归一为 `default` 并通过 `settings-service.ts` 原子写回；因此升级后使用 DutyDeck 默认图标，旧设置不会让应用启动失败。更新三个 smoke fixture 使用 `apps/electron/src/renderer/assets/brand/dutydeck-icon.png`，避免测试重新引入 Proma 资源。

- [ ] **Step 4: 替换模型默认图标行为**

`AppearanceSettings.tsx` 删除旧的多色 Proma 图标变体，只保留 `default` DutyDeck 图标；读取旧 `appIconVariant` 时显示 `default`。`apps/electron/src/renderer/lib/model-logo.ts` 删除 `PromaLogo` 导出和 `proma.cool` URL 映射，`getChannelLogo` 对该 URL 回退 `DefaultLogo`。`normal-renderer-main.tsx` 使用已有 `DefaultLogo` 或 `dutydeck-icon.png`，测试 mock 同步删除 `PromaLogo` 字段。这样旧的 `proma.cool` 渠道仍可请求，只改变图标，不改变 provider、URL 或凭据。

新增 `app-icon-path.test.ts`，断言 `default`、空值和任意旧变体都解析到 DutyDeck 默认图标，防止未来重新打包 Proma 资源。

- [ ] **Step 5: 运行 renderer、IPC 和打包验证**

```bash
bun test apps/electron/src/renderer/components/settings apps/electron/src/renderer/lib apps/electron/src/main/lib/app-icon-path.test.ts apps/electron/src/main/lib
bun run typecheck
bun run electron:build
```

预期：设置入口、旧 provider fallback、旧图标偏好归一化、smoke fixture 和 Electron 构建均通过；构建产物中不再出现 `proma-logos` 目录，包体积因移除重复 Logo 资源下降。

- [ ] **Step 6: 提交资源清理**

```bash
git add -u apps/electron/src/renderer/components/settings apps/electron/src/main/ipc.ts apps/electron/electron-builder.yml apps/electron/src/renderer/lib/model-logo.ts apps/electron/src/renderer/normal-renderer-main.tsx apps/electron/scripts
git add apps/electron/src/renderer/assets/brand/dutydeck-icon.png
git commit -m "feat: 移除 Proma Logo 资源并统一 DutyDeck 图标"
```

不要使用 `git add -A`，以免把影像剪辑未提交文件带入提交。

## 任务 4：统一包元数据和 CLI 过渡命令

**Files:**
- Modify: `apps/cli/package.json`
- Create: `apps/cli/src/legacy-proma.ts`
- Modify: `apps/cli/src/paths.ts`
- Create: `apps/cli/src/legacy-proma.test.ts`
- Modify: `packages/core/package.json`
- Modify: `packages/session-core/package.json`
- Modify: `apps/mobile/package.json`
- Modify: `packages/capability-runner/src/spec.ts`
- Modify: `packages/capability-runner/src/parse.test.ts`
- Modify: `packages/session-core/src/group.ts`

- [ ] **Step 1: 为 CLI 弃用别名写测试**

把警告逻辑抽为 `apps/cli/src/legacy-proma.ts` 可测试的 `printLegacyCliWarning(write)`，测试断言一次调用输出以下中文警告并继续导入主入口：

```text
proma 命令已弃用，请改用 dutydeck；当前版本仍兼容旧命令。
```

测试还断言 `apps/cli/package.json` 同时保留 `dutydeck` 和 `proma` 两个 bin。

- [ ] **Step 2: 实现过渡入口和包描述更新**

将 `proma` bin 指向 `./src/legacy-proma.ts`，`dutydeck` 继续指向 `./src/index.ts`。包装入口只输出一次警告，然后执行同一 `index.ts`，不复制 CLI 业务逻辑。更新 core、session-core、mobile 的 description，删除“proma core”“Proma agent sessions”“Proma mobile”等产品描述。

- [ ] **Step 3: 为持久化 marker 和 capability kind 建立 DutyDeck 代码名**

在 `packages/session-core/src/group.ts` 使用 `DUTYDECK_SCHEDULED_RUN_MARKER` 作为代码名，但值固定为 `<!--PROMA_SCHEDULED_RUN-->`；在 capability runner 中使用 `DUTYDECK_CAPABILITY_PACKAGE_KIND` 作为代码名，但值固定为 `proma-ai-capability-package`。旧导出保留为 `@deprecated` 别名，解析器继续只接受原 wire value。

- [ ] **Step 4: 运行 CLI、session 和 capability 测试**

```bash
bun test apps/cli/src/legacy-proma.test.ts apps/cli/src/paths.test.ts packages/session-core/src packages/capability-runner/src
bun run --filter @dutydeck/cli typecheck
bun run --filter @dutydeck/cli build
```

预期：`dutydeck` 和 `proma` 都能执行同一查询路径，旧配置根回退继续通过，旧 marker/kind 的解析结果不变。

- [ ] **Step 5: 提交 CLI 和包元数据变更**

```bash
git add apps/cli/package.json apps/cli/src/legacy-proma.ts apps/cli/src/legacy-proma.test.ts apps/cli/src/paths.ts packages/core/package.json packages/session-core/package.json packages/session-core/src/group.ts apps/mobile/package.json packages/capability-runner/src/spec.ts packages/capability-runner/src/parse.test.ts
git commit -m "chore: 统一 DutyDeck 包元数据并保留 CLI 兼容别名"
```

## 任务 5：迁移 renderer localStorage 和 TypeScript 内部命名

**Files:**
- Create: `apps/electron/src/renderer/lib/legacy-storage.ts`
- Modify: `apps/electron/src/renderer/index.html`
- Modify: `apps/electron/src/renderer/atoms/theme.ts`
- Modify: `apps/electron/src/renderer/atoms/chat-atoms.ts`
- Modify: `apps/electron/src/renderer/atoms/agent-atoms.ts`
- Modify: `apps/electron/src/renderer/atoms/preview-atoms.ts`
- Modify: `apps/electron/src/renderer/atoms/server-ops-atoms.ts`
- Modify: `apps/electron/src/renderer/atoms/sidebar-atoms.ts`
- Modify: `apps/electron/src/renderer/atoms/system-prompt-atoms.ts`
- Modify: `apps/electron/src/renderer/atoms/tab-atoms.ts`
- Modify: `apps/electron/src/renderer/atoms/app-mode.ts`
- Modify: `apps/electron/src/renderer/components/quick-task/QuickTaskApp.tsx`
- Modify: `apps/electron/src/renderer/components/diff/WorkspaceAddTabMenuApp.tsx`
- Modify: `packages/shared/src/types/agent.ts`
- Create: `packages/shared/src/types/agent-compat.test.ts`
- Modify: `apps/electron/src/renderer/components/agent/PermissionModeSelector.tsx`
- Modify: `apps/electron/src/renderer/atoms/agent-atoms.ts`

- [ ] **Step 1: 列出并锁定全部现有 renderer key**

迁移范围固定为当前代码中以下 key：

```text
proma-app-mode
proma-selected-model
proma-context-length
proma-thinking-enabled
proma-thinking-level
proma-preview-code-wrap
proma-preview-split-ratio
proma-server-ops-selected-connection-id
proma-server-ops-selected-project-id
proma-left-sidebar-width
proma-workspace-list-height
proma-selected-system-prompt-id
proma-sidebar-collapsed
proma-theme-mode
proma-theme-style
proma-agent-sidepanel-open-by-session
proma-agent-workspace-layout-by-session
proma-agent-file-source-filter-map
proma-agent-session-component-tabs
proma-agent-canvas-workspace-by-session
proma-agent-workspace-split-ratio-by-session
proma-find-highlight-style
proma-input
proma-performance-debug
```

`proma_event`、CSS class、DOM data attribute 和协议 URL 不属于 localStorage key，继续按兼容白名单处理。

- [ ] **Step 2: 写双读单写 helper 测试**

在 `legacy-storage.ts` 提供：

```ts
export function readStorageValue<T>(storage: Storage, key: string, legacyKey: string, parse: (raw: string) => T | null): T | null
export function writeStorageValue(storage: Storage, key: string, value: string): void
```

`readStorageValue` 先读 `key`，没有时读 `legacyKey` 并复制到 `key`；解析失败返回 `null`，不覆盖新值。`writeStorageValue` 只写新 key。为新旧 key、坏 JSON、`Storage` 抛异常各写一个测试。

- [ ] **Step 3: 迁移所有新写入 key**

将所有持久化 key 改为 `dutydeck-*` 或 `dutydeck_*`，保持原 key 的值格式、Jotai atom 默认值和作用域不变。`index.html` 的首屏主题脚本也必须先读 `dutydeck-theme-*`，没有时回读 `proma-theme-*` 并立即复制。不能在迁移时清除旧 key，避免旧版本回退时丢状态。

- [ ] **Step 4: 将共享类型的代码名切换为 DutyDeck**

在 `packages/shared/src/types/agent.ts` 先定义 canonical 名称：

```ts
export const DUTYDECK_PERMISSION_MODES = ['bypassPermissions', 'plan'] as const
export type DutyDeckPermissionMode = typeof DUTYDECK_PERMISSION_MODES[number]
export const DUTYDECK_DEFAULT_PERMISSION_MODE: DutyDeckPermissionMode = 'bypassPermissions'
```

把 `PromaPermissionModeConfig`、`PromaEvent` 等仅限 TypeScript 内部的引用迁移到 DutyDeck 名称；在同一文件底部保留带 `@deprecated` 的旧类型、常量和函数别名，别名指向新实现。`permission_mode_changed` 的对象值、`proma_event` 的 union discriminator 和会话 JSON 字段保持原样。

同步修改 `PermissionModeSelector.tsx`、`agent-atoms.ts` 及共享类型测试，让新业务代码只导入 DutyDeck 名称。

- [ ] **Step 5: 运行迁移和类型兼容测试**

```bash
bun test packages/shared/src/types/agent-compat.test.ts apps/electron/src/renderer/atoms apps/electron/src/renderer/lib
bun run typecheck
```

预期：新 key 写入、旧 key 回读、坏值回退、旧类型别名和 `proma_event` wire value 全部通过。

- [ ] **Step 6: 提交存储与内部命名迁移**

```bash
git add apps/electron/src/renderer/index.html apps/electron/src/renderer/lib/legacy-storage.ts apps/electron/src/renderer/atoms apps/electron/src/renderer/components/quick-task/QuickTaskApp.tsx apps/electron/src/renderer/components/diff/WorkspaceAddTabMenuApp.tsx apps/electron/src/renderer/components/agent/PermissionModeSelector.tsx packages/shared/src/types/agent.ts packages/shared/src/types/agent-compat.test.ts
git commit -m "refactor: 统一 DutyDeck 本地存储与内部类型命名"
```

## 任务 6：校正数据目录、文档和用户迁移说明

**Files:**
- Modify: `README.md:33,92`
- Modify: `README.en.md:33,92`
- Create: `docs/migrations/2026-10-dutydeck-from-proma.md`
- Modify: `apps/electron/src/main/lib/config-paths.test.ts`
- Modify: `apps/cli/src/paths.test.ts`
- Modify: `apps/electron/src/main/lib/app-identity.test.ts`
- Modify: `apps/electron/src/main/lib/safe-storage-migration.test.ts`
- Modify: `apps/electron/package.json`
- Modify: `release-notes/` only for the new version entry

- [ ] **Step 1: 为数据根和 Safe Storage 迁移补边界测试**

用临时 `HOME` 覆盖以下场景：默认新根为 `~/.DutyDeck`；只有 `~/.proma` 时只读发现并生成迁移提示；locator 指向旧根时继续可读；新根存在时不覆盖；Safe Storage 旧服务名解密成功后写入新服务名；密钥库不可用时不删除旧值并允许下次重试。

- [ ] **Step 2: 更新 README 的默认路径和迁移入口**

将“默认数据目录”改为 `~/.DutyDeck`，明确写出：升级用户的 `~/.proma` 会被检测并进入迁移流程，迁移前不删除；项目内 `.proma` 继续读取；`proma` CLI、环境变量和协议值属于兼容层。保留 AGPL、上游 Proma 归属、历史教程和历史截图链接，避免把法律归属误写成 DutyDeck 自有代码。

- [ ] **Step 3: 写独立迁移说明**

在 `docs/migrations/2026-10-dutydeck-from-proma.md` 写清楚用户可执行步骤：备份 `~/.proma`，启动 DutyDeck，确认迁移提示中的源/目标路径，完成后检查会话、渠道和 Skills；失败时保留旧根并收集日志编号。文档不能记录密钥值，只能写凭据位置和验证方法。

- [ ] **Step 4: 更新版本说明**

将 `apps/electron/package.json` 版本从 `0.20.0` 更新为 `0.20.1`，并在新的 release note 中列出：帮助链接、移动端品牌、Proma Logo 功能移除、CLI 弃用提示、localStorage 双读单写、旧数据/Safe Storage 兼容和已知保留的协议标识。标签必须等于 `apps/electron/package.json.version`。

- [ ] **Step 5: 运行文档和迁移验证**

```bash
bun test apps/electron/src/main/lib/config-paths.test.ts apps/cli/src/paths.test.ts apps/electron/src/main/lib/app-identity.test.ts apps/electron/src/main/lib/safe-storage-migration.test.ts
bun run check:deproma
```

预期：README 只在归属/历史/兼容说明中命中 Proma；检查器对当前产品文件返回零非白名单命中。

- [ ] **Step 6: 提交文档和迁移合同**

```bash
git add README.md README.en.md docs/migrations/2026-10-dutydeck-from-proma.md release-notes apps/electron/src/main/lib/config-paths.test.ts apps/cli/src/paths.test.ts apps/electron/src/main/lib/app-identity.test.ts
git commit -m "docs: 补充 DutyDeck 数据迁移与独立版本说明"
```

## 任务 7：完整验证、开发版重启和发布

**Files:**
- Modify: only files required by failed tests; do not touch visual-production files unless a test failure proves a direct dependency.
- Create: `/private/tmp/dutydeck-deproma-verification.json` as local verification output, never commit it.

- [ ] **Step 1: 运行定向测试**

```bash
bun test scripts/check-deproma-residue.test.ts apps/mobile/src/utils/storage.test.ts apps/mobile/src/index.test.ts apps/cli/src/legacy-proma.test.ts apps/cli/src/paths.test.ts packages/session-core/src packages/capability-runner/src packages/shared/src/types/agent-compat.test.ts
```

预期：兼容读取、用户可见字符串、CLI 弃用和 wire value 测试全部通过。

- [ ] **Step 2: 运行全仓质量检查**

```bash
bun run typecheck
bun test
bun run electron:build
bun run --filter @dutydeck/cli build
bun run --filter @dutydeck/mobile build
```

预期：无类型错误、全仓测试通过、Electron/CLI/mobile 构建成功。若已有影像剪辑测试失败，只记录失败文件和原因，不修改其并行改动。

- [ ] **Step 3: 做真实用户路径 smoke**

使用临时数据根启动 Electron，验证：帮助菜单打开 `taokoplay/DutyDeck`；设置中没有 Proma Logo；移动端标题和 PIN 提示为 DutyDeck；旧 `.proma` 数据、旧 localStorage、旧 Safe Storage 凭据仍能读取；`proma` CLI 只显示一次弃用提示；`dutydeck` CLI 无弃用提示。

停止旧开发进程后重新执行 `bun run dev`，确认 Vite `http://127.0.0.1:5174/` 返回 200，并从新主进程日志确认加载的是最新 `@dutydeck/electron` 和 DutyDeck Release 地址。

- [ ] **Step 4: 进行残留审计和产物检查**

```bash
bun run check:deproma
rg -n -i --glob '!node_modules' --glob '!dist' 'proma|PROMA' apps packages scripts README.md README.en.md
```

每条命中必须归入兼容白名单、法律归属、历史资料、测试 fixture 或外部协议；发现用户可见的新命中时回到对应任务修复。检查 Electron 构建输出，确认不存在 `proma-logos` 资源，且 `dutydeck-logos`、`resources/bin/dutydeck` 正常存在。

- [ ] **Step 5: 生成发布前证据**

将 `git diff --check`、`git status --short`、版本号、当前 commit、构建产物清单、测试结果和残留审计结果写入 `/private/tmp/dutydeck-deproma-verification.json`。确认 `git status` 中只有本计划允许的提交后遗留文件和用户原有影像剪辑改动。

- [ ] **Step 6: 发布独立迁移版本**

仅在所有前置命令通过后执行：

```bash
git tag v0.20.1
git push origin main --tags
```

随后检查 GitHub Release、更新 YAML 的版本/引用/大小/SHA-512、macOS/Windows/Linux 资产和自动更新源均指向 `taokoplay/DutyDeck`。发布后不删除 `~/.proma`，观察一轮旧数据启动、CLI 兼容和自动更新。

## 风险、用户影响和性能评估

| 改动 | 关联业务影响 | 用户影响 | 性能/资源影响 | 缓解方式 |
| --- | --- | --- | --- | --- |
| 帮助菜单、移动端文案 | Electron menu、LAN Bridge mobile UI | 入口和品牌统一为 DutyDeck | 无可测运行时开销 | 保留 LAN Bridge 协议和认证字段 |
| 删除 Proma Logo 功能 | Settings、Bot Hub、builder 资源、smoke fixture | 不能再下载上游 Proma Logo；用户已有自定义头像不受影响 | 删除图片资源，安装包更小、启动解压更快 | 先做设置入口回归和构建产物检查 |
| CLI 过渡别名 | CLI bin、Electron 内置 legacy binary | 旧命令继续可用但会看到一次弃用提示 | 每次旧命令多一次 stderr 写入，忽略不计 | 至少保留两个稳定版本再评估删除 |
| localStorage 双读单写 | Renderer atoms、首屏主题脚本、移动端状态 | 旧设置自动保留，新版本写入 DutyDeck key | 首次命中旧 key 时增加一次内存读和一次同步写，启动级别开销可忽略 | 新 key 优先、旧 key 不删除、坏值安全回退 |
| TypeScript 内部命名 | shared types、agent UI、测试 | 用户无直接变化 | 仅编译期别名，无运行时成本 | wire value、JSON 字段和协议 discriminator 不变 |
| 数据/Safe Storage 兼容 | locator、启动迁移、凭据服务名 | 旧会话、渠道、Skills 和凭据继续可用 | 启动时只扫描必要 JSON，迁移完成后由标记短路 | 迁移失败保留旧根并下次重试 |
| README/release note | 用户安装、升级和排错 | 默认路径和迁移步骤更清楚 | 无运行时影响 | 保留上游归属和历史事实 |

## 完成判定

- 用户可见产品界面、帮助链接、移动端和包描述不再把 DutyDeck 叫作 Proma。
- Proma Logo 入口和打包资源已移除，旧 provider 仍可连接并回退到通用图标。
- `proma` 旧 CLI、旧数据根、旧 Safe Storage、旧环境变量、旧 localStorage、旧协议值均有测试覆盖并保持可读。
- `bun run check:deproma` 只允许白名单命中；`bun run typecheck`、`bun test`、Electron/CLI/mobile 构建和真实 smoke 全部通过。
- 发布标签严格等于版本号，发布资产和自动更新源全部来自 `taokoplay/DutyDeck`。
- 每个提交只包含对应任务列出的文件，不包含影像剪辑并行改动。
