# 影像任务视觉上下文 Implementation Plan

> **For agentic workers:** Use subagent-driven-development to implement bounded slices and independently review specification then code quality. 用户已授权执行，不重复审批；不提交 Git、不发布、不重启安装版。

**Goal:** 让影像任务按明确对象与版本管理视觉证据，并保留用户输入意图。

**Architecture:** 宿主域服务签发有界上下文并保存观察；Pi adapter 管理本轮临时样本；结构化引用贯穿 UI 与发送链。受限子任务通过现有 AgentRunExtensions 获得最小能力。

**Tech Stack:** Bun、TypeScript、Pi、Electron、React/Jotai、现有 sharp/媒体检查服务。

## 任务 1：引用与发送链

文件：shared/types/visual-production-reference.ts、agent.ts、renderer visual-production/AgentView/引用 chips、agent-service、agent-message-ipc、preload。执行者不得修改 agent-orchestrator，由主代理集成。

- [x] 先写行为测试：已有草稿引用镜头后正文不变；排队/退回/重试保留引用；删除或过期目标拒绝。
- [x] 定义并贯通 `visualProductionReferences: VisualProductionReference[]`，SDK 消息字段 `_visualProductionReferences`；作品版本严格匹配。
- [x] 宿主校验函数返回可信可读上下文；只带引用即可发送，但不预设生成意图。
- [x] `bun test` 相关文件；真实 UI smoke 保留草稿、移除引用及历史展示。

## 任务 2：Pi 临时图片生命周期

文件：main/lib/adapters/pi-visual-task-context.ts 及测试、pi-agent-adapter.ts、main/lib/visual-production/context-contract.ts。协议以设计文档为准。

- [x] 写红灯测试：工具结果无持久图片，两个成功推理回合继续携带，失败/agent_end 后重试保留，close/open 替换释放，同批观察拒绝。
- [x] 安装 lifecycle 并传可序列化 policy；仅真实 streamFunction 成功消费后授权 evidenceIds；恢复必须重新 inspect。
- [x] 未知图片/普通工具不变；旧图仅精确 hash 与完整配对时投影；预算策略继续包裹最终请求。
- [x] 用实际 Pi Agent 和离线 stream 验证跨轮、错误、取消与预算失败。

## 任务 3：域上下文和证据

文件：main/lib/visual-production/task-context*.ts、context-evidence-store.ts、integration.ts、agent-tools.ts；必要窄视频宿主接口主代理集成 ipc.ts。

- [x] 先写范围/版本/取消/恢复/hash 测试，运行并记录红灯。
- [x] 实现 open/inspect/record/close 与持久结论；正式目标+绑定资产+显式连续性+候选选择，不自动加载全作品图片。
- [x] 证据 JSON 使用 safe-file 原子写；最大范围、样本、结论有界；生成原始参考路径不变。
- [x] 返回跨进程事件，导出精确工具名和只读白名单；视频复用既有服务。
- [x] 相关 store/access/agent-tools/media 既有测试保持通过。

## 任务 4：主编排与受限子任务

文件：agent-orchestrator.ts、agent-run-extensions.ts、visual-production/context-delegation.ts 及测试。

- [x] 串联引用初始范围、生命周期 policy、工具权限与提示；保留其他模块增量。
- [x] 固定任务范围的子 Agent 仅获得指定工具，禁用 Skills、验证真实 terminal 状态，撤销后拒绝迟到结果。
- [x] 先失败再实现测试：越权/换范围/失败终态/主任务结束不能提交观察。

## 任务 5：整体验证与记录

- [x] 独立规格审查，修复后独立代码审查。
- [x] `bun test` 相关测试、`bun run typecheck`、`git diff --check`。
- [x] `CLANG_MODULE_CACHE_PATH=/private/tmp/dutydeck-image-build-module-cache SWIFT_MODULECACHE_PATH=/private/tmp/dutydeck-image-build-module-cache bun run electron:build`。
- [x] UI smoke 与真实 Pi 离线请求，零收费生成；记录验证空缺。
- [x] 更新本计划和 MEMORY；准确说明仓库构建与安装版的生效边界。


## 完成记录（2026-10-18）

已完成实施与两阶段独立审查；审查发现的权限延续、回执过滤、父范围撤销、样本预算及队列取消问题均已修复。未提交 Git、发布或更新安装版。

- 域服务、实际 Pi 离线生命周期、通用图片策略集成：190 项通过 / 1256 次断言（24 文件）；最后追加引用取消测试后，该切片另以定向测试验证。
- 引用/队列/服务/Chat 相关组合：64 项通过 / 252 次断言；最后取消链路定向组合：40 项通过 / 161 次断言（5 文件）。这些组合有交集，不合计为唯一测试数。
- UI/引用链路执行者验证：72 项通过 / 207 次断言。真实 Electron 隔离 smoke 执行 `VISUAL_SMOKE_REFERENCE_ONLY=1 bun scripts/visual-production-ui-smoke.ts`，检查工作台引用保留已有草稿、稳定去重、无自动发送、无隐式待执行提示；移除/重试/历史恢复由组件与发送链测试覆盖。
- 分叉边界：5 项通过 / 21 次断言；新增受限子会话不能通过分叉获得普通工具。
- 最终全仓 8 包 typecheck 退出 0；完整 `electron:build` 退出 0；`git diff --check` 通过。构建仅有已有 EventKit availability 与包体积警告。
- 扩展会话回归仍有 4 项既有失败：2 项项目记忆恢复断言、2 项旧 proma CLI 文案断言；用 HEAD 版会话管理器/测试副本复现相同失败。副本基线另有 2 项由独立模块身份导致的删除边界失败，不能当作新增产品回归。此次异步签名导致的一项 service 源码匹配断言已修复并通过。

日志位于 `/private/tmp/dutydeck-visual-context-{integrated-tests-final,queue-tests-final,cancel-tests-final,typecheck-final,build-final}.log`。未发起真实模型请求、收费生成或真实媒体验收；安装版 `/Applications/开发工具/DutyDeck.app` 尚未替换，仓库构建通过不代表已在该安装版生效。

## 最终边界

- 48 MiB 是本轮原始 Base64 临时预算；最终预览仍遵守 12 MiB 图片 / 16 MiB 请求预算。32 MiB 原图读取与转换仍有有界临时峰值，未引入流式媒体改造。
- 观察按范围/运行分片；读子任务回执先限定运行再裁剪，不用其他子任务的最近记录替代。
- 子任务受限身份持久化，普通续聊/分叉拒绝扩权；只有实际成功终态且已记录观察才返回成功。
- 取消准备立即释放队列身份，并向引用读取传播信号；已开始的同步文件读取不可抢占，但迟到结果不能启动运行或影响新准备。
- 未发送队列保持现有内存语义，不承诺跨应用退出恢复。视频仅抽样检查，技术检查不等同于视觉或听觉验收。
- Nowledge 定向搜索因本机 `127.0.0.1:14242` 连接拒绝未同步；本地 MEMORY 已记录授权实施后的决策与验证边界。
