# DutyDeck 插件生态协作与分阶段实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 由 DutyDeck 提供统一插件规范和脚手架，作者在其中开发可执行业务模块、Agent 工具、右侧 Surface、受控服务、状态和提示，产出可通过本地文件、设置市场及团队私有源安装的独立插件包；项目/工作区已有 Skills 继续由现有 Skill 系统管理，插件只声明稳定引用。

**Architecture:** 保留 Pi 与现有专业模块消息门禁；以统一清单和标准脚手架连接不可变模块 runtime 包、Skill 引用、事务化管理与 Host SDK。先完成受信 runtime、工具和 Surface 的宿主闭环，再迁出交互设计业务；市场与私有源复用同一安装器。

**Tech Stack:** Bun、TypeScript、Electron、React、Jotai、现有 Radix/shadcn、JSON/JSONL 与 safe-file。不新增数据库；现有 ZIP/签名实现须按安全与打包需求验证，新增运行依赖需单独说明。

---

状态：2026-10-19 协作规划草案，所有实现任务均未开始。配套产品/数据合同见 `../specs/2026-10-19-plugin-ecosystem-design.md`。本文件定义交付责任、接口、文件边界和验收；它不是已执行结果，也不承诺具体开发工期。每个工作包由其负责人在冻结合同上拆成可逐项执行的实现步骤后开发，不能把合同未定部分交给不同模块各自猜测。

首版执行入口为 [插件模块首版规划](2026-10-19-plugin-module-v1-plan.md)：W1–W6 的统一规范、模块 runtime 脚手架、Skill 引用及外部作者发行验收先闭环；W6H、W7 的完整业务 runtime 和其它模块迁出随后进行。设计约束只是按需携带的包内资源，不另立安装类型；首版开放不依赖后面的业务迁出完成。

## 1. 范围与优先级

优先完成共用底座：统一开发规范与脚手架、身份、资源、启用/选择区分、真实包、安装事务、数据所有权、权限与恢复快照。首版同时交付设置市场、私有源、公开作者工具和内置资源兼容。完整交互设计 runtime 试点及其它业务模块迁出属于后续阶段。

本轮不做支付、评分、排行榜、市场账号平台、任意原生插件和所有模块同时重写。私有源先用带认证的标准索引，不建设另一套 SaaS。

现有相关事实不得丢失：浏览器/终端自动；专业模块按消息选中；项目/工作区 Skills 不复制进插件；共享媒体不隐式激活画布；用户作品/凭据不随卸载误删；开发版与安装版共享业务根。

## 2. 并行开发职责与依赖

| 工作线 | 独占职责 | 主要输出 | 前置 |
| --- | --- | --- | --- |
| A：合同/SDK 与集成负责人 | shared 合同、Host API、IPC 签名、版本策略、集成合并 | Schema、冻结 fixtures、SDK、公共错误码 | 无 |
| B：包与生命周期 | 解包校验、信任、版本 store、事务、租约、升级/卸载 | 可复用安装器与故障测试 | A 的包/状态合同 |
| C：Skill 引用与模块资源 | 引用 resolver、提示规范与编译、工具/Surface 快照 | Skill 解析闭环与业务示例 | A 的模块合同 |
| D：设置与分发 | 设置插件中心、市场源客户端、私有源认证体验 | 统一管理 UI 与市场 | A 的 IPC DTO；B 的操作结果 |
| E：业务试点 | 交互设计工具、服务、UI、数据适配迁出 | 独立官方业务插件 | A 的 SDK；B/C 基础闭环 |
| 独立验收 | 契约测试、故障注入、跨实例、真实 Electron smoke | 阶段验收证据与阻断清单 | 各线交付，不代替作者自测 |

A 拥有 `packages/shared` 公共导出、IPC 常量、主 `ipc.ts`、preload、`agent-orchestrator.ts` 和 Agent service 接线；其它线提供适配接口及测试，由 A 串行集成，不同时重写这些文件。组件、服务和插件各有自己的目录。公共文件冲突由集成负责人处理，不回退他人改动。

依赖顺序：W0 → W1；W2/W3 在 W1 fixtures 冻结后并行，W4 可先写 gate 测试但真实租约集成依赖 W2/W3；W5 可先用 W1 fixture 做 UI，完整管理依赖 W2/W3/W4；W6 在 W2 完成后接市场。W3 同时兼容内置模块资源；W1–W6 集成后立即完成外部作者使用同一脚手架的验收与分发。后续 W6H 实现实际 Host，W7 runtime 迁出等 W6H 与 W5 验收，W8 推广到其它业务模块。CI 和证据收集贯穿每个工作包。

## 3. W0：冻结产品语义与验收基线

**责任：** A 与各线负责人。**产出：** 本规范确认版、当前基线与测试样本；不移动业务代码。

**文件：** 本规范/计划；现有 `docs/superpowers/plans/2026-10-18-agent-module-pluginization.md` 仅加指向新规范的变更说明，保留历史验收记录。

- [ ] 将用户确认的“双分发：独立包 + 私有源”和消息显式选择列为约束。
- [ ] 确认单一标准脚手架和包协议，`content` 仅作兼容、`module-runtime`/`trusted-runtime` 作为目标执行能力；固定 `.ddplugin` 推荐格式、设置一级插件页及安装后不自动选中。
- [ ] 采集当前模块/队列/恢复/Skills/交互设计定向测试、类型检查、真实 Electron smoke 基线；记录失败，不推断所有失败无关。
- [ ] 固定测试数据：两个同名模块、同版本不同包、引用同一项目 Skill 的插件、Skill 引用缺失/版本冲突、含可选设计约束的插件、不含设计资源的插件、缺依赖包、旧 V1 清单、含可恢复运行的项目副本。
- [ ] 建立阶段验收记录，结论区分内容插件、可信业务插件和任意第三方代码能力。

**交付门槛：** 每一项用户要求都有对应工作包与验收编号；产品歧义在公共合同中一次解决。

## 4. W1：身份、Schema、资源模型与开发者入口

**责任：** A；C 提供资源字段审查。

**新增文件：**

- `packages/plugin-sdk/src/{contracts,validation,index}.ts`、`package.json`、`tsconfig.json`：纯公开协议与校验唯一来源，不能依赖 Electron、未发布 shared 或宿主源码。
- `packages/plugin-sdk/schemas/plugin-package.v2.schema.json`、`design-style.v1.schema.json`：统一包合同与可选设计资源合同，后者不定义新的安装类型。
- `packages/plugin-sdk/src/validation.test.ts`；`packages/shared/src/types/plugin-package.test.ts`、`plugin-resources.test.ts`：分别测试权威校验和宿主适配。
- `packages/shared/src/types/plugin-package.ts`、`plugin-resources.ts`：兼容重导出/宿主投影；`plugin-management.ts`、`plugin-source.ts`：宿主管理及来源 DTO，不复制包解析器。
- `packages/plugin-kit/templates/standard/` 与 CLI：唯一标准脚手架，包含规范说明、模块资源和契约测试，不能依赖 monorepo 环境。
- `examples/plugins/design-kit/`：由公开 CLI 模板生成的规范第 6 节验收示例；权威模板只维护在 plugin-kit，生成对照测试防止示例漂移。

**修改文件：** `packages/shared/src/types/agent-plugin.ts`、`agent-modules.ts`、`agent.ts`、`packages/shared/src/index.ts`；只增加 V2 适配，不删除 V1 读取路径。

- [ ] 以统一 manifest 生成基础模块、含可选资源、不含设计资源等有效 fixture，加入无发布者、重复 ID、跨包私有引用、非法路径、未来必需能力、缺资源、错误归属和所属模块禁用等样本。
- [ ] 固定脚手架的目录、提示章节与变量合同、UI 约定、开发命令和版本记录；可选资源按业务需要生成，升级说明不覆盖作者业务文件。
- [ ] 编写并先运行失败测试；锁定显示名与模块身份分离、业务 Skill 引用只绑定一个所属模块、共享被动知识单独分类、`builtin.*` 保留、Skill hash 不由插件 manifest 自证。
- [ ] 实现单一解析/校验事实源，JSON Schema 与运行时解析由同一合同产生并用 fixture 对照，避免两套校验漂移。
- [ ] SDK/CLI 分别生成无 workspace 依赖的发行物，内容作者验收提前到 W1–W6 完成后；仓库 scripts 仅为公开 CLI 转发。
- [ ] 定义安装预览/确认、停用策略、目录快照、错误码、源查询 DTO；所有 mutation 包含请求身份与 expectedRevision，预览 token 绑定完整计划。
- [ ] 定义 settingsSchema 的字段、校验、生效时机和 credentialRef；运行快照保留普通配置 revision，凭据只由宿主受控解析。
- [ ] 发布支持矩阵：当前支持的 module-runtime 能力、trusted-runtime 的受信限制、Skill 引用作用域、V1 兼容范围；模板引用稳定 API 版本。
- [ ] 冻结 fixtures 后允许 B/C/D 并行，接口变更须附迁移与兼容测试。

**命令与期望：**

```bash
bun test packages/plugin-sdk/src/validation.test.ts packages/shared/src/types/plugin-package.test.ts packages/shared/src/types/plugin-resources.test.ts
bun run typecheck
```

新增测试实现前应因缺少合同实现失败，实现后全部通过。核心 BDD：Given 相同中文名、不同完整资源 ID，When 同时注册，Then 两项可定位且短名歧义报错；Given 未受信第三方使用 builtin ID，Then 在注册前拒绝。

## 5. W2：包工具链、验证与安装事务

**责任：** B。A 集成公共 IPC。

**新增文件：**

- `apps/electron/src/main/lib/agent-plugins/package-reader.ts`、`package-integrity.ts`、`publisher-trust.ts`：受限解包、摘要与签名身份。
- `agent-plugins/package-store.ts`、`installation-transaction.ts`、`registry-store.ts`、`plugin-operation-lock.ts`：不可变版本包、事务、registry 与跨实例管理。
- 各文件对应 `.test.ts`，含阶段故障和多进程 fixture。
- `scripts/plugin-validate.ts`、`plugin-pack.ts`、`plugin-verify.ts`、`plugin-test.ts`：统一作者工具；根 `package.json` 添加规范列出的四条 Bun script。

**修改文件：** `agent-modules/plugin-manifest-loader.ts`、`plugin-management-service.ts`、`plugin-management-ipc.ts`、`plugin-registry.ts`；审查 `safe-file.ts`、`data-root-instance-lease.ts` 的现有可复用能力，必要扩展必须有独立测试。

- [ ] 在临时目录生成正常包与恶意包 fixture：`../`、绝对路径、symlink、归一后重名、错误 size、重复 entry、超大展开流、额外未签名文件。
- [ ] 先写拒绝测试和确定性打包测试，再实现逐文件有界读取/解包；不得先不受限解包后校验。
- [ ] 实现 integrity 精确字节签名校验与发布者信任绑定；同 ID/版本不同摘要拒绝，开发未签名包隔离。pack --release 经安全 signer 生成签名；普通 verify 校验生产信任，--development 只返回明确的开发可用状态。
- [ ] 实现作者独立配置目录内的 publisher 密钥初始化/导入与公钥指纹导出；桌面本地文件安装允许未知作者内容包经显式限定信任安装，无需市场账号，不能升级为代码执行权。
- [ ] 实现阶段化事务和原子 registry 提交；将现有本地 JSON 管理保留为 V1 分支，不重新复制一套状态。
- [ ] 实现下载/验证与真正激活分离，预览与确认之间文件/依赖变化使 token 失效。
- [ ] 接入跨实例 intent、写锁与 lease；旧实例协议不兼容时阻止激活/迁移。验证两个独立进程同时写入与一个进程崩溃。
- [ ] 在每个阶段注入磁盘满、取消、异常退出和 post-commit 错误；验证重启读取事务后只完成已承诺步骤，原版本不遭破坏。
- [ ] CLI 使用与宿主相同的验证入口；锁文件、异常根、权限不足的错误能定位且不打印凭据。

**命令与期望：**

```bash
bun test apps/electron/src/main/lib/agent-plugins
bun test apps/electron/src/main/lib/agent-modules/plugin-management-service.test.ts apps/electron/src/main/lib/agent-modules/plugin-manifest-loader.test.ts
bun run plugin:validate ./examples/plugins/design-kit
bun run plugin:pack ./examples/plugins/design-kit --out /private/tmp/design-kit.ddplugin
bun run plugin:verify /private/tmp/design-kit.ddplugin --development
```

工具链实现后才执行新命令。示例未签名包仅开发验证通过，生产 verify 必须非零退出；使用注入的固定测试 signer/信任库验证 release 包生产验证通过。相同输入和 signer 两次打包输出字节一致；全部攻击 fixture 在活动目录写入前失败。依赖/外部清单变更后增加 `bun run electron:build`，确认打包版可用。

## 6. W3：Skill 引用、模块资源与运行快照

**责任：** C。

**新增文件：** `apps/electron/src/main/lib/agent-plugins/resource-resolver.ts`、`prompt-assembler.ts`、`resource-snapshot.ts` 及对应测试；可选设计约束在同一资源合同下校验与编译。

**修改文件：**

- `agent-modules/module-skill-resolver.ts`、`module-tool-policy.ts`；`adapters/pi-agent-adapter.ts`、`pi-skill-activation-tracker.ts`。
- `agent-workspace-manager.ts`、`agent-orchestrator.ts`、`agent-recovery-context.ts`、`agent-run-recovery.ts`。
- `packages/shared/src/types/agent-module-audit.ts`；`renderer/components/agent-skills/SkillCard.tsx`、`AgentSkillsView.tsx`；当前 composer 模块/Skill 选择组件。
- `apps/electron/default-skills/interaction-design/SKILL.md`：迁移时调整专属选择说明，任何正文变化同步增加 version。

- [ ] 固定真实请求装配的测试观察点，不仅断言字符串 helper；覆盖普通发送、queue-now、持久队列、Automation、内部受限任务和恢复。
- [ ] 增加 Skill 引用解析器，不复制 Skill 正文到插件目录；建立旧内置 slug 的显式兼容映射并测试用户同名 Skill 不被覆盖。
- [ ] 显示“模块 · Skill 引用”与真实来源；对可选/必需 Skill 分别实现缺失、版本冲突和作用域阻断提示。
- [ ] 实现提示用途、变量与输出合同；以设计模块的内部约束作为可选资源示例，保留项目真实视觉证据及用户明确要求的优先级，不要求其它模块提供设计资源。
- [ ] 内置模块通过宿主虚拟包及 providerDigest 兼容项目 Skill 引用、提示和 runtime 资源，不要求先交付独立业务包；依赖解析禁止从市场替换 builtin 身份。
- [ ] 将模块及其实际使用的资源引用接入既有消息序列化，支持切会话、恢复草稿、失效资源提示；不新增通用风格选择器，不恢复输入框上方常驻模块行。
- [ ] 实现分层提示装配和累计预算，包含 Skill 引用解析结果、结构化风格编译文本、覆盖和引用包装；补“说明短但 tokens/components 巨大”的回归。无模块选择时插件正文和 Skill 正文读取均为零，必需资源超额在模型调用前阻断。
- [ ] 冻结 plugin/package/skill/style/权限/数据 schema 快照，用户覆盖按内容寻址存不可变 revision；测试运行后编辑覆盖，旧运行仍读原内容，新运行用新版。将摘要纳入审计与恢复核验，记录选中和实际加载的区别。
- [ ] 以对照测试锁住“影像读取共享媒体且没有画布工具/提示”与“A 导出 B 的业务 Skill 仍需要 B 选择”；所有业务资源必须所属模块已选且引用有效。

**BDD 验收：**

```gherkin
Scenario: 未选择模块时不能通过 Skill 绕过
  Given 交互设计插件已安装且已启用
  And 当前消息未选择交互设计
  When 消息引用其所属 Skill 的全名或旧别名
  Then 模型调用前报告模块未选择
  And 没有交互设计提示或工具被接入

Scenario: 项目还原保持真实样式
  Given 插件默认风格为简洁商务
  And 项目已有明确的颜色和布局 token
  When 用户仅要求还原项目页面
  Then 使用项目视觉证据
  And 不把插件默认风格作为改版指令
```

**命令与期望：**

```bash
bun test apps/electron/src/main/lib/agent-plugins/resource-resolver.test.ts apps/electron/src/main/lib/agent-plugins/prompt-assembler.test.ts
bun test apps/electron/src/main/lib/agent-modules/module-skill-resolver.test.ts apps/electron/src/main/lib/adapters/pi-agent-skills.test.ts
bun run typecheck
```

新增正向及绕过用例全部通过，同时旧浏览器/终端自动行为与影像共享媒体边界保持。

## 7. W4：全局开关、队列、恢复与资源生命周期

**责任：** B 与 A；各自只改已分配文件，A 统一 orchestrator/service 接线。

**新增文件：** `agent-plugins/plugin-enablement-service.ts`、`plugin-run-leases.ts`、`plugin-data-policy.ts`、`plugin-garbage-collector.ts` 及测试。

**修改文件：** `agent-modules/plugin-host.ts`、`builtin-plugin-adapters.ts`、`module-command-dispatcher.ts`、`module-command-store.ts`；Agent service/队列和 Automation/Collaboration 的公共准入点；`agent-run-recovery.ts`。

- [ ] 先测试全局启用与消息选择两个条件的组合，防止旧 Session enabled/pinned 恢复成隐式激活。
- [ ] 实现 enabled/disabling/disabled；请求停用先关新任务，运行 lease 排空后才落 disabled。
- [ ] 接既有取消流程实现“停止任务并停用”；保留未知远端副作用，不伪造已回滚。
- [ ] 队列阻断而不丢正文/身份，Automation 显示可行动原因；重新启用不自动重放旧任务。
- [ ] 将数据所有权用于卸载/清理预览；作品、覆盖、共享凭据与审计默认保留。
- [ ] 处理传递依赖停用的消费者 blocked-dependency、租约排空、恢复包/覆盖对象保留和无引用 GC；回滚仅允许数据兼容组合。
- [ ] 多实例验证停用/派发竞态；各兼容实例发送前检查同一 registry revision。旧实例不支持协议时本实例先关准入并显示等待旧实例，不能声称全局停用/卸载成功。

**关键验收：** Given 运行中和排队中各一项，When 停用，Then 新任务立即受阻、运行任务显示排空中、队列不启动；所有 lease 释放后 UI 才显示已停用。Given 卸载后重装，Then 作品与自定义风格不丢失。使用真实多进程测试，进程内 mock 不能作为跨实例完成证据。

**命令：** `bun test apps/electron/src/main/lib/agent-plugins`，再运行模块命令、Agent queue、恢复相关定向测试；预期无新失败，全仓 `bun run typecheck` 通过。

## 8. W5：设置插件中心和统一管理 UI

**责任：** D，A 接四层 IPC。

**新增文件：**

- `apps/electron/src/renderer/components/settings/plugins/PluginSettings.tsx`、`InstalledPlugins.tsx`、`PluginDetails.tsx`、`PluginOperationDialog.tsx`、`PluginDeveloperPanel.tsx` 及交互测试。
- `apps/electron/src/renderer/atoms/plugin-atoms.ts`：唯一客户端目录/操作状态投影，不维护第二份安装事实。
- `apps/electron/scripts/plugin-management-smoke.ts`：真实 BrowserWindow/preload/IPC 的安装到卸载流程。

**修改文件：** `renderer/atoms/settings-tab.ts`、`settings/SettingsPanel.tsx`；`agent-skills/ModuleCatalog.tsx`、`PluginInstallDialog.tsx`、`AgentSkillsView.tsx`；现有 composer 菜单的管理跳转。

- [ ] 使用冻结 DTO 先做正在加载、空列表、离线、待配置、停用中、失败、更新可用等组件 fixture。
- [ ] 新增设置“插件”一级入口，放入市场/已安装/插件源/开发者四页；首批只对实际已交付能力显示可执行按钮，未连接源显示真实空态。
- [ ] 复用既有安装确认 UI，补作者、资源、权限变化、依赖、数据影响与进度；关闭弹窗不伪装后台操作已取消。
- [ ] Skills 页管理动作跳至插件详情；聊天底栏保留多选与最前面的 chips，无额外常驻模块行。
- [ ] 插件设置由声明式 schema 渲染，模型/渠道引用现有配置；验证密钥不进入普通 JSON、提示或诊断，必需配置缺失显示待配置。
- [ ] 开关、卸载、更新结果同时反映在设置、Skill 列表与消息选择中；失效草稿保留解释。
- [ ] 尚未迁出的内置六模块显示“随应用更新”，不展示包卸载/独立更新；关闭覆盖工作台/深链/旧命令，历史作品只读与共享基础服务保留。
- [ ] 加键盘/焦点、读屏、深浅主题、窄窗口测试；错误重试不会重复安装或发送任务。
- [ ] 运行真实 UI smoke，覆盖生产 preload 与管理服务，不仅渲染截图。

**命令与期望：**

```bash
bun test apps/electron/src/renderer/components/settings/plugins
bun run typecheck
cd apps/electron
bun run scripts/plugin-management-smoke.ts
```

成功证据需包括打开设置、导入包、查看所属 Skills、启用、选择、停用、卸载与数据保留；测试使用临时根，不修改真实插件和会话。

## 9. W6：官方/社区/私有源和市场

**责任：** D；B 负责下载内容进入同一安装事务，A 维护源合同。

**新增文件：** `agent-plugins/source-store.ts`、`source-client.ts`、`source-trust.ts`、`update-planner.ts` 及测试；`settings/plugins/PluginMarketplace.tsx`、`PluginSources.tsx` 及 UI 测试；`scripts/plugin-source-fixture.ts`。

**修改文件：** 现有凭据存储接入点与 `plugin-management-ipc.ts`，不把私有源令牌放进普通 JSON。

- [ ] 建立本地 HTTPS/可控测试传输 fixture，覆盖公开源、私有认证、过期索引、撤回版本和同名跨源冲突。
- [ ] 实现有界索引、分页/缓存/ETag、签名与 revision 检查；市场 metadata 是不可信数据，不是执行指令。
- [ ] 下载只接受符合源规则的地址和重定向；跨域不传原认证，日志/导出删除 token 与签名查询串。
- [ ] 将市场安装/更新交给 W2，相同包同一套预览、信任、依赖和事务，不另建快捷安装入口。
- [ ] 插件固定来源和发布者；换源显示身份核验；离线不误判“最新”，移除源不自动卸载。
- [ ] 设置 UI 提供搜索、分类、来源筛选、详情、更新与认证错误恢复；先使用真实配置源和夹具，不伪造官方在线市场。
- [ ] 版本撤回、密钥轮换、权限新增和数据不兼容都产生明确操作计划。

**BDD 验收：** Given 私有源认证过期，When 打开市场，Then 显示重新登录入口且本地已安装插件继续可用；Given 公共源提供同 ID 更高版本，Then 不替换已固定私有源插件；Given 摘要被篡改，Then 安装前拒绝。

**命令：** 对 source/update 测试及设置插件 UI 运行 `bun test`，再运行 `bun run typecheck` 和市场真实 UI smoke；测试无外部发布、无真实用户凭据。

## 10. W6H：真实运行宿主、broker 与界面扩展

**责任：** A 主责 Host 实现；B 提供包/租约接口，D 提供 surface 容器，E 在验收前不自行实现旁路。

**新增文件：** `apps/electron/src/main/lib/agent-plugins/runtime-launcher.ts`、`runtime-rpc.ts`、`capability-broker.ts`、`tool-contribution-registry.ts`、`surface-registry.ts` 及测试；`apps/electron/src/utility/plugin-runtime.ts`；`apps/electron/src/renderer/components/plugins/PluginSurfaceHost.tsx`；`examples/plugins/runtime-echo/`。

**修改文件：** W1 SDK 合同、插件 Host 入口、构建 external/资源清单、主进程与 preload 的受限 bridge；A 串行修改 orchestrator 的通用贡献装配。

- [ ] 冻结 manifest 的 runtime/surfaces 字段：受完整性保护的本地 ESM runtime entry、静态 UI entry、协议版本；不接受远程命令、安装脚本、任意原生依赖。
- [ ] 先用 echo/tool/surface fixture 写动态加载、错误 API、未受信包、撤销、超时与崩溃测试，再实现 runner 与版本化 RPC。
- [ ] broker 在连接建立时绑定真实插件身份，核对每次调用的 run/项目/授权/租约；消息伪造 pluginId 不能越权。
- [ ] 动态工具代理使用既有 Agent 审批和业务边界；停用/卸载后撤销注册，旧 RPC/迟到结果不能落入新版本运行。
- [ ] UI 在受限 surface 容器运行，不获取完整 preload；验证导航、弹窗、项目资源 URL 和跨插件句柄隔离。
- [ ] 验证 start/stop/dispose、异常退出及取消超时的释放责任；不把 utility 进程描述为恶意代码沙箱。
- [ ] 在同一宿主二进制中安装两个版本的 fixture，动态展示工具/界面，更新后保留旧运行快照，卸载后无残留监听器。

**门槛：** `bun test apps/electron/src/main/lib/agent-plugins`、全仓 typecheck、Electron build、真实 utility/RPC/surface smoke 通过；启动的是包内真实代码，不能用内置 mock 代替。此阶段仅受信 runtime，可执行社区包仍被明确拒绝。

## 11. W7：交互设计首个完整业务插件试点

**责任：** E；先资源后 runtime，两次独立可验收提交。

**新增目录：** `plugins/interaction-design/`（基于统一脚手架的独立源码包、清单、资源、测试和构建配置）；复用 W1 的 `examples/plugins/design-kit/` 验证外部作者路径。新增根目录不会自动加入现有 `packages/*` / `apps/*` workspaces，需要在构建/工作区设置中明确纳入或使用独立 Bun 项目。

**修改范围：** `apps/electron/src/main/lib/interaction-design/`、renderer 交互设计组件目录、`agent-orchestrator.ts` 的模块装配、`agent-modules/builtin-plugin-adapters.ts`，以及当前 build/resources 规则。

- [ ] 先列出原型存储、项目访问、工具、UI、素材、任务/候选/采纳与历史版本的所有权表，保留 pageId/revision/asset 等现有合同。
- [ ] 把模块 runtime、工具、Surface、提示、默认风格与资产迁为包资源；保留项目 Skill 引用和旧身份映射，不复制或覆盖用户内容。
- [ ] 用 Host SDK 注册实际工具与服务生命周期，把主 orchestrator 的业务直接 import 改为稳定贡献装配；host core 只知道公开能力类型。
- [ ] UI 通过受限 surface bridge 接会话/独立工作台导航与产物句柄；保留设备预览、浏览器 Web、历史候选与页面 CAS。
- [ ] 本阶段插件迁移只处理 `data/<pluginId>` 私有数据；交互设计作品保持现有项目布局和 schema，由插件兼容读取。未来必要的项目产物升级须另设宿主拥有的显式迁移与备份/CAS/回退，不混进安装事务。
- [ ] 独立构建包并在隔离打包版安装、更新、停用、卸载与重装；验证相同宿主二进制无需重新编译即可加载新插件包。
- [ ] 原有原型创建/局部改动/风格切换/还原/采纳/导出/旧作品读取全部回归，检查画布与影像不受影响。

**退出标准：** 新开发者改插件目录即可独立交付版本；包可独立卸载；旧硬编码业务装配不再是生产后门。仅把文件移动目录或创建空 lifecycle adapter 不算完成。

**验证：** 交互设计域、renderer、Agent 工具测试；全仓 typecheck；Electron build 与目标平台打包 smoke；真实 UI 使用离线确定性 fixture 验证样式/交互。真实模型效果若未测必须单独列出，不能拿静态 JSON 通过冒充视觉质量保证。

## 12. W8：其它模块迁出与贡献者验收

**责任：** A 统一接口；各业务维护者独占插件目录。

建议顺序不是硬性并发禁令，而是依赖关系：先固化共享媒体 broker，再处理影像创作/画布；服务器运维、接口工作台、编排工厂在 SDK 达到其工具和进程需求后各自迁出。浏览器/终端保持宿主基础能力。

- [ ] 为每个模块建立依赖和数据所有权清单，确认插件关闭不会停止被其它模块共享的服务。
- [ ] 每个模块按 W7 的完整退出标准迁出，独立包/版本/回归/卸载证据齐备后才移除原实现路径。
- [ ] 复用首版已完成的标准脚手架作者验收，为业务插件增加不修改宿主的独立交付验收，不把前者拖到本阶段。
- [ ] 在首版已公开的贡献指南、SDK、模板、兼容矩阵基础上增加实际支持的 runtime API 与示例；规范与工具版本同步。
- [ ] 扩大首版已支持的社区/私有内容包分发范围；新增真实发布地址、签名托管和维护者归属另走发布流程。
- [ ] 任意第三方可执行插件维持显式门槛，完成实际隔离验证和跨平台支持后另立计划开放。

## 13. 需求覆盖与验收编号

| 用户要求/补缺 | 工作包 | 验收编号 |
| --- | --- | --- |
| Skill 标注模块名称、来源，避免同名误用 | W1/W3/W5 | A01：真实归属、改名稳定、同名消歧 |
| 统一插件规范与提示/资源合同 | W1/W3/W7 | A02：一个脚手架、提示有章法、资源按需归属、设计还原不改版 |
| 独立插件包、可以安装和卸载 | W2/W4/W7 | A03：包可验证、事务恢复、作品保留 |
| 可以关闭 | W4/W5 | A04：关新准入、排空、队列/恢复不绕过 |
| 设置内插件市场 | W5/W6 | A05：统一状态、发现到安装闭环 |
| 私有源分发 | W2/W6 | A06：认证、来源锁定、离线与同名防替换 |
| 大家基于我们的脚手架开发 | 首版 W1–W6；后续 W6H/W8 | A07：同一脚手架、独立 SDK/CLI、仓库外交付；业务代码另验收 |
| 升级/降级、数据与用户修改 | W2/W4/W7 | A08：不半覆盖，不丢作品/自定义，不伪造回滚 |
| 并发实例与中断恢复 | W2/W3/W4 | A09：跨进程锁/lease、精确快照核验 |
| 权限/性能/安全来源 | W1/W2/W3/W6/W6H/W7 | A10：校验/预算/隔离分层、权限不扩张 |

每个 PR 关联验收编号，提供通过/失败/未测及证据位置。测试中出现真实外部副作用需明确授权；日常 CI 均使用本地夹具。

## 14. 交付记录与提交规则

- 每个工作包先测试合同，再实现，再做独立评审；提交采用中文说明，粒度以可回滚的完整行为为单位。
- 共享文件按职责提交，不纳入其它会话的并行修改、依赖变更和运行数据。实现中发现新依赖先说明理由和用户影响。
- 每阶段运行最小相关 BDD、`bun run typecheck`；改运行依赖/external/打包则追加 `bun run electron:build`；涉及发布包必须测试目标平台真实产物。
- 不用 UI 截图替代 IPC/运行行为验证，不用工具可见替代实际调用，不用 Node-only 测试替代真实 Electron。
- 记录包校验耗时、目录热缓存解析、未选择资源读取次数和停用后资源数；用明确样本和设备评价性能，不以估算冒充测量。
- 本规划只产生文档；下一步优先执行 W0/W1，然后并行 B/C/D。完整业务插件完成后才更新产品宣传为“模块完整插件化”。
