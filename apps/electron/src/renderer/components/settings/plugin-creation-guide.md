# 创建你的第一个插件

用标准脚手架把模块、Skills 和提示词打包成可安装的 `.ddplugin`，让其他用户在 DutyDeck 中选择使用。此页提供开发说明，创建工程和打包命令需要在本机终端执行；代码块右上角可复制。

当前脚手架与 SDK 版本为 **0.1.0**，支持内容插件：Skills、提示词，以及按需携带的设计约束。自定义可执行工具、独立 UI 和后台服务暂未开放。设计约束属于插件内部资源，无需另建一种插件。

## 1. 准备开发工具

安装 Bun，并准备包含 `packages/plugin-sdk` 与 `packages/plugin-kit` 的 DutyDeck 源码。SDK / CLI 尚未发布到公共包注册表，当前使用源码构建或本地工具包。

在 DutyDeck 源码根目录执行：

```bash
bun install
bun run build:plugins
```

下方示例命令均在这个源码根目录执行。插件工程、发行包和发布者密钥放在源码仓库外，便于独立维护。

**已有独立工具包的作者**：不需要宿主源码。将 `dutydeck-plugin-sdk-0.1.0.tgz` 和 `dutydeck-plugin-kit-0.1.0.tgz` 放入独立的 `author-tools` 目录，按本页末尾的配置安装，再使用 `bun run dutydeck-plugin` 替换下面的 `bun packages/plugin-kit/dist/cli.js`，并始终在 `author-tools` 中执行。

## 2. 创建插件工程

将 `acme` 换成你的发布者标识，`my-plugin` 换成插件名称标识；标识使用小写英文字母、数字和连字符，展示名称可以使用中文。

```bash
bun packages/plugin-kit/dist/cli.js init ../my-plugin --id acme.my-plugin --name "我的插件"
```

脚手架会生成一个可校验的示例模块，以及这些文件：

```text
my-plugin/
  plugin.json                 插件身份、兼容性、模块与资源归属
  package.json                开发命令与工具版本
  skills/assist/SKILL.md       示例 Skill
  prompts/workflow.md          示例提示词
  README.md                   使用说明
  CHANGELOG.md                版本记录
  LICENSE                     许可证
  THIRD_PARTY_NOTICES.md       第三方资源声明
  .gitignore                  排除依赖与打包产物
```

## 3. 编写模块与资源

- **插件清单**：修改 `plugin.json` 中的展示名、简介、许可证和模块。保留稳定的插件 ID；每个 Skill 必须声明所属模块，模块需要显式引用它使用的 Skills 和提示词。
- **Skills**：编辑 `skills/assist/SKILL.md`，保留 frontmatter 中的名称、描述与版本，以及适用任务、输入、执行步骤、工具边界、输出、失败/取消、验收章节。
- **提示词**：编辑 `prompts/workflow.md`，说明用途、输入、输出和具体内容，保留名称、描述与版本。
- **可选设计约束**：仅在插件确实需要时添加，并在清单中声明资源及模块归属。

插件资源随包管理，不复制到用户工作区的 Skills 目录。内容插件不会注册新工具，已有工具仍遵守宿主授权范围。

## 4. 校验与测试

```bash
bun packages/plugin-kit/dist/cli.js validate ../my-plugin
bun packages/plugin-kit/dist/cli.js test ../my-plugin
```

校验覆盖清单格式、资源引用、章节、版本、路径与体积限制。`test` 检查插件合同，不执行作者自定义脚本；安装后还需要用真实任务检查输出是否符合预期。

## 5. 签名打包

首次发布时创建发布者密钥。同一插件后续更新继续使用这份密钥，不要重复生成。

```bash
bun packages/plugin-kit/dist/cli.js publisher init --config-dir ../my-publisher-keys
```

妥善保存 `my-publisher-keys`，保持它位于插件工程和 Git 仓库之外。命令返回的 `keyId` 是公开签名指纹，可交给安装用户核对；私钥不能随插件分发。

```bash
bun packages/plugin-kit/dist/cli.js pack ../my-plugin --out ../my-plugin-1.0.0.ddplugin --release --config-dir ../my-publisher-keys
```

将下面的 `YOUR_KEY_ID` 替换成创建密钥时返回的实际指纹，验证发行包：

```bash
bun packages/plugin-kit/dist/cli.js verify ../my-plugin-1.0.0.ddplugin --trusted-key YOUR_KEY_ID
```

不加 `--release` 会生成未签名开发包，当前桌面安装入口不接受这种包。工具不会覆盖已有工程、密钥目录或输出包；更新时使用更高版本及新的包文件名，资源内容变化时同步递增清单资源版本与正文 frontmatter 版本。

## 6. 安装与使用

1. 在本页顶部切换到「市场」，点击「从本地包安装 / 更新」。
2. 选择签名 `.ddplugin` 文件，核对插件身份、版本、资源和开发者提供的指纹，再确认安装。
3. 回到「已安装」查看插件；发送消息时明确选择它的模块，才会加载对应 Skills 和提示词。
4. 用实际任务检查输出。关闭插件后，其模块不再可选；卸载保留用户作品与会话记录。

安装和更新需要等待 Agent 运行、排队与数据写入结束，并关闭其他共享同一数据根的 DutyDeck 实例。当前市场和团队私有源尚未开放，可以直接向用户分发签名包与公开指纹。

## 使用独立工具包

在 `author-tools/package.json` 写入以下配置。SDK 尚未公开发行，因此需要 `overrides` 将 CLI 的 SDK 依赖也指向同一份本地包。

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

在 `author-tools` 目录安装并创建工程：

```bash
bun install --offline --ignore-scripts
bun run dutydeck-plugin init ../my-plugin --id acme.my-plugin --name "我的插件"
```

后续校验、签名和打包同样使用 `bun run dutydeck-plugin`。如果需要自行生成这两份工具包，在 DutyDeck 源码根目录执行 `bun run plugin:author-smoke`；验收成功后，工具包保存在 `dist/plugin-tools/`。
