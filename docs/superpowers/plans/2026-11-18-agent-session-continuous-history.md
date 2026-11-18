# Pi 会话连续阅读与性能优化计划

**目标：** 打开会话仍停在最新消息。回看历史只需向上滚，向下滚可回到实时输出；读普通历史或分段内容均不需要翻页按钮或分页弹窗。

**架构：** 用户看到一条连续时间线，底层仍使用有预算的 JSONL 分页。沿用会话 ID、generation、物理偏移、稳定记录 ID、现有 Jotai 缓存和 Pi 权限边界。前三项合成首批交付；Skill 持久化和首字性能独立交付，不阻塞阅读体验。

**技术栈：** Electron 主进程、React、Jotai、Bun；不新增数据库或前端依赖。以下基线和任务描述保留实施前的判断；实际交付以验收记录为准。

## 本轮验收记录（2026-11-18，工作树，未发布）

- 普通历史连续双向滚动、读取错误原位重试、用户触底后恢复实时跟随、长记录原位双向阅读已实现。沿用既有 IPC 与权威 JSONL；超长行按批续扫，放弃请求后不启动下一批。原位详情仅缓存主进程源记录，每段仍执行当前权限/路径投影，不复用旧授权结果。
- 同设备 5 万条、20 个新文件，约 49.85 MB/文件，OS 缓存未清除。冷尾页、第一次上翻、第二次上翻、回翻的主进程 P50/P95（ms）分别为 **6.8/117.3、9.7/51.4、2.9/9.0、2.8/12.0**；对应增量索引字节为 **262144、999424、0、0**，正文读取字节为 **119232、118606、118606、118606**。达到首次上翻主进程 P50 ≤50 ms 目标；不代表屏幕或模型延迟。
- 生产导航与滚动容器在隔离 Electron 窗口、合成 720 条消息上，上下各跨 560 条；原位重试、在途选区和恢复实时后追加均通过。14 个相邻页锚点最大漂移 0 CSS px；上方图片解码后增高 240 px，原消息位置同样漂移 0 px。95 项历史专项回归、全仓类型检查通过。未使用用户会话或付费模型；物理触控板与真实业务消息端到端可见耗时不作结论。
- 首轮资源重复扫描已移除，增加默认关闭的首文本分段观测。重复且文件未变的 Skill 通知（5 万条样本）P50 为 **0.20 ms**；首次新增激活仍须原子重写全文件（P50 **1018 ms**），增量事实与导出、fork、rewind 的一致性另行交付。本轮不更换 Skill 持久化格式。

## 基线与现状

- 本机 1 万 / 5 万条合成消息，首次上翻 P50 为 71.6 / 362.7 ms，再次上翻为 2.2 / 2.8 ms。5 万条时首次上翻返回 120 条却扫描约 50 MB。单条 Skill 补记同步耗时分别为 193.4 / 2037.1 ms。每档 5 次，不含 IPC、布局、模型请求。
- 工作树已有顶部 120 px 触发、选择文本保护、首可见消息定位，不能另加第二套监听器。`AgentMessages.tsx` 的 `TranscriptNavigation` 仍提供较早/较新/建索引按钮，错误重试走 `tail`；`TranscriptDetails`、`RetainedTranscriptRecords` 仍在对话框内按条或段翻页。
- `agent-transcript-page.ts` 目前只给 `tail/after` 请求局部索引；`before` 会把局部索引提升成完整索引。`agent-transcript-sync.ts` 已对阅读窗口做 500 条、约 4 MiB 的预算。`agent-transcript-query.ts` 对一条详情的每个 16k 字符段可能重读并投影整条记录，不能直接在滚动事件上无限调用。

## 首批交付：连续时间线

### 1. 让普通前页只读取相邻数据

- [ ] 在 `apps/electron/src/main/lib/agent-transcript-page.test.ts` 和 `agent-transcript-index.test.ts` 增加 1 万 / 5 万条样本的 `tail → before → before → after` 回归。断言连续边界、无重复漏项、跨页工具回合身份不变，且普通上翻不再以文件总长作为扫描量。将该序列和每步 `indexBytes/ioBytes` 加入 `apps/electron/scripts/agent-history-benchmark.ts`。
- [ ] 修改同目录的 `agent-transcript-page.ts`、`agent-transcript-index.ts` 和 `agent-jsonl-tail-reader.ts`：游标在已有记录内先用缓存；缺前缀时从覆盖起点反向分块解析完整行。固定每批扫描预算，保留半行状态、物理偏移与同代身份；局部窗口扩展时保证相同记录的回合关系一致。搜索/按 ID 定位继续可用完整索引，不把全量构建放到普通滚动路径。
- [ ] 巨型单行跨过扫描上限时，自动分批推进并让出主进程，不要求点“构建索引”；必须能取消，且每批要么推进物理偏移，要么返回明确终态。遇到外部替换/截短更换 generation，禁止接入旧页。若需新增进度/续扫字段，同步修改 `packages/shared/src/types/agent.ts`、主进程 IPC、preload 和 renderer；不放宽原有读写保护。

### 2. 上下自然滚动，保住用户正在看的位置

- [ ] 在 `apps/electron/src/renderer/components/agent/AgentMessages.tsx` 的现有滚动逻辑上修改，配合 `AgentView.tsx` 的 `navigateHistory` 和 `renderer/lib/agent-transcript-sync.ts`。上靠近窗口头部补旧数据；阅读历史时，下靠近尾部补较新数据；用户下滚到真实尾部才恢复实时跟随。“回到最新”是可选捷径，不是继续阅读的条件。
- [ ] 替换“较早/较新/构建索引”控件，只在边缘显示加载状态、起点或局部错误。失败保留原文及位置，允许原方向原游标重试，不跳尾页。首屏先定位尾部；不足一屏才有限补齐。相同 `(sessionId, generation, direction, cursor)` 同时最多一个请求；切换会话后丢弃迟到回包，同游标无进展或读取失败时停止自动重试。
- [ ] 合并前记录第一条可见消息的稳定 ID 和相对视口的纵向偏移，在布局提交后校正；图片/代码块后续改变高度时仅补偿锚点上方变化。异步读取期间用户若继续滚，以当下视口为准；不把旧位置强加给用户。选区或键盘焦点所处内容不被裁掉。阅读旧消息时新输出只进实时缓冲，不抢位置；普通页面继续遵守 500 条 / 4 MiB 预算。
- [ ] 扩展已存在的 `AgentMessages.auto-load.test.ts`、`agent-transcript-sync.test.ts`，增加真实 Electron 窗口滚动冒烟。覆盖滚轮、触控板连续输入、Page Up/Down、短会话、异步图片、选区、读取中切换会话、边读边生成、失败重试。必须用滚动读完跨窗口样本并滚回最新，不能用测试代码直接调用翻页函数代替界面操作。

### 3. 把历史详情从分页弹窗移回消息流

- [ ] 仅修改会话阅读相关的 `TranscriptDetails` / `RetainedTranscriptRecords`，不波及附件预览等其他弹窗。普通消息直接阅读；确实很大的工具输出可保留一次原位展开，展开后滚到片段边缘自动续读。未确认的实时缓冲不当作已落盘消息；缺少工具结果不推断为工具成功或失败。
- [ ] 修改 `apps/electron/src/main/lib/agent-transcript-query.ts` 的详情读取和对应测试：同一条记录连续读段不能每 16k 字符就重读整条。按 session/generation/recordId 复用有严格字节上限、生命周期有限的展示投影，或使用等价的有界游标读取；切换/换代后失效。超出支持的单条详情上限继续说明限制并保留导出，不静默截断，也不一次把所有段装入 DOM。
- [ ] 验证历史正文、工具结果、保留记录可读；滚动全过程无分页对话框、无“上一条/下一条/上一段/下一段”必点操作，返回消息流不丢位置。

**首批验收门槛（目标，非已达到）：** 固定同一设备、相同 fixture，冷局部索引至少 20 个新临时文件，分别报告 P50/P95、索引/正文读取量和 Electron 滚动到内容可见时间。5 万条普通样本首次上翻主进程 P50 目标 ≤ 50 ms；普通相邻页增量索引读取 ≤ 1 MiB/批，不能通过预先全扫或后台无界预取达标。固定行高电子窗口中无主动滚动时锚点漂移 ≤ 2 CSS px；动态内容单独测布局稳定后的锚点。超过 500 条后上下往返，消息 UUID 无丢失/重复；新输出、快速滚动、异常和超长行分别测试。

## 后续独立交付

**4. 消除回合结束的 Skill 全量重写。** `agent-orchestrator.ts` 终态通知前调用 `agent-session-manager.ts` 的 `updateSDKUserMessageSkillActivations`。先用 BDD 固定多次激活合并、排队消息 UUID、崩溃恢复、旧格式读取及证据回执，再改为原消息未提交时合并写、已提交时按 UUID 增量记录。后者是业务事实而非可随意删除的缓存；持久化必须与正文有明确的持久顺序和失败恢复。统一读取历史、导出、fork、rewind、删除时的合并/裁剪语义。验收：5 万条历史补记一次，不读取或重写整份 transcript，重启前后结果一致；用相同样本对照原 2037.1 ms 基线。

**5. 单独测首字与流式显示。** 在发送、调用模型、收到首个文本增量、首字可见分别采单调时钟耗时；区分新/旧会话、显式 Skill、真正续接和中途排队；主进程与 renderer 不直接相减未对齐的时钟。验证 `adapters/pi-agent-adapter.ts` 普通首轮中的两次资源刷新：同一运行内复用有效快照；权限或资源已变及后续输入继续重新验证。不要全局复用带权限的 AgentSession。渲染侧先看已有 `agent.history.merge` 与帧耗时，仅在确认掉帧后考虑按 UUID 增量合并或分段挂载。

## 执行验证

```sh
bun test apps/electron/src/main/lib/agent-transcript-page.test.ts apps/electron/src/main/lib/agent-transcript-index.test.ts apps/electron/src/main/lib/agent-transcript-query.test.ts
bun test apps/electron/src/renderer/components/agent/AgentMessages.auto-load.test.ts apps/electron/src/renderer/lib/agent-transcript-sync.test.ts apps/electron/src/renderer/lib/agent-transcript-detail.test.ts
bun apps/electron/scripts/agent-history-benchmark.ts --synthetic --messages 50000 --runs 20
bun run typecheck
```

性能验证只用临时合成数据。上述基准脚本已包括双向冷序列；在 `apps/electron` 目录运行 `bun run scripts/agent-continuous-history-smoke.ts` 可独立复核真实滚轮与锚点。函数计时不能代替 Electron 交互验收。
