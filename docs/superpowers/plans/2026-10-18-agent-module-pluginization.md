# Agent 模块插件化改造实施计划与验收记录

更新日期：2026-10-19。用户已授权实施、完成后启动 dev 及本地 Git 提交；提交范围为本轮模块插件化与相关恢复、开发启动修复，不包含推送或发布。

## 目标与实现原则

画布、影像、交互设计、浏览器和终端通过统一模块目录展示。用户在聊天模块栏启用模块后，该会话后续运行确定解析对应的 Skills 与提示；`/module:<id>`、`@module:<id>` 只作用当前回合。未知、禁用或缺依赖的模块明确报错，不静默吞掉正文。

保留唯一 Pi Agent runtime。插件贡献补充能力路由，不授予新的工具权限；实际工具仍经过宿主权限、项目范围和业务合同。启用模块不等于要求模型无条件执行模块的每个工具。工具审计只报告真实调用，不根据名称猜测其属于哪个模块。

技术栈沿用 Bun、Electron、React、Jotai、Radix/shadcn、JSON/JSONL，无新增依赖。

## 八项工作交付状态

| 工作 | 已交付行为 | 验证或明确边界 |
| --- | --- | --- |
| 1. 插件 Manifest 与注册 | 内置优先；受管目录发现；命名空间内纯文本 prompts；原生选文件预览、确认安装、刷新与卸载；来源、warnings、诊断可见 | 预览 token 绑定规范化内容，一次使用；读取与最终写入均限制 1 MiB；禁止覆盖现有目录；不运行第三方 JS、不复制外部 Skills |
| 2. WorkContext 与入口 | 会话侧栏、独立页面、阻断三种路由；请求携带 Session、requestId、surface、navigationRevision；展示打开/失败/取消回执与重试 | 切会话或导航取消在途请求；迟到结果不抢焦点；终端“已打开”表示标签打开，PTY 就绪由终端负责 |
| 3. 持久化模块命令 | 原子 outbox、revision、幂等键；首次创建才派发；重复提交和重启不重放；取消须实际撤队或确认 Session 完全空闲 | 原方案的自动 claimNext 改为保守核验与用户显式恢复；running 命令由关联运行终态/放弃收束，不能靠重复发送恢复 |
| 4. Journal 与精确续接 | 展示字节回执、Pi session/branch/tip/hash、工具与权限事件对账；真正落盘边界发布绑定；中断后按 run/branch/sequence CAS 领取；继续或保留日志放弃 | 只有已匹配、无未确认副作用、Pi 尾部为 user/toolResult 的普通用户运行可继续；同一运行只领取一次；缺证据、旧日志、内部受限任务不猜测恢复 |
| 5. Plugin Host | 五个内置适配器复用既有业务服务；生命周期、幂等停止、逆序释放、健康事件与隔离诊断 | Host 健康不代表供应商已配置或真实媒体生成验收；外部可执行插件仍待独立沙箱合同 |
| 6. 目录与模块 UI | 目录显示版本、来源、贡献、当前项目 Skill 可用/禁用/缺失、刷新时间、安装 warnings；聊天栏启用/固定、窄窗口全部模块 Popover | 目录为全局管理入口，启用/固定留在明确的当前会话模块栏；无需另建缺少会话上下文的独立详情页面 |
| 7. 调用审计 | Journal 记录 module-context、实际 Skill 激活、版本、模式和关联 commandId；独立审计视图按需展开/刷新；工具按 parentEventId+toolUseId 配对 | 不返回路径、完整提示或参数；不把“声明可用工具”混作“已执行工具”；普通发送/注入/排队 IPC 无权伪造 commandId |
| 8. 验收与兼容 | 旧 Session 无策略按 auto；坏/未知 outbox 保留原字节且阻断覆盖；真实 Electron UI 与 utility SIGKILL smoke；定向回归、typecheck、build | 本地实施验收完成；全仓历史测试尚未完成失败归因，发布门槛保留；不自动迁移未知命令，不修改 README/release notes |

## 恢复合同和评审修复

1. utility 进程退出产生稳定 `AGENT_RUNTIME_INTERRUPTED`，只有该真实错误码保留可恢复的 run_failed；普通模型失败保持终态。模块命令不会在可恢复中断时提前变成失败。
2. Pi 的持久化 listener 完成后按消息对象身份绑定 user、assistant、toolResult；新文件首 user 尚未实际落盘时不发布虚假绑定。恢复的 expected 来自崩溃前生产回调写入的 Journal。
3. `agent.continue()` 不追加 user prompt、不重放已完成工具。恢复入口与实际 continue 前各核验 artifact；异步初始化期间改写文件会在模型调用前拒绝。
4. 原始用户 UUID 必须同时有 user_turn 和已核验 Pi entry binding；恢复该身份用于重建同一套知识工具，不新增用户消息。有效 permissionMode 原样恢复。
5. 调用模型前比较实际 provider/baseUrl/model、真实 cwd/附加目录、权限、工具 schema、项目指令、模块提示和运行配置的摘要。只持久化摘要；动态时间/当前 UI 与用户 prompt 不进入摘要。没有旧摘要的日志拒绝通用续接。
6. 活跃运行的 Skill 注解只进入追加式审计；正常终态后才回写用户消息，避免 transcript 原子重写破坏活动恢复回执。中断期间仍可查看审计。
7. 损坏 sequence 的显式放弃追加绑定完整事件前缀摘要、数量和最后 eventId 的终止回执；原始日志不改写。伪造或陈旧回执不能遮蔽新事件。
8. 恢复不是任意磁盘和所有插件闭包的快照。运行期资源变化可能保守阻断，带专用外部闭包的内部任务不提供通用恢复；已领取后再次中断需核查并放弃旧运行。第三方脚本执行、任意外部副作用补偿不在首版。

## 主要文件

- 插件管理：`packages/shared/src/types/agent-plugin.ts`、`apps/electron/src/main/lib/agent-modules/plugin-{manifest-loader,registry,management-service,management-ipc,host}.ts`。
- 模块策略与派发：`agent-modules/module-{policy-store,skill-resolver,command-store,command-bus,command-dispatcher}.ts`；四层 IPC 同步接入 shared、main、preload、renderer。
- 恢复：`agent-run-journal.ts`、`agent-run-recovery.ts`、`agent-run-recovery-ipc.ts`、`agent-recovery-context.ts`、`adapters/pi-exact-continuation.ts`、`pi-artifact-reconciliation.ts`，以及 orchestrator/service/adapter 的生产接线。
- 审计：`packages/shared/src/types/agent-module-audit.ts`、`agent-modules/module-run-audit.ts`、`AgentModuleRunAuditView.tsx`。
- 界面：`ModuleCatalog.tsx`、`PluginInstallDialog.tsx`、`AgentModuleBar.tsx`、`AgentModuleCommandReceipt.tsx`、`AgentRunRecoveryNotice.tsx`、`WorkspaceToolReceipt.tsx`。
- 验收：`scripts/agent-module-plugin-smoke{,-renderer}.tsx`（主脚本扩展名为 `.ts`）、`scripts/pi-utility-continuation-smoke.ts`、`scripts/pi-continuation-offline-provider.ts` 与各模块 BDD 测试。

以上主进程文件如无额外前缀，均位于 `apps/electron/src/main/lib/`；renderer 组件位于 `apps/electron/src/renderer/components/` 的相应目录。

## 性能与兼容性

- 插件目录只在启动及显式管理动作读取，运行解析使用统一快照；auto 无显式模块时不读取 Skills。运行/数据写入期间拒绝修改插件目录。
- 插件根最多 256 目录项、64 插件；单清单最多 32 模块、1 MiB；每插件最多 32 条提示，单条 16Ki 字符、合计 64Ki 字符；全局最多 256 安装模块、512Ki 提示字符；引用/贡献原始数组最多 256 项。
- 命令快照上限 4 MiB；达到上限明确阻断，尚无归档/压缩，不丢弃幂等历史。回执在当前可见会话每 3 秒单请求刷新，不随 token 触发。
- Journal 在消息/工具/权限/终态边界写入，文件指纹使其他实例可感知更新；恢复按 run 线性分组，但整个 Session Journal 暂无归档，长会话仍有读取与对账成本。
- 导航回执每会话保留最近 1 条、全局最多 64 条；审计最多 20 runs、64 modules/skills、128 tools，按需读取。

## 本轮验收证据

- 本地提交前复验：**265 pass / 0 fail / 913 assertions，39 个文件**；全仓 8 包 typecheck 退出 0；日志 `/private/tmp/dutydeck-module-commit-tests.log` 与 `/private/tmp/dutydeck-module-commit-typecheck.log`。
- 最终改动回归：**254 pass / 0 fail / 866 assertions，38 个文件**，`/private/tmp/dutydeck-module-final-regression.log`。
- 此前完整定向组合：258 pass / 0 fail；最后恢复上下文、知识工具、service 与 orchestrator 追加验证：70 pass / 0 fail。不同组合有重叠，不能相加视为唯一测试总数。
- 全仓 8 包 typecheck 通过，独立恢复评审复验；生产组件 UI smoke 的额外脚本 typecheck 通过。普通 tsconfig 不覆盖 scripts，另用临时配置检查全部四个 smoke/fixture 脚本。
- 完整 Electron build 通过：`CLANG_MODULE_CACHE_PATH=/private/tmp/dutydeck-swift-module-cache bun run electron:build`，日志 `/private/tmp/dutydeck-module-completion-build.log`。存在原生 EventKit availability warning，构建退出 0。
- UI smoke：`cd apps/electron && bun run scripts/agent-module-plugin-smoke.ts`，日志 `/private/tmp/dutydeck-plugin-ui-completion.log`。真实 BrowserWindow、生产 preload、组件、插件管理服务与 Journal/恢复服务；验证安装/刷新/卸载、依赖/warnings、目录重试、会话策略、显式解析、幂等派发、取消、审计、恢复失败重试/二次确认及切会话迟到隔离、健康事件、深色窄窗口 Popover。文件选择器及执行队列为确定性夹具，未调用收费模型。
- utility smoke：`cd apps/electron && bun run scripts/pi-utility-continuation-smoke.ts`，日志 `/private/tmp/pi-final-toctou-smoke.log`。真实 Electron utility、Pi SDK、权限 RPC、一次实际写文件后 SIGKILL，再从生产回调写入的 Journal 经 RecoveryService.list/apply 继续同 run；user=1、toolResult=1、不重复工具/权限。离线 provider，零模型网络请求。该脚本不覆盖完整主应用 orchestrator；其上下文合同由定向生产函数测试和独立评审补充。
- Pi 定向验证 34 pass / 0 fail，含初始化期间 artifact 改写后零 provider 调用；日志 `/private/tmp/pi-final-toctou-tests.log`。
- 规格评审与恢复复审的阻断问题均已修复；`git diff --check` 通过。

## 尚未满足的发布门槛

- 前轮全仓 `bun test` 为 **9741 pass / 455 fail / 62 errors**，尚未逐项完成基线归因，不能宣称全仓通过或所有失败无关。
- `check:fork-compat` 的 3/9 项失败已与 HEAD 逐项对照一致，日志 `/private/tmp/dutydeck-module-fork-baseline.log`；此结论仅覆盖该检查。
- 未验证真实收费模型下五种模块的所有供应商业务路径，未打包发布。第三方执行代码、模块级完整工具隔离、旧未知命令自动迁移均未支持。
- 当前实现按用户授权在 `codex/agent-module-pluginization` 创建本地提交；其他会话改动和既有根目录运行数据保留在工作树。

## 开发启动

按用户要求在完成验证后运行 `CLANG_MODULE_CACHE_PATH=/private/tmp/dutydeck-swift-module-cache bun run dev`，核对 Vite ready、Electron 窗口与启动日志。安装版保留原进程，不替换安装包。启动结果记录于 MEMORY.md 与最终回复。

## 开发启动结果

`CLANG_MODULE_CACHE_PATH=/private/tmp/dutydeck-swift-module-cache bun run dev` 已保持运行：Vite `http://127.0.0.1:5174/` ready，Electron watcher 首次构建完成并加载开发窗口。启动时发现图片策略顶层值导入 ESM-only Pi 包导致 CJS `ERR_PACKAGE_PATH_NOT_EXPORTED`，已改为错误分支 dynamic import 并通过 CJS 编译回归；热重载后无该启动错误。安装版仍保持运行。现有安装版占用 LAN Bridge `29889`，所以开发实例的 LAN Bridge 自动启动失败；这是端口占用提示，不影响窗口和 Vite。既有项目数据中的失效验证附件会输出 ENOENT 诊断，属于历史文件状态，不影响应用启动。
