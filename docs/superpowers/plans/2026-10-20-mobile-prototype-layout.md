# 移动原型安全区与沉浸布局实施计划

> **For agentic workers:** 使用测试驱动开发执行；合同/持久化与预览运行时分开负责，最后独立复审并统一验证。

**Goal:** 普通页面正确避让系统区域，游戏/直播仍能铺满画面，预览、导出与开发交接使用一致的设计参数。

**Architecture:** 原型保存可选 `environment`（版本、目标系统、基准设备）；页面/状态保存可选 `presentation`（版本、内容布局、状态栏、导航方式、方向）。无 presentation 的旧页面保留原行为。共享设备表提供屏幕、遮挡、安全区；受控预览运行时提供系统栏、CSS 变量和显式布局标记，业务导航由页面实现，切机型通过已有消息边界更新而不重建 iframe。

**Tech Stack:** TypeScript、React、现有 react-mockframe、Bun、Electron；无新增依赖。

## 约定与边界

- `environment = { schemaVersion: 1, target: 'ios' | 'android' | 'web', deviceId }`；设备标识限现有目录。
- `presentation = { schemaVersion: 1, contentLayout: 'safe' | 'edge-to-edge', statusBar: 'dark' | 'light' | 'hidden', navigation: 'inline' | 'overlay' | 'none', orientation: 'portrait' | 'landscape' }`；状态缺省继承页面。
- 仅显式 `[data-prototype-shell]` 使用安全区布局，禁止全局 body padding。全屏背景保留完整视口，`[data-prototype-safe-controls]` 单独避让，业务导航使用 `[data-prototype-navigation]`。
- 页面可通过根元素的 `data-prototype-layout/status-bar/navigation-mode` 属性切换沉浸态、状态栏和导航；导航模式与业务元素标记必须异名，避免 CSS 作用到整个 HTML；硬件遮挡不随状态栏隐藏消失。
- 系统栏在共享 HTML 运行时中生成；真实预览外壳绘制硬件，独立导出模拟相同遮挡。状态栏和手势条不重复绘制。
- 设备参数是模拟预设，不声称等同真实设备 OS API；横屏交换视口并重新计算遮挡、控件避让。
- 老页面不做启发式删除或原地迁移；新候选显式采用新合同，沿用已有 CAS。
- 不修改截图对应项目的正式数据，不提交、发布或替换安装版。

## 执行与验证

- [x] 合同：先添加环境/页面/状态白名单、非法枚举、旧hash、页面CAS和状态持久化BDD测试，再修改共享类型、主进程和Agent schema。
- [x] 参数：先测试 iPhone 灵动岛、刘海、经典机型、Android、Web 和横屏的视口/安全区，再实现共享设备表；与现有外壳库屏幕尺寸逐项比较。
- [x] 运行时：先测试旧页面不注入、新页面注入、状态继承、全屏控件避让、导出参数，再实现共享 HTML 系统栏与只接收当前父端 token 的设备消息。
- [x] Renderer：接入当前设备参数、受控方向、旋转外壳，保证同一个 iframe 在设备/方向切换时保留输入、滚动与脚本现场。
- [x] 生成规范：更新默认交互设计 Skill 并递增 patch，提供普通页面和直播/游戏的完整最小骨架，说明状态切换和兼容边界。
- [x] 真实 UI：隔离 Electron smoke 覆盖普通页面、直播、游戏、横屏、旧页面、切机型输入保留和独立导出；保存并检查完整机身截图。
- [x] 集成：定向 Bun 测试、全仓 `bun run typecheck`、renderer 构建、`git diff --check`，按发现的问题修复并复审。

## 影响与资源

影响范围为交互设计合同、候选/交接、预览与默认生成规则；不改普通聊天、媒体供应商、权限或业务接口。参数更新采用已有消息链路与 CSS，系统图标为静态 SVG；只监听少量根属性，不轮询、不增加外部请求。保留 iframe 生命周期与缓存预算。

## 验证记录

- 相关 Bun 测试：223 pass / 0 fail，19 文件、739 断言；导航模式属性分离后追加运行时回归 23 pass / 0 fail。
- 全仓 `bun run typecheck` 退出 0；最终 `bun run build:renderer` 退出 0，保留现有大 chunk 提示。日志：`/private/tmp/dutydeck-mobile-tests.log`、`/private/tmp/dutydeck-mobile-typecheck.log`、`/private/tmp/dutydeck-mobile-build.log`。
- 新增真实 Electron 移动 smoke 全量退出 0；两新增脚本以独立 tsconfig 类型检查退出 0。覆盖普通页、直播、横屏游戏、机型/方向切换保持 iframe/输入/滚动/脚本、状态覆盖继承、旧页、错误来源/token拒绝、Home条颜色和固定视口离线导出。
- 原有完整 `interaction-design-ui-smoke.ts` 的 cache、inflight、regression 均退出 0；已有原型新增页保存新版布局合同与显式 shell。并行测试窗口首次 regression 超时，最终单独完整重跑通过，未确定首次超时根因。
- 默认 Skill 的全屏 HTML 直接导入真实浏览器验证：直播导航 top=62 / bottom=106，HUD top=118，间隔12px；切游戏模式后导航隐藏、HUD回到安全区顶部12px。由此捕获并修复根模式属性与业务导航标记同名导致的 CSS 冲突，禁止重新合并两种标记。
- 横屏可见状态栏：顶部有效安全区24px；同页隐藏后恢复0px，左右硬件避让62px不变。预览和开发交接共用自包含安全区函数；Bun、esbuild CJS压缩/非压缩、Vite生产产物均经独立VM验证没有外部函数依赖。
- 证据目录：`/private/tmp/dutydeck-mobile-smoke/`，含 `geometry.json`、普通页/直播/横屏游戏/默认Skill完整机身截图；保留机型切换及默认Skill错误的红跑证据。主代理已人工查看普通页、横屏游戏和默认Skill直播截图。
- 复审指出的新建入口、横屏交接差异、默认直播HUD重叠均已修复；范围内 `git diff --check` 通过。
- 未改真实 CyberParty 原型、未自动迁移旧页面、未提交/发布/替换安装版；系统参数是预览模拟预设，原生系统手势与系统栏显隐仍需实机实现和验收。Nowledge 定向检索服务连接拒绝，本轮未同步。
