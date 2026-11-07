import type { AgentSessionModulePolicy } from '@dutydeck/shared'
import { isPluginCapabilityId } from '@dutydeck/plugin-sdk'
import { PluginCapabilityBrokerError } from './capability-broker'
import type { CapabilityBroker } from './capability-broker'
import type { ManagedRuntimePlugin, ModuleRuntimeManagerOptions } from './module-runtime-manager'
import type { PluginRuntimeSupervisorDependencies } from './runtime-supervisor'
import type { PluginGrantStore } from './plugin-grant-store'
import { assertPluginRunModule } from './plugin-run-binding'
import { isPluginModuleAttached } from './plugin-session-access'
import { assertPluginCapabilityPolicy } from './plugin-runtime-policy'

/** 生产组合根提供权威会话/运行/授权读口；工厂不缓存这些可撤销事实。 */
export interface PluginExecutionAuthority {
  grants: () => Pick<PluginGrantStore, 'assertGranted'>
  getSession: (sessionId: string) => { workspaceId?: string | null; archived?: boolean; permissionMode?: string } | null | undefined
  getPolicy: (sessionId: string) => AgentSessionModulePolicy
  getActiveRunGeneration: (sessionId: string) => number | undefined
}

/** Pi审批后、加载任何Node代码之前的生产执行门禁。 */
export function createPluginExecutionAccess(authority: PluginExecutionAuthority): NonNullable<ModuleRuntimeManagerOptions['assertExecutionAccess']> {
  return (plugin, context) => {
    authority.grants().assertGranted({ pluginId: plugin.manifest.id, pluginVersion: plugin.manifest.version, packageHash: plugin.packageHash }, context.projectId)
    const session = authority.getSession(context.sessionId)
    if (!session || session.archived || (session.workspaceId ?? null) !== context.projectId) throw new Error('PLUGIN_CAPABILITY_STALE')
    // 第三方Node代码不因自报readOnly而获得计划模式执行资格。
    if (session.permissionMode === 'plan') throw new Error('PLUGIN_CAPABILITY_READ_ONLY')
    const module = plugin.manifest.modules.find(item => item.id === context.moduleId)
    if (!module) throw new Error('PLUGIN_CAPABILITY_STALE')
    const moduleIdentity = { moduleId: context.moduleId, moduleVersion: plugin.manifest.version, packageHash: plugin.packageHash }
    const policy = authority.getPolicy(context.sessionId)
    if (context.runId) assertPluginRunModule(context.sessionId, context.runId, moduleIdentity, policy)
    else if (policy.disabledModuleIds.includes(context.moduleId) || !context.readOnly && !isPluginModuleAttached(moduleIdentity, policy)) throw new Error('PLUGIN_CAPABILITY_STALE')
  }
}

/** 与ipc.ts共用的能力调用/提交门禁，保留精确grant revision与动态租约检查。 */
export function createPluginCapabilityHandler(
  plugin: ManagedRuntimePlugin,
  broker: CapabilityBroker,
  authority: PluginExecutionAuthority,
): NonNullable<PluginRuntimeSupervisorDependencies['onCapabilityRequest']> {
  return async (request) => {
    if (!isPluginCapabilityId(request.capability)) return { ok: false, code: 'PLUGIN_CAPABILITY_NOT_AVAILABLE', message: '宿主不支持该能力', retryable: false }
    const capability = request.capability
    const identity = { pluginId: request.pluginId, pluginVersion: request.pluginVersion, packageHash: request.packageHash }
    try {
      const grant = authority.grants().assertGranted(identity, request.projectId)
      const assertCurrent = (): void => {
        request.assertCurrent()
        const current = authority.grants().assertGranted(identity, request.projectId)
        if (current.revision !== grant.revision) throw new Error('PLUGIN_CAPABILITY_STALE')
        let readOnly = request.readOnly === true
        if (request.sessionId) {
          const session = authority.getSession(request.sessionId)
          if (!session || session.archived || (session.workspaceId ?? null) !== request.projectId) throw new Error('PLUGIN_CAPABILITY_STALE')
          readOnly ||= session.permissionMode === 'plan'
          if (request.readOnly === null) {
            const generation = authority.getActiveRunGeneration(request.sessionId)
            if (generation === undefined || request.runId !== `${request.sessionId}:${generation}`) throw new Error('PLUGIN_CAPABILITY_STALE')
          }
          if (!request.moduleId || !plugin.manifest.modules.some(item => item.id === request.moduleId)) throw new Error('PLUGIN_CAPABILITY_STALE')
          const moduleIdentity = { moduleId: request.moduleId, moduleVersion: plugin.manifest.version, packageHash: plugin.packageHash }
          const policy = authority.getPolicy(request.sessionId)
          if (request.readOnly === null) assertPluginRunModule(request.sessionId, request.runId ?? '', moduleIdentity, policy)
          else if (policy.disabledModuleIds.includes(request.moduleId) || !readOnly && !isPluginModuleAttached(moduleIdentity, policy)) throw new Error('PLUGIN_CAPABILITY_STALE')
        }
        assertPluginCapabilityPolicy(capability, readOnly)
      }
      assertCurrent()
      const caller = {
        pluginId: request.pluginId, pluginVersion: request.pluginVersion, packageHash: request.packageHash,
        moduleId: request.moduleId ?? '', sessionId: request.sessionId ?? '', projectId: request.projectId,
        runId: request.runId ?? 'plugin-instance', invocationId: request.invocationId ?? 'plugin-instance',
        grants: grant.capabilities.filter(item => plugin.manifest.capabilities.includes(item)),
        signal: request.signal, assertCurrent,
      }
      return { ok: true, value: await broker.invoke(caller, { capability, input: request.input }) }
    } catch (error) {
      return { ok: false, code: error instanceof PluginCapabilityBrokerError ? error.code
        : error instanceof Error && /^PLUGIN_[A-Z0-9_]+$/.test(error.message) ? error.message : 'PLUGIN_CAPABILITY_FAILED',
      message: '插件能力调用失败', retryable: false }
    }
  }
}
