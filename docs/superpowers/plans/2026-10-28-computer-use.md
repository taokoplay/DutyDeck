# Computer Use 第一阶段实施计划

**目标：** 在 DutyDeck 普通用户 Agent 中提供可配置、可观察、逐次审批和可停止的 macOS / Windows 窗口控制。

**架构：** 外部 Cua Driver 负责 macOS AX 或 Windows UI Automation 桌面能力，主进程独占调用、窗口绑定、租约和取消；Pi utility 复用既有宿主工具 RPC。设置页显式启用，初始关闭。只注册给普通用户运行，不给后台、委派、外部或受限运行。截图按需获取，最近观察画面可在会话与设置页查看。

**技术栈：** Bun、Electron、Pi custom tools、TypeBox、Jotai、既有 UI primitives；无新依赖。

已批准的路线是先执行边界、再配置预览、最后 OCR/经验。本阶段完成第一项，并提供必要配置与最近观察画面；原生视频、自动安装、OCR 与经验迭代不混入桌面执行基础。官方接口以本轮核对的 Cua 文档/源码为准；未安装/未授权保持明确不可用。

## 实施与验收

- [x] 共享合同：`packages/shared/src/types/computer-use.ts` 定义配置、安装、窗口、带唯一 id 的活动租约及固定 UI API。只持久化启用与路径，不保存窗口身份或截图。
- [x] Driver 与服务：`apps/electron/src/main/lib/computer-use/`。先写 BDD 测试并观察失败，再实现标准路径发现、版本解析、结构化错误、限时/限输出调用、PNG 有界读取及临时文件清理。配置走中央根与原子写。
- [x] 租约与停止：两个会话不得同时操作；同一 run 的并发命令不得交错；停止先撤权、取消在途命令，退出前保留租约；迟到结果不覆盖新目标。动作不自动重试，不停止共享 daemon。
- [x] Pi 工具：Discover / Observe / Action / Stop。真实窗口来自本轮发现；观察绑定窗口和 observationId；发布图片必须有有效 captureId；动作白名单、参数有界且窗口/session 由宿主注入；模型可见 schema 为 object 根，宿主独立严格校验动作组合。Observe 和 Action 逐次审批、不可由媒体自动授权策略绕过。Stop 不需要审批。
- [x] 编排接线：普通用户、非受限且非恢复运行才注册；绑定 runIdentity.signal 和动态权限；finally 收尾及用户停止撤销；受限恢复不重新构建桌面权限。
- [x] 四层 IPC：专用 main 注册器、preload bridge、shared 合同、renderer UI。仅主窗口主 frame 可改配置/停止；路径由文件选择器选择；UI 不得提交动作或自定义命令。
- [x] UI：独立电脑控制设置页，安装/权限未验证说明、选择 Driver、启用、按需检测、活动窗口与停止。会话显示最近观察时间/画面和停止，卸载清理订阅，不后台轮询截图。
- [x] 验证：服务正常/失败/并发/停止/过期捕获/来源限制测试；真实子进程假 Driver 协议集成、工具实际审批链与 UI 交互烟测。按变更运行 `bun test`、`bun run typecheck`、临时输出 main/runtime/preload/renderer 构建，不覆盖正在运行的 Dev dist。

## 影响与资源

关联 Pi、审批、会话停止、设置与 Agent UI，不改变模型 runtime、现有浏览器或其他模块工具。普通 Bash/MCP 仍是既有独立能力，本阶段不声称能隔离所有外部桌面输入。租约是本应用主进程内互斥，不承诺阻止其他 App/Driver 客户端。

无常驻采集、无新模型调用；按需列表/截图，截图和文本均限量，活动租约与最后画面只存内存。取消不回滚已发生的输入，也不能保证共享 daemon 已接收的 OS 动作物理撤销；停止回执应说明这一边界。


## 本轮验收（2026-10-28）

- 功能定向 43 项／184 断言通过，关联权限与工具模式 55 项／251 断言通过；真实工具→单次审批→服务→假 Driver 子进程集成通过。实际 Anthropic、OpenAI Completions/Responses 参数编码全部离线拦截验证。
- 独立 Electron UI smoke 通过：启用、路径选择、安装检测、会话隔离、检测等待期间紧急停止、失败重试、订阅清理；只加载临时夹具，未采集真实桌面。
- main、agent runtime、preload 与 renderer 已输出到 `/private/tmp/dutydeck-computer-use-*` 编译验证，不覆盖运行中 Dev 的 dist。全仓 typecheck 仅剩本轮未修改的 `vault-directory-pagination.ts:40/41` 两处 `cursor.offset` 可空错误，其余工作区通过。
- 编排测试 38 项通过，1 项既有媒体提示字符串断言失败；同一字符串在 HEAD 的 orchestrator 中也不存在，本轮没有修改该媒体合同或其测试。
- 已修复复核发现的默认 markdown/结构化 elements 差异、顶层 union 被供应商转换丢参、配置 busy 阻断紧急停止；另补 Driver 切换竞态与首次实际工具惰性安装检测。
- 本机 Driver 为 0.17.0，本阶段门槛为 0.38.0+；未自动安装或升级，系统授权与真实应用输入未验收。原生视频、OCR、App 经验不在本阶段。
- 多项构建并行期间子进程集成曾有一次测试超时（日志显示约 62 秒后才报告 5 秒测试预算耗尽）；隔离复跑约 902ms 通过，停止并行构建后的 43 项完整复跑约 1.3 秒通过。未复现确定实现缺陷，没有提高超时或添加动作重试。
- “仅内存”只描述租约和最近预览缓存；交给模型的截图与控件文字会按既有 Pi 会话历史机制保存，临时 PNG 文件在观察结束后清理。专用审批已说明这一点。

验证日志：`/private/tmp/computer-use-final-tests.log`、`/private/tmp/computer-use-adjacent-tests.log`、`/private/tmp/computer-use-orchestrator-tests.log`、`/private/tmp/computer-use-final-typecheck.log`、`/private/tmp/computer-use-host-build.log`、`/private/tmp/computer-use-renderer-build.log`。

## 第二步：用户主动权限预检（2026-10-28）

- [x] shared / main IPC / runtime / preload / renderer 同步接入 `checkPermissions`，设置页显示辅助功能、屏幕录制各自状态与完成时间；通过标签仅代表本次能力证据，不代表真实输入已验证或系统授权永久有效。
- [x] 仅点击“验证系统权限”时读取一个窗口的结构化控件及最多 320×320 截图；不把窗口正文或图片返回页面/模型。临时 PNG 无论成功失败都清理，无后台采集和新模型调用。
- [x] 窗口列表仅定位，不作为辅助功能授权证据；无窗口、无控件或缺失预检实现保持 unknown。截图通过必须匹配窗口身份、非空 captureId、有效帧状态，并经有界文件读取与现有 Sharp 的完整像素解码；截断或损坏 PNG 不得通过。
- [x] 预检互斥，活动控制期间拒绝预检，预检期间拒绝新 Agent 观察；不影响既有紧急停止。更换路径或关闭功能取消在途预检，异步安装检测后再次复核门禁，迟到结果不覆盖新路径；重新检测安装清除旧权限证据。
- [x] 回归先复现空窗口/缺失截图/截断 PNG/错误窗口/空捕获标识及安装等待期间路径切换误报，再验证修复。权限专项 12 项／23 断言、完整电脑控制定向 56 项／210 断言通过；独立 Electron UI smoke 覆盖按钮可用性、权限结果和时间、会话隔离、检测等待期间停止与订阅清理。

关联影响仅限电脑控制预检入口和状态展示；预检复用现有有界 PNG 读取，不改变既有观察的图片发布合同。完整解码只用于用户主动触发的小图，像素上限 320²；不引入新依赖、常驻任务或自动动作重试。

主进程、Agent runtime、preload 临时构建通过，产物位于 `/private/tmp/dutydeck-computer-use-permission-host/`。本机重新读取仍为 Cua Driver 0.17.0，未升级；真实 macOS 系统权限与应用输入验收继续缺失，不能将模拟通过称为端到端桌面验收。原生视频流、OCR、App 经验仍未实现。Nowledge 定向检索因本机 14242 连接拒绝，未同步。

Renderer 临时构建通过（约 59 秒，保留既有大 chunk 提示）；完整 `bun run typecheck` 复跑仅剩未修改的 `vault-directory-pagination.ts:40/41` 两处 `cursor.offset` 可空错误，电脑控制无剩余类型错误，其余工作区通过。主进程构建保留既有 `dev-bundle-freshness.ts` 的 CJS/import.meta 警告。独立复核确认截断 PNG 修复及租约停止不受新门禁阻断；`git diff --check` 通过。未提交、未发布或升级真实 Driver。

日志：`/private/tmp/computer-use-permission-final-tests.log`、`/private/tmp/computer-use-permission-final-host.log`、`/private/tmp/computer-use-permission-final-typecheck.log`、`/private/tmp/computer-use-permission-final-renderer.log`。

## 第三步：Windows 协议层接入（2026-10-28）

- [x] 按随 Proma 分发的 `cua-driver-cli` 规范接入 Windows：接受 `cua-driver.exe`，候选路径按用户目录、`LOCALAPPDATA`、`Program Files` 排序；版本门槛仍为 Cua Driver 0.38.0+。
- [x] 服务允许 Windows 通过同一 Discover / Observe / Action / Stop 租约和逐次审批链；Windows 权限预检复用 UI Automation 控件树与屏幕捕获证据，设置页显示“UI Automation / 屏幕捕获”，不套用 macOS TCC 文案。
- [x] 主进程文件选择器在 Windows 过滤 `.exe`；Agent prompt 和 Discover 描述同步声明 macOS/Windows，避免模型仍按“仅 macOS”规划任务。
- [x] BDD 回归覆盖 Windows `.exe` 版本检测、候选路径、Windows 服务发现、设置页术语；电脑控制相关共 58 项／207 断言通过，Electron UI smoke 通过，主进程和 Renderer 临时构建通过，`git diff --check` 通过。

影响范围是 Driver 适配、服务平台门禁、设置文案和 Agent 工具描述；不新增 Windows 原生输入实现，所有实际窗口语义和输入仍由 Cua Driver 承担。当前没有 Windows 主机或 `cua-driver.exe` 可执行文件，尚未验证 UI Automation、UIPI/UAC、安全桌面、锁屏/断开远程桌面、后台输入和真实截图；因此这一步是协议层接入，不能称为 Windows 端到端验收。全仓类型检查仍仅被未修改的 `vault-directory-pagination.ts:40/41` 阻断。


## 用户点击安装与设置页整理（2026-10-28）

- 用户主动点击后执行固定官方0.38.0安装器，脚本经SHA-256及有界下载验证；安装完成重新检查标准目录实际版本，原子保存路径，不自动开启控制或授予系统权限。
- 安装前撤销并等待本应用桌面运行退出；安装过程中禁止冲突调用；应用退出取消并等待安装进程树及临时文件清理，核验迟到结果不能误报成功。页面切换保留安装阶段，失败可重试。
- Windows优先官方安装目录，禁止安装器添加开机启动或修改PATH；Agent注册统一允许macOS/Windows，继续限制普通用户来源及授权。
- 页面复用其他设置页的统一宽度、卡片、行距和小号按钮，分开控制开关、Driver、系统权限与当前操作；长路径和窄窗口换行。
- 提交前76项/269断言通过；深浅主题、480px窄窗与Windows术语的隔离Electron界面回归通过。未执行真实安装或Windows端到端验收，全仓类型检查仍有原有Vault分页错误。
