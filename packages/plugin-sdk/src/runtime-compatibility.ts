import { PLUGIN_RUNTIME_PROTOCOL_VERSION } from './runtime-protocol.js'
import type { PluginV3Manifest } from './v3.js'

/** 旧包保留只读解析/管理能力，但不能在新的调用级状态合同下执行。 */
export function getPluginRuntimeExecutionBlock(manifest: PluginV3Manifest): 'PLUGIN_RUNTIME_CONTRACT_MIGRATION_REQUIRED' | undefined {
  return manifest.compatibility.runtimeProtocol === PLUGIN_RUNTIME_PROTOCOL_VERSION
    ? undefined : 'PLUGIN_RUNTIME_CONTRACT_MIGRATION_REQUIRED'
}

/** 在创建运行实例之前检查执行合同；版本1必须由作者迁移，不自动改签旧包。 */
export function assertPluginRuntimeCompatibility(manifest: PluginV3Manifest): void {
  const block = getPluginRuntimeExecutionBlock(manifest)
  if (block) throw new Error(block)
}
