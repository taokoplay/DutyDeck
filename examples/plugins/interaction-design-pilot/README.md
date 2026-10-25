# 交互设计插件试点

这是与宿主内置交互设计模块并存的 V3 `module-runtime` 试点插件。

它使用宿主的通用项目产物和只读源码能力，提供创建原型、提交页面候选、采纳候选和右侧 Surface。正式数据写入项目内 `.dutydeck/plugin-artifacts/dutydeck.interaction-design-pilot/`；旧模块继续使用 `.proma/interaction-design/`，两类数据互不覆盖。

```bash
bun install
bun run build
bun test
bun run validate
```
