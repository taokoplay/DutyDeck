# 内置模块统一展示实施清单

**目标：** 完成已批准插件中心规划中的只读目录展示切片，使六个内置专业模块与外部内容包在同一页面可查看。

**方案：** 复用主进程 `getAgentModules` 目录及 renderer 的 Jotai 目录加载器；仅展示宿主标记 `source === 'builtin'` 且非自动能力的模块。独立组件承接加载、失败重试、空目录和卡片显示，资源引用来自既有 manifest，不扫描正文。内置版本标为模块版本、更新随应用；无开关、卸载或独立更新操作。

**范围与影响：** 本轮不改变 Agent 准入、模块选择、工具权限或外部包事务。目录复用缓存及并发请求去重，无新增依赖、IPC、轮询或网络读取。资源列表不暗示当前项目已安装/加载 Skill。

## 实施与验收

- [x] 扩展 `PluginSettings.test.tsx`：使用真实内置清单和隔离 Jotai store，验证六模块、Skills/提示引用、来源过滤、无虚假管理动作，以及读取失败不显示空目录或永久加载。先运行 `bun test apps/electron/src/renderer/components/settings/PluginSettings.test.tsx`，观察新增断言失败。
- [x] 新建 `BuiltinPluginSettings.tsx`，复用 `loadAgentModuleCatalog` 和设置卡片；在 `PluginSettings.tsx` 分别标明内置模块与本地内容插件。
- [x] 扩展 `content-plugin-smoke.ts`，真实注册内置清单，限定外部包操作定位范围，验证六模块/资源折叠/键盘与窄窗，并保留原有失败重试和安装生命周期验收。
- [x] 执行设置页、模块加载器及注册表相关 Bun 测试、全仓 `bun run typecheck`、`bun run content-plugin-smoke`；直接在运行的完整开发客户端确认展示。检查 `git diff --check`，回写 MEMORY.md。

现有开发分支和前一阶段未提交改动保留；本切片不触发提交、发布或数据迁移。验收通过只代表统一展示完成，全局开关仍属后续切片。

## 验收结果

新增 SSR 验收先出现 5 项失败，实施后相关 23 项测试通过；全仓类型检查通过。Electron smoke 覆盖六模块、资源键盘折叠、内置目录失败重试、窄窗深浅主题和完整外部包生命周期，证据目录为 `/private/var/folders/p_/tktfn8z91gbckq8h5m_cs8vh0000gn/T/dutydeck-content-ui-PBmwtW`。完整开发客户端实际显示内置模块（6），交互设计资源展开可见 `builtin.interaction-design`、`interaction-design` 和 `interaction-design.system.v1`，本地内容包入口正常。独立只读审查无阻断问题。
