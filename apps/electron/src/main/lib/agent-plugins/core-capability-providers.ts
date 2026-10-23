import type { PluginCapabilityId } from '@dutydeck/plugin-sdk'
import type { HostCapabilityProvider } from './capability-broker'
import type { PluginStateStore } from './plugin-state-store'

/** 核心 provider 需要的宿主只读权限。 */
export interface CoreCapabilityProviderOptions {
  state: PluginStateStore
  getSession: (sessionId: string) => {
    id: string
    workspaceId?: string
    archived: boolean
  } | undefined
}

/** 解析插件状态输入，拒绝路径、原型和额外字段。 */
function stateInput(value: unknown, write: boolean): {
  key: string
  schemaVersion: number
  value?: unknown
  expectedRevision?: number
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PLUGIN_STATE_INPUT_INVALID')
  const record = value as Record<string, unknown>
  if (typeof record.key !== 'string' || !Number.isSafeInteger(record.schemaVersion)) throw new Error('PLUGIN_STATE_INPUT_INVALID')
  if (write && !Object.hasOwn(record, 'value')) throw new Error('PLUGIN_STATE_INPUT_INVALID')
  if (record.expectedRevision !== undefined && (!Number.isSafeInteger(record.expectedRevision) || Number(record.expectedRevision) < 0)) {
    throw new Error('PLUGIN_STATE_INPUT_INVALID')
  }
  const allowed = write ? ['key', 'schemaVersion', 'value', 'expectedRevision'] : ['key', 'schemaVersion']
  if (Object.keys(record).some(key => !allowed.includes(key))) throw new Error('PLUGIN_STATE_INPUT_INVALID')
  return {
    key: record.key,
    schemaVersion: Number(record.schemaVersion),
    ...(write ? { value: record.value } : {}),
    ...(typeof record.expectedRevision === 'number' ? { expectedRevision: record.expectedRevision } : {}),
  }
}

/** 构造基础宿主能力；未列出能力由后续受信 provider 显式注册。 */
export function createCoreCapabilityProviders(
  options: CoreCapabilityProviderOptions,
): ReadonlyMap<PluginCapabilityId, HostCapabilityProvider['invoke']> {
  return new Map<PluginCapabilityId, HostCapabilityProvider['invoke']>([
    ['session.read', async ({ caller }) => {
      const session = options.getSession(caller.sessionId)
      if (!session) throw new Error('SESSION_NOT_FOUND')
      return { id: session.id, workspaceId: session.workspaceId, archived: session.archived }
    }],
    ['plugin.state.read', async ({ caller, request }) => {
      const input = stateInput(request, false)
      return options.state.read(caller.pluginId, input.key, input.schemaVersion)
    }],
    ['plugin.state.write', async ({ caller, request }) => {
      const input = stateInput(request, true)
      return options.state.write(caller.pluginId, input.key, input.schemaVersion, input.value, input.expectedRevision)
    }],
  ])
}
