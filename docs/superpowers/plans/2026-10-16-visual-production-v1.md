# 影像创作第一版实施计划

> **For agentic workers:** 使用测试驱动开发；各负责区域独立实施，主线程集成、验收并修复。用户已确认 HTML 交互并要求实现第一版，无需再次等待实施确认。

**Goal:** 在 DutyDeck 右侧新增影像创作工作区，提供真实项目/集数/资产/镜头管理、预演、候选采纳与主 Agent 协作。

**Architecture:** 影像业务独立于原画布与交互设计。Agent 项目下保存多个影像项目，正式 JSON 数据由主进程固定会话归属、原子写入和 revision CAS 管理；图片/视频/声音从已授权项目文件或现有媒体库导入独立内容对象。Renderer 复用主题、Radix 弹窗与 Jotai 视图状态；Agent 只能提出候选，采纳由用户动作触发。

**Tech Stack:** Bun、TypeScript、React、Jotai、Radix、既有媒体服务、安全文件工具；不新增依赖。

## 验收范围

- 项目侧栏可搜索/切换影像项目，创作设定摘要和固定保存底栏弹窗。
- 集数隔离、资产搜索/类型筛选/锁定/实际引用位置、镜头设置弹窗与引用给主 Agent。
- 视频项目横向分镜与统一播放器，静态图按时长预演，已导入视频实际播放；切页/隐藏/编辑暂停。图片项目使用图片浏览。
- 同一份资产/镜头数据提供关系视图；剪辑视图调整镜头次序，交付导出真实制作清单与已采用素材，不宣称已自动合成成片。
- Agent 可创建项目、读取、导入结果、开始任务、提交计划或镜头候选、失败/取消；权限与运行取消必须重新校验。
- 人工改动使旧候选失效；资产修改提示关联镜头待更新；候选采纳前不覆盖正式媒体。
- 持久化、损坏文件/链接/越界拒绝、写冲突、计划模式禁止写、任务归属、迟到回流和旧上下文隔离均有可执行验证。

## 实施任务与所有权

- [x] 共享合同与解析：`packages/shared/src/types/visual-production*.ts`，关联请求/响应、完整草稿、媒体元数据、候选/任务和读取预算。先写 BDD 校验测试，再实现白名单解析和依赖关系校验。
- [x] 存储和 Agent：`apps/electron/src/main/lib/visual-production/*`，snapshot 原子提交、内容寻址媒体、CAS、任务/候选、会话访问门禁、工具白名单及运行收尾。真实独立临时项目测试正常保存和越界/冲突/取消。
- [x] Renderer：`components/visual-production/*`、`atoms/visual-production-atoms.ts`，按确认原型实现各视图，冻结表单身份/基线，保留输入，按需读取当前媒体并释放 Object URL，隐藏时停止播放。
- [x] 宿主：WorkspaceComponentTab/工具栏/SidePanel、IPC 注册、preload 类型桥、Agent 编排器工具和提示。只添加影像分支，保留其他正在进行的画布/交互设计改动。
- [x] 验证：相关 Bun 测试、全仓 typecheck、Electron 构建、真实组件 UI smoke；检查从空项目建立作品到导入素材、关联镜头、提交/采用候选的闭环。
- [x] 回写 MEMORY.md，报告已完成行为、测试证据和媒体生成/合成的实际限制；不提交、推送或打包发布。

## 关键合同

`VisualProductionDraft` 是可编辑的创作设定、episodes、assets、shots；媒体只使用内部 `mediaId`，不保存任意 URL。snapshot 包含 document、media、assetVersions、shotStates、candidates、jobs。每次正式 save/adopt 增加 document.revision；媒体导入只登记独立素材，不推动正式设定版本。候选绑定 baseRevision 与本轮 jobId；单镜头任务禁止改其他镜头或项目字段。

文件大小、列表数量、总文本和候选数量均有明确预算。读取模型不携带媒体字节；UI 只读取当前需要的内容。初版不迁移原画布数据、不修改真实用户现有项目、不自动调用收费模型。


## 实施与验收结果

2026-10-16 已完成。主入口位于工作区工具菜单的“影像创作”，有效的普通 Agent 项目会话可用；原画布与交互设计入口继续独立。

- 生产文件分布：`packages/shared/src/types/visual-production*`；`apps/electron/src/main/lib/visual-production/*`；`apps/electron/src/preload/visual-production-preload*`；`apps/electron/src/renderer/components/visual-production/*` 与对应 Jotai 视图状态。宿主以窄新增方式接入工具、标签、IPC、preload 与 Agent 编排器。
- 定向 Bun 验证共 99 项、238 个断言通过；覆盖合同、存储与媒体、候选/任务、权限、运行归属、preload、导航和视图隔离。全仓 `bun run typecheck` 通过。
- `bun run electron:build` 通过。首次原生 Swift 构建因默认缓存目录不可写失败，改用 `CLANG_MODULE_CACHE_PATH=/private/tmp/dutydeck-clang-cache` 后完成全链构建；最后画框比例调整另运行 renderer build 通过。
- `apps/electron/scripts/visual-production-ui-smoke.ts` 使用真实组件、preload、IPC、原子文件服务和隔离项目，验证新建、设定、资产/镜头、PNG 导入、主 Agent 引用、候选预览/采用、重开持久化、460px 固定弹窗底栏、深浅主题、真实 MP4 连播/截断/隐藏暂停、9:16 画框与 A→B→A 迟到响应隔离。需要本机 ffmpeg 生成两秒测试色卡，不访问真实业务数据或模型服务。
- 独立复核发现并修复媒体种类绕过、单镜头重排/跨集绕过、历史数量耗尽、Agent 大响应、旧运行任务提交，以及编辑器与上下文异步竞态。

首版边界：关系页是可点击的资产→镜头→集数引用列表；镜头顺序在分镜页调整，尚无完整时间线、自动混音或成片合成。交付下载制作清单及已采用素材；生成依赖已配置的既有媒体工具，本轮未调用真实模型。媒体每份最多 32 MiB；本地导入使用授权项目内相对路径。进程硬崩溃后的未知任务不自动重放。未新增依赖、提交、推送或发布。
