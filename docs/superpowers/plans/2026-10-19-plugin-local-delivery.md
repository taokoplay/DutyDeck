# 插件开发底座：本地交付说明

2026-10-19。本轮实现统一插件机制的本地内容包兼容闭环；它只代表旧版 `content` 形态，不代表目标业务模块插件。项目/工作区 Skills 继续由现有 Skill 系统管理，市场、团队私有源和可执行业务插件仍按生态路线图后续交付。

## 已有能力

| 环节 | 当前行为 |
| --- | --- |
| 作者规范 | 一个标准脚手架；插件、模块和 Skill 引用使用稳定命名空间；项目 Skill 正文继续由现有 Skill 系统维护 |
| 独立工具 | `@dutydeck/plugin-sdk@0.1.0` 和 `@dutydeck/plugin-kit@0.1.0` 可构建成独立 tarball，不依赖宿主源码或 Electron |
| 安装包 | `.ddplugin` ZIP；完整性清单、Ed25519 签名、平台/API 校验、路径和资源预算 |
| 设置入口 | 设置 → 插件；本地文件预览、来源指纹确认、安装/更新、关闭/启用、卸载、资源归属 |
| 聊天 | 在输入框底栏选模块，显示前置 chip；仅当前消息选择后解析项目 Skill 引用并读取插件提示/设计约束 |
| 调用记录 | 记录模块、插件版本、包 SHA-256、Skill revision 和插件资源身份/版本；包上下文与 Pi 工作区 Skill 实际加载分开显示 |
| 恢复 | 恢复摘要绑定已选插件身份和包 SHA-256；升级或替换后不能沿旧合同恢复 |
| 兼容 | 保留 V1 清单与工作区 Skills；已关闭 V2 仍保留身份；浏览器/终端自动能力不变 |

设计约束只是可选包内资源，没有另设风格插件类型。当前不支持插件 Node/JS 入口、独立 UI、后台服务、动态工具、跨包依赖、声明式设置或共享资源导出，清单提交这些能力时明确拒绝。旧包如包含 Skill 条目仅用于兼容解析，新的模块合同禁止打包 Skill 正文；额外静态文件可随包保留，但没有向 Agent 暴露任意包文件读取接口。

## 在仓库内构建与验收

```bash
bun run build:plugins
bun run plugin:author-smoke
cd apps/electron
bun run content-plugin-smoke
```

作者验收生成 `dist/plugin-tools/dutydeck-plugin-sdk-0.1.0.tgz` 和 `dutydeck-plugin-kit-0.1.0.tgz`。它在仓库外离线安装这两个真实发行物，验证不存在工作区链接，再用安装的 CLI 创建插件、签名打包及升级。工具尚未发布到公共包注册表。

Electron 验收使用真实 BrowserWindow、生产 preload/IPC 和安装服务，只将原生文件选择结果固定到测试文件；数据根和实例锁隔离。它覆盖信任确认、选择 chip、更新、关闭/启用、卸载、忙时/其他实例拒绝、键盘取消和窄屏深浅主题。没有发起真实模型请求。

## 外部作者使用本地工具包

把上述两份 `.tgz` 放到仓库外的 `author-tools` 目录，并在那里创建如下 `package.json`。SDK 尚未公开发布，因此需要显式 override，使 CLI 的依赖也解析到同一 tarball。

```json
{
  "name": "my-plugin-tools",
  "private": true,
  "type": "module",
  "devDependencies": {
    "@dutydeck/plugin-sdk": "file:./dutydeck-plugin-sdk-0.1.0.tgz",
    "@dutydeck/plugin-kit": "file:./dutydeck-plugin-kit-0.1.0.tgz"
  },
  "overrides": {
    "@dutydeck/plugin-sdk": "file:./dutydeck-plugin-sdk-0.1.0.tgz"
  }
}
```

在 `author-tools` 内执行：

```bash
bun install --offline --ignore-scripts
bun run dutydeck-plugin init ../my-plugin --id acme.my-plugin --name 我的插件
bun run dutydeck-plugin validate ../my-plugin
bun run dutydeck-plugin test ../my-plugin
bun run dutydeck-plugin publisher init --config-dir ../my-publisher-keys
bun run dutydeck-plugin pack ../my-plugin --out ../my-plugin-1.0.0.ddplugin --release --config-dir ../my-publisher-keys
bun run dutydeck-plugin verify ../my-plugin-1.0.0.ddplugin --trusted-key <生成密钥时返回的指纹>
```

`my-publisher-keys` 必须位于插件工程与版本库之外；保管其中的私钥，给用户传递公开指纹。工具拒绝覆盖已有输出；升级时递增清单版本，资源变化同步递增资源声明和正文 frontmatter 版本，并写到新的包文件。普通 `pack` 生成未签名开发包，正式客户端拒绝安装；当前开发隔离接口仅供宿主测试，尚无桌面开发包导入入口。

`test` 验证框架合同，不执行作者项目的任意脚本，也不证明模型输出质量。外部作者仍需要按业务写任务示例和验收标准。

## 安装、使用与边界

用户在设置的“插件”页选择 `.ddplugin`，核对包身份、版本、资源和开发者指纹后确认。安装后插件状态为“可选择”，需要在发送消息时选择模块才接入模型。关闭会从选择目录移除模块，旧草稿仍引用该模块时在运行前阻断。插件的 Skill 不复制进工作区，也不会借此扩大工具权限。

同一 ID 的升级必须使用更高版本及原发布者密钥，关闭状态在升级后保留。管理变更在 Agent 运行/排队、写入业务数据或另一个共享数据根实例存在时拒绝；本阶段没有排空操作或自动中止任务。卸载撤销准入，保留历史包、用户作品和会话；尚未提供包垃圾回收、回退按钮或密钥轮换流程。注册表或锁损坏时保留原始数据并报错，不能通过吞错自动重置。

目录只存摘要；未选模块不扫描插件正文或项目 Skill 正文。多模块同包每轮只验证一次；单轮项目 Skill 正文、提示和设计约束的实际注入仍受各自预算约束，最终注入包含来源说明也受预算约束。

后续顺序：内置六模块的统一全局开关与入口准入 → 开发隔离入口和生命周期诊断/回退 → 公共及私有插件源 → 可执行工具/UI 的公开接口与隔离宿主。正式 SDK/CLI 与兼容客户端发布、干净机器验收及外部贡献者复验仍未完成，本地验证不等同已公开上线。
