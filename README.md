<div align="center">
  <img src="./docs/assets/brand/dutydeck-icon-256.png" alt="DutyDeck" width="96" height="96" />
  <h1>DutyDeck</h1>
  <p><strong>面向独立开发者的本地优先 AI 工作台</strong></p>
  <p>把 Agent、交互设计、影像创作、运维与接口调试放在同一个工作台，减少工具切换，把注意力留给产品。</p>
  <p>
    <a href="https://github.com/taokoplay/DutyDeck/releases/latest"><img src="https://img.shields.io/github/v/release/taokoplay/DutyDeck?label=Release" alt="最新版本" /></a>
    <a href="https://github.com/taokoplay/DutyDeck/releases"><img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-2563eb" alt="macOS、Windows、Linux" /></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-2563eb" alt="AGPL-3.0-only" /></a>
  </p>
  <p><a href="https://github.com/taokoplay/DutyDeck/releases/latest">下载最新版</a> · <a href="#功能一览">功能一览</a> · <a href="#快速开始">快速开始</a> · <a href="https://github.com/taokoplay/DutyDeck/releases">更新日志</a> · <a href="./README.en.md">English</a></p>
</div>

> DutyDeck 基于开源项目 [Proma](https://github.com/proma-ai/Proma) 演进，由 [taokoplay](https://github.com/taokoplay) 独立维护，以 AGPL-3.0-only 发布。它不是 Proma 官方发行版，也未获得官方背书。感谢 Proma 为 Chat、Agent、工作区、Skills、MCP 等能力提供基础。

## 功能一览

只需要讨论和分析时用 **Chat**，需要读取项目、调用工具和交付结果时用 **Agent**。在同一工作台中，继续完成设计、素材制作、联调和维护。

| 你要完成的事 | 使用的功能 | 能留下什么 |
| --- | --- | --- |
| 分析问题、实现功能、处理项目文件 | Chat / Agent、浏览器、文件、终端 | 对话、代码、文件与执行记录 |
| 把产品想法变成可点击页面 | 交互设计 | 页面与状态、原型预览、候选版本、开发交接包 |
| 制作漫剧、影片、宣传片或图片 | 影像创作 | 作品设定、资产、分镜、按集剪辑时间线与导出结果 |
| 整理素材和多步骤产物 | 画布 | 节点、关系、候选与正式版本 |
| 重复执行一套有验收标准的任务 | 编排工厂 | 场景步骤、批次记录、评审结果与版本历史 |
| 排查服务器、数据库和容器问题 | 服务器运维 | 连接、查询历史、诊断与操作记录 |
| 调试接口并复用测试流程 | 接口工作台 | 集合、环境、变量、断言、场景与请求证据 |
| 管理知识、待办和周期任务 | 项目知识库、Obsidian、Skills、MCP、Todo、日程、定时任务 | 项目知识、可复用能力与任务记录 |

功能说明以 [v0.20.4](./release-notes/v0.20.4.md) 为当前发布基准。工具是否可用取决于项目上下文、平台及已配置的模型或服务。

## 主要工作台

### 交互设计：先把产品体验做出来

按页面组织可点击原型，直接在桌面端或移动端视口中体验，再把明确的页面与交互交给开发。

- 页面目录支持分组、排序、搜索和入口页；每页可维护默认状态与附加状态。
- 在沙箱预览中体验页面、选择元素提出修改，并记录页面跳转与交互流程。
- Agent 修改先形成候选，预览、采纳后更新正式版本；可查看历史、做结构检查并导出已采纳内容。
- 支持 HTML / 图片导入与开发交接，页面原型有独立工作台入口。

### 影像创作与剪辑：从作品设定到镜头和时间线

支持 **漫剧、影片、宣传片、图片** 四类作品。工作台包含项目、资产、分镜/图片、画布、剪辑成片、素材导出与制作配置。

- 按作品管理资产与镜头，保留制作任务、候选和已采用画面；媒体能力以制作配置中可用的模型为准。
- **空镜头只有一张生成图片时自动采用**；同镜头多图或已有正式画面时保留选择。采用一个独立镜头不会让其他镜头候选误过期。
- 按集建立粗剪时间线，调整片段顺序、裁切、音量与字幕；视频和静帧可按轨道顺序连续播放。
- Agent 可提交时间线候选，由你预览和采用；MP4 成片导出可配置比例、帧率、旁白、音乐与字幕。

使用前请留意：成片导出需要本机安装 **FFmpeg**；真实音视频导出仍待完整端到端验收。即梦图片使用本机 Dreamina CLI 登录态，即梦视频执行器尚未接入。模型出现在目录中不代表当前已可执行。

### 画布：管理素材、依赖与版本

用节点组织 Agent、图片、音频、视频、文档与 WebView 内容，查看产物之间的依赖和引用关系。候选与正式版本分开保存，便于逐步修改和确认交付。页面原型优先使用交互设计；作品、分镜和时间线优先使用影像创作。

[画布说明](./docs/extensions/canvas.md)

### 编排工厂：把重复任务变成可复用场景

为场景定义步骤、输入和验收标准，执行批次并查看历史结果。支持模型设置、评审评估、优化和交付；修改与回滚保留可追溯的版本历史，便于比较不同方案。

### 服务器运维：连接、排障与操作留在一个地方

- 管理 SSH、MySQL、PostgreSQL、Redis 和本地 SQLite 连接，按项目组织。
- 查看服务器概览、终端、systemd 服务、日志、远程文件、传输与 Docker。
- 浏览库表与结构，使用 SQL 工作台、查询历史和只读诊断；Redis 当前提供连接与只读诊断。
- Agent 访问按会话和资源范围授权；只读授权可撤销并有有效期，服务器写操作逐次审批，凭据由本机加密保存。

[运维工作台说明](./docs/extensions/server-ops.md)

### 接口工作台：调试一次，保留可复用的请求与证据

- 管理集合、文件夹、请求、环境、变量和鉴权，导入/导出 cURL 与集合。
- 支持 HTTP/HTTPS、SSE、表单与文件正文、公共签名/加密配置及无脚本断言。
- 将多个请求组织为场景，通过提取变量串联步骤；保留最终请求、响应、分阶段耗时、TLS 与断言结果。
- Agent 发送请求和保存配置分别审批；人工创建的测试用例受保护。

[接口工作台说明](./docs/extensions/api-workbench.md)

## 项目上下文与日常工具

- **工作区**：浏览器、文件和终端在项目内切换；`AGENTS.md` 用于声明项目指令，旧 `CLAUDE.md` 保留兼容。
- **知识与能力**：项目知识库、独立 Obsidian Vault 入口、工作区 Skills 与 MCP，让可复用知识和工具跟随项目。
- **效率**：Todo、日程与定时任务分别管理待办、安排和周期执行；[今日活动](./docs/extensions/today-activity.md) 汇总当天活跃会话，方便回到原上下文。
- **桌面与远程**：内嵌浏览器、文件预览、语音输入、深浅主题，以及可配置的远程机器人桥接。

会话和业务配置默认保存在本机，可配置数据根，默认位置是 `~/.DutyDeck/`。项目内容保留自己的存储边界；选择云模型或远程服务时，相关输入仍会按你的配置发送到对应服务。本地优先不等于所有任务都离线运行。

## 模型与执行方式

| 方式 | 用途 | 配置要点 |
| --- | --- | --- |
| 云端 API / 兼容端点 | Chat 与 Agent | 自行配置渠道，支持 OpenAI、Anthropic、Google 等协议及兼容服务 |
| ChatGPT / xAI 订阅授权 | Agent | 使用对应的 OAuth 登录入口与账户权限 |
| DutyDeck 本地模型 | Agent | 内置 llama.cpp + GGUF；安装引擎、下载、加载、能力测试后启用，普通 Chat 当前不使用此供应商 |
| 图片、视频、音频能力 | 素材生成与影像制作 | 单独配置媒体能力；是否可执行以界面显示的模型、执行器和授权状态为准 |

Agent 由 **Pi Agent Runtime** 驱动，支持工作区隔离、协作子任务、权限模式与会话历史。不同工具遵循各自的授权规则，运维只读授权不会自动扩展到普通 Agent 的 Shell 或其它工具。

DutyDeck 不附带模型 API 额度或订阅；本地模型需要可用的硬件资源，媒体服务可能单独计费。

## 快速开始

1. 从 [Releases](https://github.com/taokoplay/DutyDeck/releases/latest) 下载与你的平台对应的安装包。
2. 在设置中配置模型渠道，或按“DutyDeck 本地模型”页面指引安装、测试并启用本地模型。
3. 打开或创建 Agent 项目，在工具菜单中选择交互设计、影像创作、运维、接口等工作台；配置需要的 Skills / MCP。
4. 做影像任务时先检查制作配置；导出成片前准备 FFmpeg。

| 平台 | 安装包 |
| --- | --- |
| macOS Apple Silicon | `DutyDeck-<版本>-macos-arm64.dmg` |
| macOS Intel | `DutyDeck-<版本>-macos-x64.dmg` |
| Windows x64 | `DutyDeck-<版本>-windows-x64.exe` |
| Ubuntu / Debian x86_64 | `dutydeck_<版本>_amd64.deb` |
| Linux x86_64 | `DutyDeck-<版本>-linux-x86_64.AppImage` |

[Linux 安装说明](./docs/linux.md) · [从 Proma 迁移](./docs/migrations/2026-10-dutydeck-from-proma.md) · [Proma 基础教程](https://github.com/proma-ai/Proma/tree/main/tutorial)

上游教程可用于理解 Chat、Agent、Skills、MCP 等基础概念；DutyDeck 的扩展入口和界面以当前版本为准。旧 `~/.proma/`、项目内 `.proma/` 及历史 CLI / 环境变量保留兼容，迁移按客户端提示确认。

## 界面预览

以下是仓库已有的功能截图，部分来自早期版本；当前入口与行为以上方说明为准。

<details>
<summary>运维工作台与接口工作台</summary>

### 服务器运维

![DutyDeck 运维工作台](./docs/assets/screenshots/dutydeck-server-ops-demo.png)

### 接口工作台

![DutyDeck 接口工作台](./docs/assets/screenshots/dutydeck-api-workbench-demo.png)

</details>

<details>
<summary>画布、Chat 与 Agent</summary>

### 画布

![DutyDeck 画布](./docs/assets/screenshots/dutydeck-canvas-demo.png)

### Chat

![DutyDeck Chat](./docs/assets/screenshots/proma-chat-demo.png)

### Agent

![DutyDeck Agent](./docs/assets/screenshots/proma-agent-demo.png)

</details>

<details>
<summary>Skills、MCP 与语音输入</summary>

![DutyDeck Skills](./docs/assets/screenshots/proma-skills-demo.png)

![DutyDeck MCP](./docs/assets/screenshots/proma-mcp-demo.png)

![DutyDeck 语音输入](./docs/assets/screenshots/proma-typeless-input.png)

</details>

## 由来与上游关系

个人开发者需要连续的时间做产品，却经常在页面设计、素材、服务器、数据库、接口、脚本与文档之间切换。DutyDeck 希望把这些职责集中在一个有项目上下文的工作台里：**Duty 是分内之事，Deck 是集中处理它们的操作台。**

感谢 [Proma](https://github.com/proma-ai/Proma) 和作者 [erlich.fun](https://erlich.fun) 为这个项目提供开源基础。DutyDeck 在继承的能力上持续修改和扩展，按需移植上游更新，并独立维护交互设计、影像创作、编排工厂、运维、接口等功能；功能和发布时间不与官方版本同步。

自 `0.20.0` 起，DutyDeck 使用独立标准版本号，发布标签为 `v<应用版本>`。早期 `-bone.<构建号>` 版本保留在历史记录中。[当前发布说明](./release-notes)与[历史 Bone 说明](./release-notes/bone)可分别查阅。

## 开发与贡献

Bun monorepo，桌面应用位于 `apps/electron`，共享包位于 `packages/*`。主要技术栈：Electron、React、TypeScript、Jotai、Tailwind CSS、Radix UI 和 Pi Agent Runtime；具体版本以 [package.json](./apps/electron/package.json) 与锁文件为准。

```bash
bun install
bun run dev
bun run typecheck
bun test
bun run electron:build
```

新增功能请覆盖正常路径和主要边界；修改 IPC 时同步 shared 类型、主进程、preload 与 renderer。打包需要检查运行时依赖和目标平台产物，详见 [工程约定](./AGENTS.md)。欢迎提交问题、修复、文档和可复用 Skills。

维护者：[taokoplay](https://github.com/taokoplay)。另感谢 [Shiki](https://shiki.style/)、[Beautiful Mermaid](https://github.com/lukilabs/beautiful-mermaid) 与 [Mermaid](https://mermaid.js.org/) 等开源项目。

## 许可证

DutyDeck 采用 [GNU Affero General Public License v3.0（AGPL-3.0-only）](./LICENSE) 开源。本仓库的 `LICENSE` 与上游 Proma 逐字节一致，不附加任何额外限制。

**你可以**：自由使用、修改、分发 DutyDeck 及其衍生作品，也可以商业使用。前提是遵守 AGPL-3.0——以源代码或修改后的形式分发，以及通过网络对外提供服务时，都要公开完整的对应源码，衍生作品必须继续以 AGPL-3.0 授权。

**永久开源承诺**：DutyDeck 的每一个发布版本都以 AGPL-3.0 在公开仓库释出，任意历史版本都能取得对应源码。本仓库不收集、也不接受把贡献重新授权为专有许可的权利——包括维护者在内，没有任何人能把这套代码闭源。

**商业授权豁免**：本项目不提供、也无权提供 AGPL 商业豁免。需要闭源集成请自行遵守 AGPL-3.0，或向拥有版权的上游 Proma 申请其商业许可。

向 DutyDeck 提交 Pull Request 即表示你同意你的贡献以 AGPL-3.0-only 授权给任何人；本项目不要求你转让版权。
