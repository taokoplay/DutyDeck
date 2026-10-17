# 影像创作 Agent 单镜头制作闭环

**Goal:** 主 Agent 沿用已确认资产制作指定镜头，真实媒体输出先进入候选，用户采用后更新播放器。用户已确认下一步方向，按本计划直接实施和验证。

**Architecture:** 复用现有媒体生成工具与权限；影像域补充单镜头读取、参考素材转换、输出候选与任务阶段。存储仍为原子 JSON，正式版本采用 CAS，Agent 无正式保存/采用权限。生成执行仍走媒体授权策略，影像工具不隐式发送供应商请求。

**Tech Stack:** Bun、TypeScript、现有 Pi 工具、媒体服务、React/Jotai；无新增依赖。

## 范围与用户影响

- `read_shot` 返回作品设定、当前镜头和引用资产；引用与长文本分别续读，单次响应不超过 48 KiB 字符预算。先完成当前引用页的文本，再续读下一引用页，同一轮读取须保持 revision 一致，避免遗漏约束或重复传入整片。
- `reference_media` 仅转换当前运行任务可引用的正式媒体，返回媒体服务的完整 MediaAssetRef；不返回路径或字节。单镜头任务仅允许目标输出及其引用资产，跨作品/旧版本/取消任务拒绝。
- `propose_shot` 接收 jobId、shotId、mediaId 与说明，宿主从当前固定版本构造完整候选，只更换该镜头 mediaId，不改资产、设定、排序和其他镜头。
- `update_job` 更新 preparing/generating/reviewing 阶段，不伪造百分比或供应商进度。失败/取消后重试从主对话创建新任务，不复活旧任务。
- 引用图按需逐份转换并使用确定性登记身份；媒体字节不上下文、不后台轮询，不扩展画布或交互设计职责。
- 当前统一 HTTP 适配器只支持单张参考图。多参考输入应明确拒绝，禁止悄悄只用第一张；多资产一致性先制作并确认一张综合参考图，或使用明确支持多参考的现有工作流。

## 实施与验证

- [x] 共享合同/存储/宿主：新增 referenceMedia、proposeShot、updateJob 的严格输入与返回类型；写失败测试覆盖任务归属、版本、参考范围、取消、候选隔离；实现后运行 `bun test apps/electron/src/main/lib/visual-production packages/shared/src/types/visual-production.test.ts`。
- [x] Agent：新增 read_shot/reference_media/propose_shot/update_job；本轮 ownedJobs 保护扩展到新任务方法；更新制作提示顺序与单参考约束。用真实临时作品驱动工具测试，验证仅第三镜头可替换。
- [x] 媒体边界：验证普通 Agent 的现有媒体工具可达性，参考转换接入 MediaAssetService；适配器拒绝多参考和非图片参考并保留原有文生图入口。
- [x] UI：阶段与失败原因可见；失败/取消任务引用到主会话重试，绑定最新作品和目标镜头，移除的目标不再提供重试。候选显示实际变化并支持新旧画面对比。
- [x] 集成：隔离媒体生成 fixture 覆盖参考字节进入实际 HTTP 适配器、结果导入、候选、采纳和其他镜头不变；失败/取消/旧版本不得覆盖正式结果。真实模型可用性与真实调用验收单独记录，fixture 通过不宣称供应商验证通过。
- [x] 全仓 `bun run typecheck`、真实 Electron 影像 UI smoke、`git diff --check`；按实际结果补充记录。保留工作区已有交互设计改动。

## 停止条件

以上代码链路与边界回归通过。没有可用模型/授权的真实供应商验证须明确记录限制，不能用 fixture 或静帧预演冒充真实生成。成片合成、混音和完整时间线仍为后续独立范围。

## 实际验收（2026-10-17）

- 相关 Bun 测试：95 项通过、940 断言，包含真实存储、受管媒体、Agent 工具、统一生成服务及 HTTP 适配器的组合测试。HTTP 层使用隔离 fixture，已验证参考图实际字节进入 multipart，生成产物导入、候选、采用及其他镜头/资产不变。
- 边界覆盖：跨会话/旧版本/取消任务拒绝，迟到产物不能提交候选，多参考与非图片明确拒绝；200 个长资产身份、完整长文本及 JSON 转义膨胀可沿游标完整还原，响应保持有界。
- 全仓 `bun run typecheck` 和 `git diff --check` 通过。修正本轮两处测试类型声明，不修改其他会话的交互设计代码。
- 真实 Electron smoke 最终通过：任务阶段、候选视频播放、新旧对比、采用仅更新指定镜头、失败引用到 Agent 且不自动发送、连续播放、草稿保留、窄窗和深浅主题、切换作品迟到响应隔离。
- smoke 等待已补主进程截止时间、步骤诊断、动画状态及可见帧/点击命中检查；此前捕获到 rAF 等待超时与重载后点击未生效，最终版本已通过，未以无界重试掩盖失败。
- 测试日志：`/private/tmp/visual-loop-final-tests.log`、`/private/tmp/visual-loop-final-typecheck.log`、`/private/tmp/visual-loop-ui-smoke.log`；候选对比截图：`/private/tmp/dutydeck-visual-production-candidate-compare.png`。
- 未调用真实收费生成模型；供应商可用性、真实画质与角色一致性尚未验收。成片合成、混音与完整时间线不属于本轮。没有新依赖、真实业务数据修改、打包发布或 Git 提交。
