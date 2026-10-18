# 通用图片请求优化实施计划

> 使用 writing-plans、test-driven-development、subagent-driven-development 和 verification-before-completion。用户已确认保守首版，连续完成本地实现与验证，不提交 Git、不发布。

**目标：** Agent 与普通 Chat 共用图片预览与请求字节预算，解决历史图片累计造成的 413，同时保留全部不同图片、原始素材、会话与工具配对。

**架构：** 在请求投影阶段生成预览，使用已有 sharp；按图片原始内容 SHA-256 去重并留下清楚的图片编号引用。没有可信任务结束证据时不自动删除不同图片。缓存属于单次运行，受条目/字节预算约束。图片 Base64 合计预算 12 MiB，完整逻辑 payload 预算 16 MiB，均是客户端保护值，不声称是渠道上限。Chat 检查实际序列化正文；Pi 检查 provider 逻辑 payload，Google SDK/部分 WebSocket 可能另加协议封装。超预算直接给出可操作错误，不重放工具。

**技术栈：** Bun、TypeScript、sharp、Pi 0.99.1、现有 core Provider adapters。

## 范围与兼容边界

- 小图优先原样传递并完整解码校验；大图优先尝试 PNG 无损编码，仍较大时不透明图使用 JPEG 85。最长边 2000，不比现有 Pi 默认尺寸策略更激进；透明图使用 PNG/原图保留 alpha。只处理模型识图副本，不改生成参考素材。
- 第一版不做自动任务完成识别、不按最近 N 张淘汰图片、不新增图片检索模型调用。旧会话读取时同样生成预览；原始 artifact 不重写。
- 请求中每张唯一图片保留身份文字，重复图片以同一编号指回首次图片，不能无声删除引用。
- Pi transformContext 保留既有图片有效性校验、Canvas 样本生命周期与附件路径投影。预算必须放到实际 streamFunction / onPayload 链，不能依赖会吞异常的 extension。
- Chat 保持 core 同步图片读取接口，在宿主异步预处理后提供内存 reader；原始附件仍用于生成工具。
- 单次转换限制源字节和像素数；转换顺序执行，缓存有界，取消后不发请求。日志不输出图片正文。

## 任务 1：公共预览与预算

文件：新增 `apps/electron/src/main/lib/image-request-preparation.ts` 与 `.test.ts`。

公共合同：

```ts
interface RequestImageInput { data: string; mimeType: string }
interface RequestImagePreview extends RequestImageInput {
  imageId: string
  originalWidth: number
  originalHeight: number
  width: number
  height: number
}
interface ImagePreviewPreparer {
  prepare(input: RequestImageInput, signal?: AbortSignal): Promise<RequestImagePreview>
}
// 构造每次运行独立的有界缓存。
createImagePreviewPreparer(): ImagePreviewPreparer
// 按实际准备发送的 Base64 块计量，重复块由调用方保留文字引用后去除。
assertImageRequestBudget(images: readonly RequestImageInput[]): void
// string 视为已序列化请求，其余值用 JSON.stringify；按 UTF-8 字节计量。
assertModelRequestBudget(payload: unknown): void
```

- [x] 编写 BDD 测试：小图原样、透明通道保留、PNG 摄影图显著减小、长边不超过 2000、相同输入缓存命中、损坏与超像素图拒绝、取消、Base64 合计和 UTF-8 请求预算。
- [x] 运行 `bun test apps/electron/src/main/lib/image-request-preparation.test.ts`，记录失败后实现。
- [x] 实现上述接口，常量采用 12 MiB 图片、16 MiB 请求、32 MiB 缓存和 64 条缓存；错误含 `IMAGE_REQUEST_BUDGET_EXCEEDED` / `MODEL_REQUEST_BUDGET_EXCEEDED` 及中文建议。避免 `REQUEST_TOO_LARGE` 被 Pi 误判为 token overflow。
- [x] 重跑专项，验证不修改原始 Buffer/Base64。

## 任务 2：Agent 接入

文件：新增 `apps/electron/src/main/lib/adapters/pi-image-request-policy.ts` 与 `.test.ts`；最小修改 `pi-agent-adapter.ts`。

- [x] 先测试真实 Agent 请求投影：用户图和工具图均处理、不同图全保留、重复图有引用、toolCallId/原消息不变、前置 transform 被调用、续接和错误保留。
- [x] 实现 `installPiImageRequestPolicy(agent)`：所有原钩子安装完后包裹 streamFunction，在最终 transcript 上投影，并包裹每次 stream 的 onPayload 链；保留原 transformContext 与回调返回的新 payload，最终超限时拒绝发送。纯文本模型保留原有视觉中继/provider 处理方式，只检查最终 payload 预算。
- [x] 使用真实 Pi/faux provider 验证 provider 边界，而非仅检查 helper 被调用。
- [x] 覆盖 compaction 使用同一 streamFunction 的路径、取消与既有 reasoning/service tier 回调不丢失。

## 任务 3：Chat 接入

文件：新增 `apps/electron/src/main/lib/chat-image-request-preparation.ts` 与 `.test.ts`；修改 `chat-service.ts`。

- [x] 先测试全历史和当前附件图片均可见，去重有稳定文字引用，不改原始附件/历史，缺失图片明确失败。
- [x] 异步生成预览与投影后为 core 提供同步 reader。接入正常工具循环与最终回答轮。
- [x] 每轮重建的请求均执行完整 UTF-8 字节预算。保留生成工具使用的原始 attachments。
- [x] 用真实 OpenAI、Anthropic、Google 和 Responses adapter 构建请求验证 MIME/图片数量和限制；不发外部请求。

## 任务 4：错误提示

文件：`agent-error-utils.ts` / `.test.ts`。

- [x] 加入实际截图错误 `413 Failed to buffer the request body: length limit exceeded`，先证明当前测试失败。
- [x] 裸 413/本地预算统一展示请求过大，不提供原样重试。普通带数字文本不能误判。
- [x] 维持网络中断原生重试；专项与现有 retry 测试一起运行。

## 任务 5：综合验证与复核

- [x] 运行新增专项和 Agent 图片/工具结果、附件投影、Canvas 样本、错误重试、Provider 适配器相关回归。
- [x] `bun run typecheck`。
- [x] `bun run electron:build`，验证 sharp 与 utility runtime 构建路径；不重启真实客户端。
- [x] 只读加载本次 19 图的真实会话，运行生产预览/投影并计算完整请求体积；验证处理前后 transcript 文件摘要相同。
- [x] 独立规格复核后做代码质量复核，修复发现的问题；仅检查本次 diff，不处理其他任务修改。
- [x] MEMORY.md 写入实际结果与局限，最终明确首版仍保留所有唯一图片，任务级自动退出未启用。


## 验证结果（2026-10-18）

- 新增专项与既有图片/Canvas/附件/工具结果/retry/四类 provider 回归：`bun test --isolate ...`，18 个文件、158 项测试、395 个断言通过；错误文案统一 12 MiB 后，错误分类 6 项再次通过。
- `bun run typecheck` 全仓通过；独立规格与最终增量质量复核未发现未解决问题。
- `bun run electron:build` 通过。首次原生 Swift 阶段因默认 ModuleCache 目录不可写失败；将 `CLANG_MODULE_CACHE_PATH` 与 `SWIFT_MODULECACHE_PATH` 指向 `/private/tmp/dutydeck-image-build-module-cache` 后完整重跑成功，未更改构建源码。日志：`/private/tmp/dutydeck-image-build-20261018.log`。既有 import.meta、前端大分块及 EventKit availability 警告仍存在。
- 真实故障会话的 19 张图：Base64 从 49,976,428 bytes 降为 9,800,988 bytes，减少约 80.4%；公共准备器首次约 1.75 秒、缓存轮约 116 毫秒。一张真正透明图保真后仍占约 3.49 MB，因此将原拟定的 8 MiB 图片预算校准为 12 MiB。
- 对报错前 366 条真实历史使用生产图片投影及 Anthropic SDK 离线编码，19 张唯一图片全部保留，最终逻辑 payload 和 HTTP 正文均为 11,079,317 bytes；整轮约 1.74 秒。fetch 被本地替身截断，外部请求为 0，处理前后源 JSONL 的 SHA-256 相同。此验证不重建现场系统提示与工具 schema，不冒充现场完整抓包结果。
- 生产模型构造器配合内存 SDK 验证：`deepseek` 的精确 `deepseek-flash` 能力条目包含图片输入，实际构造协议为 `anthropic-messages`，因此本次故障模型会进入图片优化。纯文本模型保持旧路径；部分协议仍可能序列化其工具图片，此时仅承诺最终 16 MiB payload 拦截，不声称全部协议都会过滤或预处理图片。
- 预算错误采用 `BUDGET_EXCEEDED`，真实 Pi 测试验证不触发 token overflow 自动压缩。裸 413 仍明确提示请求内容过大，不做原样重试。
- 首版只对既有请求中的识图副本预处理；原始素材、工具参数与持久化记录不改写。所有不同图片保留，任务级自动退出未启用。大图预览可能降低细节，透明通道保留；渠道实际请求上限仍需以渠道配置为准。
- 已更新 MEMORY.md；本机 Nowledge Mem 定向检索连接拒绝，未同步。未提交 Git、发布或重启正在运行的客户端；需加载新构建才会生效。
