<div align="center">
  <img src="./docs/assets/brand/dutydeck-icon-256.png" alt="DutyDeck" width="96" height="96" />
  <h1>DutyDeck</h1>
  <p><strong>A local-first AI workbench for independent developers</strong></p>
  <p>Bring agents, interaction design, media production, server operations, and API debugging into one workspace, with fewer tool switches between you and your product.</p>
  <p>
    <a href="https://github.com/taokoplay/DutyDeck/releases/latest"><img src="https://img.shields.io/github/v/release/taokoplay/DutyDeck?label=Release" alt="Latest release" /></a>
    <a href="https://github.com/taokoplay/DutyDeck/releases"><img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-2563eb" alt="macOS, Windows, Linux" /></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-2563eb" alt="AGPL-3.0-only" /></a>
  </p>
  <p><a href="https://github.com/taokoplay/DutyDeck/releases/latest">Download</a> · <a href="#features-at-a-glance">Features</a> · <a href="#getting-started">Get started</a> · <a href="https://github.com/taokoplay/DutyDeck/releases">Changelog</a> · <a href="./README.md">中文</a></p>
</div>

> DutyDeck builds on the open-source [Proma](https://github.com/proma-ai/Proma) project, is independently maintained by [taokoplay](https://github.com/taokoplay), and is released under AGPL-3.0-only. It is not an official Proma distribution or endorsed by Proma. Thank you to Proma for the foundations of Chat, Agent, workspaces, Skills, MCP, and more.

## Features at a glance

Use **Chat** for discussion and analysis, and **Agent** to work with project files, call tools, and deliver results. Continue with design, media, integration, and maintenance in the same workbench.

| What you want to do | Where to do it | What you keep |
| --- | --- | --- |
| Investigate problems, implement features, work with files | Chat / Agent, browser, files, terminal | Conversations, code, files, and execution records |
| Turn an idea into clickable pages | Interaction Design | Pages and states, previews, candidate versions, developer handoff packages |
| Produce comic episodes, films, promos, or images | Visual Production | Project settings, assets, storyboards, episode timelines, and exports |
| Organize assets and related deliverables | Canvas | Nodes, relationships, candidates, and adopted versions |
| Repeat a task with defined acceptance criteria | Orchestration Factory (编排工厂) | Scenario steps, batches, reviews, and version history |
| Investigate servers, databases, and containers | Server Operations | Connections, query history, diagnostics, and operation records |
| Debug APIs and reuse test flows | API Workbench | Collections, environments, variables, assertions, scenarios, and request evidence |
| Manage knowledge, tasks, and recurring work | Project Knowledge, Obsidian, Skills, MCP, Todo, Calendar, Automations | Project knowledge, reusable capabilities, and task records |

This overview reflects the [v0.20.4 release](./release-notes/v0.20.4.md). Tool availability depends on project context, platform, and configured models or services.

## Main workbenches

### Interaction Design: make the product experience tangible

Organize clickable prototypes by page, try them in desktop or mobile viewports, then hand the pages and interactions over to development.

- Group, sort, and search pages, choose an entry page, and manage default and additional page states.
- Try the sandboxed preview, select elements to request changes, and record navigation and interaction flows.
- Agent changes become candidates for preview and adoption before updating the official version. Inspect history, run structural checks, and export adopted content.
- Import HTML or images and prepare developer handoff packages in a dedicated prototype workspace.

### Visual Production and editing: from a project to shots and a timeline

Create **comic episodes, films, promotional videos, or images**. The workspace includes project settings, assets, storyboards/images, relationships, editing, asset exports, and production configuration.

- Keep assets, shots, production tasks, candidates, and adopted media with the project. Generation uses the models available in production configuration.
- **A single generated image is adopted automatically when its shot has no image.** Multiple images for one shot, or a shot with existing media, retain a choice. Adopting one independent shot no longer incorrectly expires other shots' candidates.
- Build rough cuts per episode, reorder and trim clips, adjust volume and subtitles, and play video clips and stills continuously along the track.
- Preview and adopt Agent-proposed timeline changes. Configure aspect ratio, frame rate, narration, music, and subtitles for MP4 exports.

Export requires **FFmpeg** installed locally. Full end-to-end validation with real audio and video is still pending. Dreamina image generation uses the local CLI login; the Dreamina video executor is not integrated yet. A model listed in the catalog is not necessarily executable.

### Canvas: organize assets, dependencies, and versions

Use nodes for agents, images, audio, video, documents, and WebView content. Inspect dependencies and references while keeping candidates separate from adopted versions. Use Interaction Design for page prototypes and Visual Production for projects, storyboards, and editing timelines.

[Canvas documentation](./docs/extensions/canvas.md)

### Orchestration Factory: turn repeated tasks into reusable scenarios

Define steps, inputs, and acceptance criteria, run batches, and inspect past results. Configure models, review and evaluate output, optimize scenarios, and prepare deliveries. Changes and rollbacks retain version history so alternatives can be compared.

### Server Operations: connect, investigate, and act in one place

- Organize SSH, MySQL, PostgreSQL, Redis, and local SQLite connections by project.
- Access server overviews, terminals, systemd services, logs, remote files, transfers, and Docker.
- Browse databases and schemas, use the SQL workbench and query history, and run read-only diagnostics. Redis currently supports connections and read-only diagnostics.
- Grant Agent access by session and resource scope. Read-only grants expire and can be revoked; server writes require individual approval. Credentials are encrypted locally.

[Server Operations documentation](./docs/extensions/server-ops.md)

### API Workbench: retain reusable requests and execution evidence

- Manage collections, folders, requests, environments, variables, and authentication; import/export cURL and collections.
- Use HTTP/HTTPS, SSE, form and file bodies, shared signing/encryption configuration, and script-free assertions.
- Chain requests into scenarios with extracted variables. Inspect final requests, responses, phase timings, TLS details, and assertion results.
- Agent requests to send and save require separate approvals. Human-authored test cases are protected.

[API Workbench documentation](./docs/extensions/api-workbench.md)

## Project context and everyday tools

- **Workspace:** switch between the browser, files, and terminal. Declare project instructions in `AGENTS.md`; legacy `CLAUDE.md` remains compatible.
- **Knowledge and capabilities:** project knowledge, a separate Obsidian Vault entry, workspace Skills, and MCP keep reusable knowledge and tools with the project.
- **Productivity:** Todo, Calendar, and Automations handle tasks, schedules, and recurring runs. [Today Activity](./docs/extensions/today-activity.md) brings you back to sessions active today.
- **Desktop and remote access:** an in-app browser, file previews, voice input, light/dark themes, and configurable bot bridges.

Conversations and application settings are stored locally by default, under a configurable data root that defaults to `~/.DutyDeck/`. Project content retains its own storage boundaries. When you use cloud models or remote services, relevant inputs are sent to those configured services. Local-first does not mean every task runs offline.

## Models and execution

| Option | Used for | Setup |
| --- | --- | --- |
| Cloud APIs and compatible endpoints | Chat and Agent | Configure your own channels using OpenAI, Anthropic, Google, or compatible protocols |
| ChatGPT / xAI subscription authorization | Agent | Use the corresponding OAuth login and account permissions |
| DutyDeck local models | Agent | Built-in llama.cpp + GGUF; install the engine, download, load, test capabilities, then enable. Regular Chat currently excludes this provider |
| Image, video, and audio capabilities | Asset generation and media production | Configure media capabilities separately; execution depends on the available model, executor, and authorization shown in the UI |

Agent runs on **Pi Agent Runtime**, with workspace isolation, collaboration subtasks, permission modes, and session history. Tools have their own authorization rules: a Server Operations read-only grant does not constrain a regular Agent's shell or other tools.

DutyDeck includes no model API credits or subscriptions. Local models need suitable hardware, and media services may charge separately.

## Getting started

1. Download the package for your platform from [Releases](https://github.com/taokoplay/DutyDeck/releases/latest).
2. Configure model channels, or follow the DutyDeck Local Models page to install, test, and enable a local model.
3. Open or create an Agent project. Use the tools menu for design, media production, server operations, or API work, and configure the Skills / MCP you need.
4. Check production configuration before media tasks and install FFmpeg before exporting an edited video.

| Platform | Installer |
| --- | --- |
| macOS Apple Silicon | `DutyDeck-<version>-macos-arm64.dmg` |
| macOS Intel | `DutyDeck-<version>-macos-x64.dmg` |
| Windows x64 | `DutyDeck-<version>-windows-x64.exe` |
| Ubuntu / Debian x86_64 | `dutydeck_<version>_amd64.deb` |
| Linux x86_64 | `DutyDeck-<version>-linux-x86_64.AppImage` |

[Linux installation](./docs/linux.md) · [Migrating from Proma](./docs/migrations/2026-10-dutydeck-from-proma.md) · [Proma basics](https://github.com/proma-ai/Proma/tree/main/tutorial)

The upstream tutorial covers concepts such as Chat, Agent, Skills, and MCP; DutyDeck's extended workbenches follow its current UI. Legacy `~/.proma/`, project-level `.proma/`, and historical CLI/environment entries remain compatible. Confirm migrations through the client prompts.

## Interface previews

These existing repository screenshots include earlier versions. Use the descriptions above for current entry points and behavior.

<details>
<summary>Server Operations and API Workbench</summary>

### Server Operations

![DutyDeck server operations](./docs/assets/screenshots/dutydeck-server-ops-demo.png)

### API Workbench

![DutyDeck API workbench](./docs/assets/screenshots/dutydeck-api-workbench-demo.png)

</details>

<details>
<summary>Canvas, Chat, and Agent</summary>

### Canvas

![DutyDeck canvas](./docs/assets/screenshots/dutydeck-canvas-demo.png)

### Chat

![DutyDeck Chat](./docs/assets/screenshots/proma-chat-demo.png)

### Agent

![DutyDeck Agent](./docs/assets/screenshots/proma-agent-demo.png)

</details>

<details>
<summary>Skills, MCP, and voice input</summary>

![DutyDeck Skills](./docs/assets/screenshots/proma-skills-demo.png)

![DutyDeck MCP](./docs/assets/screenshots/proma-mcp-demo.png)

![DutyDeck voice input](./docs/assets/screenshots/proma-typeless-input.png)

</details>

## Origins and upstream relationship

Independent developers need uninterrupted time for their products, yet often switch between page design, assets, servers, databases, APIs, scripts, and documentation. DutyDeck brings those duties into one workbench with project context: **Duty is the work you are responsible for; Deck is the place to handle it.**

Thank you to [Proma](https://github.com/proma-ai/Proma) and [erlich.fun](https://erlich.fun) for the open-source foundation. DutyDeck continues to modify and extend inherited capabilities, selectively ports upstream changes, and independently maintains its design, media, orchestration, operations, and API tools. Its features and release schedule do not track official Proma releases one-to-one.

Since `0.20.0`, DutyDeck uses independent standard version numbers, with release tags in the form `v<app-version>`. Earlier `-bone.<build>` versions remain in the history. See [current release notes](./release-notes) and [historical Bone notes](./release-notes/bone).

## Development and contributions

This is a Bun monorepo: the desktop app lives in `apps/electron`, with shared packages in `packages/*`. The main stack is Electron, React, TypeScript, Jotai, Tailwind CSS, Radix UI, and Pi Agent Runtime. See [package.json](./apps/electron/package.json) and the lockfile for dependency versions.

```bash
bun install
bun run dev
bun run typecheck
bun test
bun run electron:build
```

Cover normal behavior and major boundaries when adding features. IPC changes must update shared types, main handlers, preload, and renderer calls together. Packaging requires runtime dependency checks and validation on the target platform; see [engineering conventions](./AGENTS.md). Issues, fixes, documentation, and reusable Skills are welcome.

Maintainer: [taokoplay](https://github.com/taokoplay). Thanks also to [Shiki](https://shiki.style/), [Beautiful Mermaid](https://github.com/lukilabs/beautiful-mermaid), [Mermaid](https://mermaid.js.org/), and the other open-source projects used here.

## License

DutyDeck is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0-only)](./LICENSE). This repository's `LICENSE` is byte-identical to upstream Proma and adds no extra restrictions.

**You may**: use, modify, distribute and commercially use DutyDeck and its derivatives, provided you comply with AGPL-3.0 — distributing source or modified forms, and offering the software over a network, both require publishing the complete corresponding source, and derivative works must stay under AGPL-3.0.

**Permanent open-source commitment**: every DutyDeck release is published under AGPL-3.0 in a public repository, and the corresponding source of any historical version remains obtainable. This repository neither collects nor accepts the right to relicense contributions under proprietary terms — nobody, maintainers included, can close this code.

**No commercial license exemption**: this project does not offer, and is not entitled to offer, an AGPL commercial exemption. For closed-source integration, comply with AGPL-3.0 yourself, or request a commercial license from the upstream Proma project that owns the copyright.

By submitting a Pull Request to DutyDeck you agree to license your contribution under AGPL-3.0-only to everyone; this project does not require you to transfer copyright.
