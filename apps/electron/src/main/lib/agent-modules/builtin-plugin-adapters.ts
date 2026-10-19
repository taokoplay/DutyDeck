import type { AgentModuleManifest, AgentPluginManifest } from '@dutydeck/shared'
import { listBuiltinAgentModules } from './module-registry'
import type { AgentPluginHostContext, AgentPluginHostRegistration } from './plugin-host'

export interface BuiltinAgentPluginAdapter {
  /** 启动适配器绑定的现有服务；未提供时只完成宿主状态切换。 */
  start?: (context: AgentPluginHostContext) => void | Promise<void>
  /** 停止适配器绑定的现有服务；不得拥有全局服务的重复释放权。 */
  stop?: (context: AgentPluginHostContext) => void | Promise<void>
  /** 释放适配器自身监听器和缓存。 */
  dispose?: (context: AgentPluginHostContext) => void | Promise<void>
}

/**
 * 创建内置模块的 Plugin Host 注册项。
 *
 * 模块业务仍由既有 IPC/tool provider 提供；这里仅建立生命周期边界，必要时由
 * 上层注入服务适配器。这样可以逐步把模块迁移到插件模式，同时不复制业务实现。
 * @param modules 内置模块清单。
 * @param adapters 按模块 ID 注入的服务生命周期适配器。
 * @returns 可直接交给 AgentPluginHost 的注册项。
 */
export function createBuiltinAgentPluginRegistrations(
  modules: readonly AgentModuleManifest[] = listBuiltinAgentModules(),
  adapters: Readonly<Record<string, BuiltinAgentPluginAdapter>> = {},
): AgentPluginHostRegistration[] {
  return modules.map((module) => {
    const manifest: AgentPluginManifest = {
      id: `builtin.${module.id}`,
      version: module.version,
      apiVersion: 1,
      displayName: module.displayName,
      description: module.description,
      modules: [cloneModule(module)],
      entry: { kind: 'manifest-only' },
    }
    const adapter = adapters[module.id]
    return {
      manifest,
      lifecycle: {
        start: adapter?.start,
        stop: adapter?.stop,
        dispose: adapter?.dispose,
      },
    }
  })
}

function cloneModule(module: AgentModuleManifest): AgentModuleManifest {
  return {
    ...module,
    contributions: [...module.contributions],
    skillRefs: [...module.skillRefs],
    promptRefs: [...module.promptRefs],
    toolRefs: [...module.toolRefs],
    artifactTypes: [...module.artifactTypes],
    surfaceIds: [...module.surfaceIds],
    requiredPermissions: [...module.requiredPermissions],
  }
}
