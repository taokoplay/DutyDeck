# DutyDeck 插件模块首版实施规划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DutyDeck 提供统一插件规范与标准脚手架，外部作者在独立仓库按此开发，把可执行业务模块、Agent 工具、右侧 Surface、受控服务、状态和提示交付为一个插件包；项目/工作区已有的 Skills 继续由现有 Skill 系统管理，插件只声明稳定 Skill 引用。用户在设置插件中心管理，并在消息中选择使用，全程无需修改或重新编译宿主。

**Architecture:** 统一清单、模块入口、Skill 引用、提示结构、工具/Surface/服务合同、生命周期和开发校验。在现有 manifest-only 机制上增加真实模块 runtime、统一准入、安装事务和设置插件中心；公开 SDK 为合同唯一来源，市场和私有源复用本地安装器。`content` 仅保留旧版兼容，新脚手架以受信 `module-runtime` 为目标。

**Tech Stack:** Bun、TypeScript、Electron、React、Jotai、Radix/shadcn、JSON/JSONL、现有 safe-file 与实例协调能力；首版无数据库、无第三方代码执行框架。

---

更新：2026-10-19。用户已授权开发，现已实现统一 SDK/CLI、独立内容包、本地安装生命周期、消息选择和设置管理的最小闭环。具体交付与限制见 [本地交付说明](2026-10-19-plugin-local-delivery.md)。本文件是完整首版清单，未勾选项继续保留；本地闭环不代表市场、私有源或任意业务插件已经完成。通用规范见 [插件生态设计](../specs/2026-10-19-plugin-ecosystem-design.md)，长期工作包见 [生态路线图](2026-10-19-plugin-ecosystem-roadmap.md)。本文件对首版顺序与外部作者验收的定义优先于旧路线的笼统阶段描述，不改变其安全、数据、命名和权限合同。

本次纠正“风格”的解释：核心是我们规定插件开发方式，让作者在我们的脚手架内开发。Skill 不随插件打包，设计约束可以随业务放在包内，但不单独形成安装类型，也不要求所有插件携带视觉资源。

## 1. 首版交付范围

首版应同时交付“用户能安装使用”和“作者能独立制作”两个闭环；只有设置页或只有清单格式不算完成。

| 能力 | 首版交付 | 用户收益 |
| --- | --- | --- |
| 设置插件中心 | 市场、已安装、插件源、开发者；统一详情与操作进度 | 管理入口明确，不必在 Skills 页找安装按钮 |
| 统一插件包 | 声明模块 runtime、工具、Surface、受控服务、Skill 引用、提示、输出模板、受限静态素材和声明式设置 | 一次安装获得该插件的完整受支持能力，复用项目已有 Skill |
| 统一开发规范 | 目录、命名、提示结构、资源引用、UI 约定、版本与测试；设计约束按需随包携带 | 不同作者的插件接入与管理方式一致 |
| 生命周期 | 导入、校验、安装、启用、停用、升级、兼容回退、卸载 | 能控制插件，失败不破坏当前可用版本 |
| 本地与私有分发 | `.ddplugin` 本地文件；配置公开/私有 HTTPS 索引 | 无需公开上架即可个人使用或团队共享 |
| 开发者工具 | 可独立获取的 SDK/Schema、CLI、标准脚手架、测试与开发模式 | 开发者不依赖 DutyDeck monorepo 或内部路径 |
| Agent 接入 | 模块/Skill 归属、消息选择、按需提示、资源快照、调用记录 | 使用了什么能力可以解释，未选专业模块不接入 |

下一阶段交付动态业务工具、独立界面、后台服务和完整可执行插件 Host；首版作者不能通过包声明获得新 Node/系统工具、任意 UI 脚本、原生依赖或自动后台任务。基础浏览器/终端继续通过已有权限链自动按需使用。

模板是文本/结构化输出约束及惰性读取资源，不是可执行模板引擎。插件提供的自动化建议也只是草稿，用户通过现有 Automation 配置明确保存后才形成任务。

## 2. 内置模块如何纳入首版

| 模块 | 首版处理 | 后续完整迁出 |
| --- | --- | --- |
| 交互设计 | 插件详情、全局准入开关、Skill 引用及包内提示/设计约束规范 | 首个服务/工具/UI 完整插件试点 |
| 影像创作 | 统一来源与开关；保留共享媒体能力边界 | 共享媒体接口稳定后迁出 |
| 画布 | 统一来源与开关；保留作品及内部受限任务 | 与影像按依赖顺序迁出 |
| 服务器运维 | 统一来源与开关，保留资源授权/受限执行 | runtime 与凭据代理成熟后迁出 |
| 接口工作台 | 统一来源与开关，保留请求审批与项目数据 | runtime 与网络代理成熟后迁出 |
| 编排工厂 | 统一来源与开关，保留场景数据与既有执行边界 | 编排接口稳定后迁出 |
| 浏览器、终端 | 保留基础自动能力，不列入专业模块选择 | 不因专业插件停用而停止共享基础服务 |

尚未迁出的六个模块显示“内置 · 随应用更新”，可以停用；不提供虚假的包级卸载或独立升级按钮。停用必须覆盖聊天、手写 Skill、后台/内部任务、右侧入口和旧 UI 命令；对专业任务及专属订阅执行真实取消/释放。宿主共享服务继续由其自身消费者管理，不宣称共享进程全部退出。

内置模块通过宿主虚拟包记录参与统一目录和依赖核验，记录 `managedBy: host`、能力版本与 providerDigest；不能从市场下载、覆盖或卸载。交互设计先把现有项目 Skill 引用、提示和设计约束映射到统一模块合同，后续再迁出实际业务代码。外部作者按照标准脚手架创建自己的模块，不需要复制内置 Skill 正文。

## 3. 用户可见流程

### 3.1 插件中心

```text
设置 → 插件
  市场：搜索、来源筛选、兼容状态、详情、安装/更新
  已安装：全部/已启用/已停用/待配置，插件开关与详情
  插件源：官方/社区/私有源、认证和同步状态
  开发者：模板与文档、导入开发包、隔离预览、校验报告
```

没有已配置源时展示“添加插件源 / 从文件安装”；源不可达展示缓存和上次同步时间，不伪造推荐插件或已上线的官方市场。市场服务上线与客户端能力交付分别验收。

详情包含简介、作者/来源、模块、Skill 引用解析结果、实际携带的 runtime/Surface 资源、版本、权限与设置、依赖、变更记录、诊断。首版配置页由宿主按 schema 渲染，无关资源不显示空的专门栏目。

### 3.2 安装与使用

1. 从市场或本地 `.ddplugin` 选择包。
2. 校验完整性、兼容性、发布者、依赖和内容预算；展示实际资源及权限，不执行其中的指令。
3. 用户确认包及来源信任；已知发布者密钥变化、同 ID/版本不同内容必须阻断普通安装。
4. 安装完成，按可见的“安装后启用”选项设置状态；缺少必需配置则标为待配置。
5. 用户在输入框底栏选择专业模块，模块 chip 位于消息最前面；Skill 显示“所属模块 · Skill 名称”。
6. 宿主按模块声明解析其 Skill 引用、提示及必要 runtime 资源；模块确有业务选项时在其详情配置，发送时按稳定身份重新核验。
7. 调用记录显示本轮实际接入的插件版本、Skill revision 和 runtime 资源，不把安装/选中当成执行完成。

### 3.3 关闭、升级和卸载

关闭先禁止新任务，正在运行的任务显示排空中；可明确停止后关闭。排队、Automation 与传递依赖使用同一准入规则。不可协调的旧实例存在时显示等待，不声称全局关闭成功。

更新先展示变更/新增权限和用户自定义差异，冻结当前运行快照，在安全边界切换活动版本。只支持数据兼容的回退；代码回退不自动覆盖用户作品。

卸载移除插件目录准入与无引用包，保留作品、会话、用户覆盖和审计；单独的数据清理展示确切范围。缺失资源的旧草稿保留错误提示，不静默移除模块后发送。

## 4. 外部作者闭环与公开工具

规划发布两个独立包，名称为建议值，发布前核验命名空间与发行权限：

- `@dutydeck/plugin-sdk`：Schema、稳定类型、纯校验/归一化、兼容与资源引用合同；不能依赖 Electron、DutyDeck 的未发布 shared 包或 monorepo 路径。
- `@dutydeck/plugin-kit`：`dutydeck-plugin` CLI，提供 init、validate、pack、verify、test、publisher 子命令和模板；只依赖已发布或同批独立交付的公开包。

单一依赖方向为：`plugin-kit → plugin-sdk ← 宿主 shared 适配层`。旧 shared 文件保留兼容导出，纯合同迁入 SDK 后不能同时手写另一份解析器。公开包构建出的导出清单不含 `workspace:*`、内部绝对路径或宿主业务模块。

作者旅程：获取固定版本工具 → 从标准脚手架创建工程 → 实现模块及所需资源 → 本地校验 → 在隔离数据根调试 → 生成发布者密钥并签名打包 → 将包交给用户/私有源。界面与 CLI 文档都列明“当前可用能力”和兼容宿主版本。

下列为最初规划命令；现已实现的准确参数与离线 tarball 安装方式见本地交付说明（init 必须指定 --id）；`dutydeck-plugin` 来自作者项目中固定版本的 plugin-kit。作者无需克隆宿主仓库：

```bash
bun run dutydeck-plugin init my-plugin --id acme.my-plugin
bun run dutydeck-plugin validate ./my-plugin
bun run dutydeck-plugin test ./my-plugin
bun run dutydeck-plugin pack ./my-plugin --out ./my-plugin.ddplugin
bun run dutydeck-plugin verify ./my-plugin.ddplugin --development
```

`init` 只使用一个标准脚手架，生成一个可校验的示例模块；作者按需要添加模块和资源。下面是源工程布局，包载荷由清单与白名单确定，测试和开发工具不会被全部塞入安装包：

```text
my-plugin/
  plugin.json                    # 身份、版本、模块入口、资源引用和权限
  package.json                   # 固定版本工具与统一开发命令
  prompts/workflow.md            # 用途、输入和输出约束
  runtime/module.mjs             # 受信模块 runtime
  surfaces/module/index.html     # 受限右侧 Surface（可选）
  resources/                     # 业务所需模板与资料，按需生成
  styles/                        # 设计类业务的可选约束资源
  assets/                        # 图标、示例等静态资产，按需生成
  settings.schema.json           # 声明配置时生成，由宿主统一呈现
  tests/                         # 模块与资源合同测试
  README.md                      # 开发、安装和使用说明
  LICENSE                        # 许可声明
  CHANGELOG.md                   # 版本变化
  THIRD_PARTY_NOTICES.md          # 第三方资源来源与许可说明
```

模块入口与资源关系集中在 `plugin.json`，不另维护第二份模块配置。清单按需引用资源和设置 schema；示例占位数据须能通过校验，缺少资源引用、归属或许可时给出可定位错误。未声明的可选目录无需存在。后续 Host 支持代码执行后，在同一工程中增加 `src/tools/`、`src/ui/`、`src/lifecycle.ts` 等源码并声明构建产物，当前不生成假装可运行的空接口。

平台交付的开发规范覆盖命名、Skill 引用、提示用途/变量/输出、工具/服务/Surface、UI 主题与交互状态、权限、错误/取消、版本兼容和最小测试；作者只实现自己的业务。脚手架记录所用 SDK/模板版本，升级提供差异与迁移说明，不覆盖作者业务文件或项目 Skill。

普通 pack 生成未签名开发包，只能在隔离开发根加载；正式分发用 `publisher init` 创建本地 signer，`pack --release` 调用该 signer。私钥放作者本机受保护的密钥存储，不进入项目、包、版本库或命令输出；允许通过受保护句柄接 CI signer。publisher 子命令要提供公钥/指纹导出和密钥轮换说明。

CLI 的 signer/信任配置使用独立 `--config-dir`，默认目录由作者工具按平台解析，不依赖 Electron 安装或宿主数据根；verify 可选用独立信任库，不能默认读取作者的真实 DutyDeck 会话/渠道设置。用户安装时由桌面程序管理自己的信任记录。

宿主根目录的 `plugin:validate / pack / verify / test` scripts 只调用相同 CLI，不形成另一套作者专用实现。

### 4.1 直接文件安装的信任规则

首版允许第三方作者自行签名内容包，无需先成为官方作者或注册市场账号。首次导入携带公钥证明但尚无可信身份绑定的包时，宿主先验证签名与内容一致性，再展示“未验证发布者”、公钥指纹、插件身份和内容；用户可显式信任这个插件 ID 与密钥的绑定后安装。

该记录是本地信任，不等同官方认证、不自动信任作者所有插件、不授予可执行 runtime 权限。命名空间与本机已有绑定冲突、冒用保留官方身份、签名不匹配均拒绝，不能靠普通确认覆盖。当前信任与安装 token 绑定包摘要和 registry revision。

私有源可以预先导入团队信任锚，仍使用同一校验器。只有本地文件时不会凭包自报地址开启自动更新；更新来源必须由用户明确绑定。

## 5. 插件模块内部职责

| 组件 | 唯一责任 | 不承担的职责 |
| --- | --- | --- |
| 公开合同与校验器 | 解析 manifest/风格/依赖/资源和支持矩阵 | 不读宿主配置、不授予权限 |
| 包与信任服务 | 验证文件、摘要、签名、发布者绑定 | 不执行安装脚本、不发模型请求 |
| 管理事务与注册表 | 版本激活、开关、租约、升级、卸载 | 不拥有用户项目作品 |
| 资源与 Agent 适配 | Skill 归属、选择准入、风格/提示编译和快照 | 不通过名字猜权限、不增加工具权限 |
| 源与市场服务 | 有界索引、认证、缓存、下载/更新计划 | 不另建快捷安装通道 |
| 设置与聊天界面 | 展示状态、提交操作、处理错误/失效选择 | 不自行写插件目录或判定签名可信 |

安装后置于共享数据根的不可变版本目录；用户覆盖另存内容寻址对象。运行前仅加载所选模块的必要资源；目录/市场元数据缓存，不随 token 或输入触发扫描/联网。

## 6. 四层 IPC 与状态一致性

已实施的本地 V2 使用独立 `CONTENT_PLUGIN_IPC_CHANNELS`，保留 V1 清单 IPC 兼容；renderer 仍不能指定任意读写路径。以下完整首版事务合同继续作为后续目标，本地实现使用一次性预览 token、注册表 revision、同步原子提交和目录变化刷新。

| 操作 | 输入合同 | 结果与失败语义 |
| --- | --- | --- |
| 文件预览 | 原生选择器；renderer 不提供任意路径 | token、包摘要、内容、身份/依赖/权限状态 |
| 确认安装/更新 | token、requestId、expectedRevision、明确的信任/授权选择 | operationId、阶段、最终 registry revision；过期 token 拒绝 |
| 启用/停用 | pluginId、requestId、expectedRevision、等待/停止策略 | 即时状态或排空进度；失败不伪造 disabled |
| 卸载 | pluginId、requestId、expectedRevision、已预览的数据策略 | 租约/依赖阻断或提交结果 |
| 读取/刷新源 | sourceId 与有界查询/分页；认证走独立凭据 UI | 缓存时间、下一页、认证/离线/完整性错误 |
| 配置插件 | pluginId、schemaVersion、expectedRevision、允许的字段值 | 新配置 revision 或字段错误；密钥仅接 credentialRef |

所有写操作由主进程校验身份与状态，requestId 幂等；目录变化通知含 revision，renderer 发现缺口重新读取快照。进度事件不可被当作提交成功；未知终态读回事务判断。shared 类型、main handler、preload bridge、renderer Jotai 投影在同一任务内核对。

## 7. 开发阶段、文件责任与退出门槛

每项开始时先建立有意义的 BDD 失败用例，再实现，最后提交通过证据；已有相关测试不重复编写。

### P1：统一开发规范、公开合同与标准脚手架

**主要文件：** `packages/plugin-sdk/src/{contracts,validation,index}.ts`、`packages/plugin-sdk/schemas/`、`packages/shared/src/types/{agent-plugin,plugin-package,plugin-resources}.ts`；模板位于 `packages/plugin-kit/templates/standard/`。

- [x] 把统一 manifest、模块归属、提示结构、可选资源与共享规则变成单一可执行合同；V1 走兼容适配。
- [ ] 添加支持矩阵：模块 runtime、Skill 引用、提示、可选设计约束、工具、Surface、服务、设置与共享资源；未知必需能力在安装前拒绝。
- [ ] 明确 typed 校验结果：结构有效、签名有效、身份可信、版本兼容、可激活是不同事实。
- [ ] 生成标准脚手架、规范说明与契约测试；覆盖基础 runtime、Skill 引用解析、携带可选资源、不含设计资源、引用缺失/作用域错误、同名模块、关闭、跨包私有引用及超预算。
- [ ] 定义 SDK/脚手架版本记录与升级规则，确保资源路径、包白名单和作者命令一致，不覆盖已有业务实现。

**退出：** 一个脚手架能生成包含 runtime、工具、Surface 和 Skill 引用的插件，有无设计资源都可表达；包内没有 Skill 正文；开发者用独立 SDK 可校验，shared 不含重复权威实现。对应总路线 W1。

### P2：真实包、信任与管理事务

**主要文件：** `apps/electron/src/main/lib/agent-plugins/{package-reader,package-integrity,publisher-trust,registry-store,installation-transaction,plugin-operation-lock}.ts`；现有 `agent-modules/plugin-management-service.ts`；公开打包验证逻辑放 `packages/plugin-kit/src/`，纯共享校验留 SDK。

- [x] 实现 ZIP 限额、文件白名单、完整性签名、首次第三方内容包信任与已知身份冲突规则。
- [ ] 实现阶段化安装/更新/兼容回退/卸载、版本目录不可变和安全 JSON 写入。
- [ ] 实现跨实例 writer/lease 和依赖锁定；模块 runtime 也覆盖进行中的 Agent 请求与恢复引用。
- [ ] 注入每个提交阶段故障，验证取消、崩溃、磁盘满、陈旧 token、同版本替换与 dev/prod 并发。

**退出：** 已有版本不被半覆盖；未知发布者包有明确的可完成信任流程；安装不依赖市场。对应 W2。

### P3：Skill 引用、模块 runtime、开关与 Agent

**主要文件：** `agent-plugins/{resource-resolver,prompt-assembler,resource-snapshot,plugin-enablement-service,plugin-run-leases}.ts`；现有模块 resolver/policy、Pi Skill 适配、队列/恢复及内置资源声明。设计约束的校验和编译使用同一资源合同。

- [ ] 按模块清单解析项目/工作区 Skill 引用，记录稳定 revision/hash；用户已有 Skill 和旧别名用显式适配保留，绝不复制或覆盖正文。
- [ ] 按模块清单读取包内提示、工具、Surface 和必要 runtime 资源；内置交互设计的既有 Skill、工作流与设计约束映射到同一合同，遵守所属模块的消息选择。
- [ ] 全局开关与消息选择共同控制 Agent、UI 命令、Automation、Collaboration 和内部任务；不影响宿主基础能力。
- [ ] 提示预算计入最终编译文本，包括 Skill 引用包装和可选设计约束；运行记录保存 Skill revision、插件版本/hash 和不可变覆盖内容对象。
- [ ] 验证关闭排空、传递依赖阻断、旧草稿/排队/恢复、共享媒体和内部受限授权。

**退出：** 未选无注入，关闭无新准入，影像共享媒体不引入画布；新插件的模块能加载受控 runtime 并解析项目 Skill，内置设计工作流保持兼容。对应 W3/W4；不依赖 W6H。

### P4：设置插件中心与消息展示

**主要文件：** `renderer/components/settings/plugins/`、`renderer/atoms/plugin-atoms.ts`、`settings-tab.ts`、`SettingsPanel.tsx`、`agent-skills/{SkillCard,ModuleCatalog,PluginInstallDialog}.tsx`、composer 模块选择；四层 IPC。

- [ ] 增加四个子页、统一详情、开关、版本/来源/配置、数据影响预览与操作进度。
- [ ] 迁移 Skills 页管理入口；保留项目 Skill 列表、解析来源与所属模块标签，聊天底栏保留多选和前置 chip。
- [ ] 内置模块显示随应用更新，不提供尚不存在的包卸载；关闭后的旧 UI 请求也由后端阻断。
- [ ] 覆盖加载/空/离线/待配置/停用中/失败/权限不足，键盘、焦点、窄窗口和深浅主题。

**退出：** 本地包从导入到使用/更新/卸载的真实 Electron UI 链路通过，所有页面显示同一事实。对应 W5。

### P5：公开与私有插件源

**主要文件：** `agent-plugins/{source-store,source-client,source-trust,update-planner}.ts`、设置 `PluginMarketplace.tsx`、`PluginSources.tsx`、凭据桥接。

- [ ] 实现可配置 HTTPS 索引、分页/ETag/缓存、作者身份与包摘要；依赖来源固定，不能跨源替换同名包。
- [ ] 私有认证通过 credentialRef 保存，跳转/日志/导出不泄漏认证；源失效不卸载本地插件。
- [ ] 市场安装/更新调用 P2 同一事务，不存在绕过本地校验的快捷路径。
- [ ] 提供本地公共/私有测试源完成端到端验证，记录真实服务上线是独立发布动作。

**退出：** 本地、公共源、私有源交付同一个包时校验与结果一致；断网仍可管理已安装插件。对应 W6。

### P6：独立开发者工具与对外验收

**主要文件：** `packages/plugin-kit/{package.json,src/cli.ts,src/commands/,templates/}`、`packages/plugin-sdk/package.json`、`scripts/plugin-external-author-smoke.ts`、未来 `docs/plugins/` 作者指南与支持矩阵。

- [x] CLI 和 SDK 生成独立可安装发行物；构建/发布检查拒绝 workspace 依赖、内部源码 import 和未包含的资源。
- [ ] 实现 init/validate/test/pack/verify/publisher，开发模式隔离根、signer 公钥导出与正式签名流程；repo scripts 只转发。
- [ ] 在仓库外临时目录仅安装候选 SDK/CLI 发行物，从同一脚手架生成含设计约束和不含设计约束的两个业务示例；不通过软链接借用宿主源码或 node_modules。
- [ ] 使用独立作者密钥，给已构建且内容固定的候选发布版客户端导入包；其包/CLI 版本、客户端版本和 hash 全程记录。
- [ ] 完成首次信任、安装、选择、资源注入、更新、关闭、卸载及作品保留；旧不兼容客户端明确拒绝。
- [ ] 由未参与宿主改造的贡献者重复流程，记录阻碍；同一宿主二进制通过全部测试才接受“无需修改宿主”。
- [ ] 公开 SDK/CLI 与兼容客户端正式发布后，再从干净机器通过正式公开入口复验。候选发行物验证不冒充已经公开可用。

**退出：** 外部作者能按统一规范独立制作、交付并更新插件；市场上架不是本地安装前置。对应 W1/W2 的工具交付及原 W8 的作者验收，提前到业务迁出之前。

## 8. 并行安排与公共文件所有权

- A 负责公开 SDK/IPC、共享类型适配和 Agent 公共接线，先交付 P1；P6 的发行包装同时开始。
- B 负责 P2 与 P3 的启停/租约，C 负责 P3 的包内资源与提示规范，接口冻结后并行。
- D 负责 P4/P5；可先用冻结 DTO 做界面，真实操作验收等 P2/P3 完成。
- 集成负责人独占 shared 公共导出、main ipc、preload、orchestrator/service 接线；其它人员提交适配器与测试，不同时修改公共入口。
- P6 最终验收等待 P2–P5 集成；P2/P3/P4 完成即可做本地内容包内部预览，不提前宣布整个首版完成。

接口依赖是开发顺序依据，不用未经测量的天数承诺替代工作量。每个阶段是可 review、可回滚的提交；中文提交信息，验证证据附同一 PR。

## 9. 首版验收清单

- [ ] 同一脚手架在独立仓库生成插件，候选发行版和正式发布后的客户端分别验证，不要求宿主源码改动。
- [ ] Skill 引用有可信项目/工作区来源；重名、别名、第三方冒用模块身份不会误接入。
- [x] 仅本轮选中专业模块才加载所属资源；包内可选资源不会自动选择其它模块，也不扩张工具权限。
- [ ] 已启用与正在运行分开；停用覆盖所有新准入，依赖/旧实例/排队/恢复语义明确。
- [ ] 安装、更新、回退、卸载失败保持可核验状态；无运行引用的包才回收，作品和用户覆盖保留。
- [x] 首次第三方内容包可经清晰信任流程安装，无需官方作者身份或市场账号。
- [ ] 设置四页和聊天/Skills 投影一致；离线、私有认证过期、配置不足有独立反馈。
- [ ] 通过相关 BDD、全仓 typecheck、Electron build、真实 UI 与跨实例 smoke；未测模型效果如实列出。
- [ ] 热缓存目录、Skill 正文读取次数、包校验峰值和关闭后 runtime/Surface 资源释放符合通用规范预算；没有逐 token 扫描或网络请求。
- [x] 技术文档和宣传准确列出统一插件机制当前支持的模块、Skill 引用、提示及包内资源，不提前声称可安装任意第三方业务代码。

建议验证入口在实现后提供 `bun run plugin:external-author-smoke`；实际脚本为 `scripts/plugin-external-author-smoke.ts`，使用独立临时目录和测试数据根，绝不操作用户真实作品/信任库。其失败必须定位到作者步骤，不能仅返回笼统的“插件不可用”。

## 10. 首版之后的边界

先完成长期路线 W6H 的真实 runtime/broker/surface，再完成交互设计完整业务包，随后迁出其它专业模块。第三方业务插件需单独定义受支持能力和可审计的信任/隔离路径；官方身份不能是永久唯一入口，也不能把本地兼容内容包升级为任意代码执行权。

本次交付为规划文件。下一项开发任务从 P1 的统一规范、公开合同和标准脚手架开始，随后按公共接口推进安装管理与 Agent 接入。
