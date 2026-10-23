# DutyDeck 可执行插件工程

该工程使用 V3 `module-runtime` 合同，包含一个模块、Agent 工具、右侧 Surface、懒启动服务和提示资源。

```bash
bun install
bun run validate
bun run test
bun run build
bun run pack
```

Runtime 在宿主 utility 进程中运行，能力必须通过公开 SDK 申请。项目/工作区 Skill 不在插件包内复制。
