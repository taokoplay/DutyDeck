import type { PluginCapabilityId } from '@dutydeck/plugin-sdk'

/** 由宿主运行时构造的可信调用者身份，插件和模型不能自行提供。 */
export interface TrustedPluginCaller {
  pluginId: string
  pluginVersion: string
  packageHash: string
  moduleId: string
  sessionId: string
  projectId: string | null
  runId: string
  invocationId: string
  grants: readonly PluginCapabilityId[]
  /** 每次副作用提交前复核运行、版本和模块租约。 */
  assertCurrent: () => void
}

/** 一个宿主能力的受信实现。 */
export interface HostCapabilityProvider {
  readonly id: PluginCapabilityId
  invoke(input: {
    request: unknown
    caller: TrustedPluginCaller
    signal: AbortSignal
  }): Promise<unknown>
}

/** Broker 构造依赖；provider 只允许宿主注册。 */
export interface CapabilityBrokerOptions {
  providers: ReadonlyMap<PluginCapabilityId, HostCapabilityProvider['invoke']>
  maxInputBytes?: number
  maxOutputBytes?: number
}

/** 可公开展示的稳定 Broker 错误。 */
export class PluginCapabilityBrokerError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'PluginCapabilityBrokerError'
  }
}

/** 判断数据能否安全通过进程边界。 */
function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  const valid = Array.isArray(value)
    ? value.every(item => isJsonValue(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype && Object.values(value as Record<string, unknown>).every(item => isJsonValue(item, seen))
  seen.delete(value)
  return valid
}

/** 统一检查 JSON 与 UTF-8 字节预算。 */
function assertBudget(value: unknown, limit: number, code: string): void {
  if (!isJsonValue(value)) throw new PluginCapabilityBrokerError('PLUGIN_CAPABILITY_RESULT_NOT_JSON')
  let encoded: string
  try {
    encoded = JSON.stringify(value)
  } catch {
    throw new PluginCapabilityBrokerError('PLUGIN_CAPABILITY_RESULT_NOT_JSON')
  }
  if (Buffer.byteLength(encoded) > limit) throw new PluginCapabilityBrokerError(code)
}

/**
 * 把插件请求转发给宿主注册的能力实现。
 * 授权、调用者身份、取消和输出预算均在宿主侧完成。
 */
export class CapabilityBroker {
  private readonly providers: ReadonlyMap<PluginCapabilityId, HostCapabilityProvider['invoke']>
  private readonly maxInputBytes: number
  private readonly maxOutputBytes: number

  constructor(options: CapabilityBrokerOptions) {
    this.providers = options.providers
    this.maxInputBytes = Math.min(4 * 1024 * 1024, Math.max(1, options.maxInputBytes ?? 1024 * 1024))
    this.maxOutputBytes = Math.min(8 * 1024 * 1024, Math.max(1, options.maxOutputBytes ?? 1024 * 1024))
  }

  /** 调用一个已授权能力；调用者参数只能由宿主构造。 */
  async invoke(
    caller: TrustedPluginCaller,
    request: { capability: PluginCapabilityId; input: unknown },
  ): Promise<unknown> {
    if (!caller.grants.includes(request.capability)) {
      throw new PluginCapabilityBrokerError('PLUGIN_CAPABILITY_NOT_GRANTED')
    }
    const provider = this.providers.get(request.capability)
    if (!provider) throw new PluginCapabilityBrokerError('PLUGIN_CAPABILITY_NOT_AVAILABLE')
    try {
      caller.assertCurrent()
    } catch {
      throw new PluginCapabilityBrokerError('PLUGIN_CAPABILITY_STALE')
    }
    assertBudget(request.input, this.maxInputBytes, 'PLUGIN_CAPABILITY_INPUT_TOO_LARGE')
    const controller = new AbortController()
    let result: unknown
    try {
      result = await provider({ request: request.input, caller, signal: controller.signal })
    } catch {
      throw new PluginCapabilityBrokerError('PLUGIN_CAPABILITY_FAILED')
    }
    try {
      caller.assertCurrent()
    } catch {
      throw new PluginCapabilityBrokerError('PLUGIN_CAPABILITY_STALE')
    }
    assertBudget(result, this.maxOutputBytes, 'PLUGIN_CAPABILITY_RESULT_TOO_LARGE')
    return result
  }
}
