import type { PluginRuntimeContext, PluginToolCallContext, PluginSurfaceCallContext } from '../src/runtime-api.js'

/** 只编译不执行：实例只读，写入只能经精确调用上下文。 */
export function assertRuntimeStateTypes(context: PluginRuntimeContext, tool: PluginToolCallContext, surface: PluginSurfaceCallContext): void {
  void context.state.read('boot')
  void context.state.readRecord('boot')
  // @ts-expect-error 实例上下文不得提供写入入口。
  void context.state.write('boot', {}, { schemaVersion: 1 })
  void tool.state.write('tool', {}, { schemaVersion: 1 })
  void surface.state.write('surface', {}, { schemaVersion: 1 })
}
