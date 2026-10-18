# 影像任务视觉上下文

用户已批准实施。目标是让图片服务于明确的制作/检查任务，避免历史图片长期累积，同时保留比较、失败重试和重新检查能力。

## 合同

- 主 Agent 保持编排。视觉上下文绑定本轮 runId、session、workspace、productionRevision、目标对象、明确用途及媒体 hash；上下文不是生成 job，不会自动生成或支付。
- `visual_production_open_context` 解析正式目标与绑定资产；显式 continuityShotIds 才扩展连续性范围；候选用 candidateId 绑定版本。生成后先导入/提交候选，再检查候选范围。新上下文替换旧范围，但不删除持久素材/结论。
- `visual_production_inspect_media` 只读取范围内不可变媒体。识图样本与原始生成参考分别管理；视频复用现有技术检查/抽帧服务，抽样结论不能冒充全片检查。
- `visual_production_record_observation` 保存宿主素材身份和版本、模型检查目标/结论/未检查项；视觉证据必须在实际携带样本的成功模型响应后调用，不接受同批盲评。仅技术检查必须显式标记 technical，并证明对应技术正文经过成功请求，不能把缺图降级为已看图。重新打开范围后可读取已有结论，并核验源版本。
- `visual_production_close_context` 显式退出阶段；运行结束仅撤销本轮 grant/释放内存，恢复时重新校验和取图，不重放生成。
- Pi 工具结果持久化前剥离专用样本，模型请求副本按当前范围注入；失败与原生重试保留。不能在 transformContext 提前宣告模型看过图片，不能在底层 agent_end 提前清理。
- 旧普通 read 仅在当前分支工具配对且字节 hash 精确匹配宿主授权媒体时可投影为引用；其他附件与未知归属图片保持现状。
- 独立子任务冻结范围，仅开放 inspect_media 与 record_observation，禁用普通工具和 Skills。受限身份随会话持久化，普通续聊与分叉不能扩权。换范围新建干净子会话；主运行结束或父范围撤销后同步拒绝迟到写入，结果必须核对真实成功终态与本子任务的观察记录；无终态回调按失败处理。
- 对象引用使用独立结构化字段和可读 chip，覆盖发送、排队、退回草稿、重试、历史展示；不覆盖输入、不自动要求生成。宿主在接管前校验目标存在、项目归属与版本，过期不静默升级。
- 队列准备使用每项独立取消信号；取消/清空立即释放准备槽位，旧回调按任务身份忽略。底层同步读取不能抢占中断，但不会继续读取后续作品或启动迟到运行；未发送队列沿用现有内存队列，不新增退出应用后的持久化承诺。

## 内部跨进程协议

`VisualTaskContextPolicy = { runId: string; initialContextId?: string; legacyMedia?: { mediaId: string; hash: string }[] }`。

工具 `details.visualTaskContext` 使用 `version: 1, runId, contextId, action`；action 为 open/inspect/close/observation。inspect 同时包含 evidenceId、mediaId、mediaHash、inspectionKind（visual 或 technical）；record_observation 参数使用 contextId、evidenceIds、objective、conclusion、unchecked。专用工具的精确名字与本轮 runId 同时校验。

观察按 `.proma/visual-production/projects/<productionId>/visual-observations/<scopeKey>/<runId>.json` 分片，通过 safe-file 原子写；每运行最多 100 条/2 MiB，范围索引最多 10,000 个运行。默认只读最近四个非空分片并返回最近四条；读取子任务回执先按 runId 过滤再限制条数，避免其他并发子任务覆盖可见证据。旧分片保留，不因一个运行写满而阻断后续运行。

## 影响与成本

只在影像范围显式启用。普通 Chat、Canvas、附件、Automation 和通用委派权限不改变。临时原始样本采用 48 MiB Base64 字符预算及最多 64 次检查，以容纳域内最大 32 MiB 原图；最终识图预览仍受 12 MiB 图片合计/16 MiB 请求预算约束。此为客户端策略，不代表渠道网关硬上限。原始样本与解码/预览转换存在有界内存峰值；图片不写回会话历史，每次请求的预览转换复用既有缓存。结论、范围、连续性数量和样本数量分别有界，无新增依赖或轮询。沿用本地 JSON 安全原子写和现有媒体副本。

## 验收

范围/版本/跨项目拒绝；重试保图；关闭/替换释放；同批盲评拒绝；新 run 不继承旧授权；原图不改写；引用保留草稿且全链路可恢复；子任务不能越权或把失败摘要当成功。离线模型测试、定向 BDD、全仓 typecheck、Electron build 和真实 UI smoke。
