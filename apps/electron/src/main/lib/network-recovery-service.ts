import { getServers } from 'node:dns'
import { networkInterfaces } from 'node:os'
import { powerMonitor } from 'electron'
import { networkDiagnostics } from './network-diagnostics'
import type {
  NetworkRecoveryNotice,
  NetworkRecoveryReason,
  NetworkRecoveryStatus,
} from '@dutydeck/shared'
import { getRecoveryProxyUrl, invalidateSystemProxyCache } from './proxy-settings-service'

const NETWORK_SAMPLE_INTERVAL_MS = 5_000
const NETWORK_CHANGE_DEBOUNCE_MS = 300
const NETWORK_RECOVERY_COOLDOWN_MS = 5_000

/** 系统恢复事件的最小依赖边界。 */
export interface NetworkRecoveryResumeSource {
  /** 注册系统恢复监听器。 */
  on(event: 'resume', listener: () => void): unknown
  /** 注销系统恢复监听器。 */
  off(event: 'resume', listener: () => void): unknown
}

/** 网络恢复服务的可替换依赖，用于隔离时钟与系统状态测试。 */
export interface NetworkRecoveryServiceDependencies {
  /** 读取只含本机接口与 DNS 的稳定签名。 */
  readNetworkSignature: () => string
  /** 失效系统代理缓存。 */
  invalidateProxyCache: () => void
  /** 解析当前真正生效的代理；undefined 表示明确直连。 */
  resolveProxyUrl: () => Promise<string | undefined>
  /** 系统睡眠恢复事件源。 */
  resumeSource: NetworkRecoveryResumeSource
  /** 单调时钟。 */
  now: () => number
  /** 登记一次性任务。 */
  setTimeout: (callback: () => void, delayMs: number) => unknown
  /** 清理一次性任务。 */
  clearTimeout: (handle: unknown) => void
  /** 登记周期任务。 */
  setInterval: (callback: () => void, intervalMs: number) => unknown
  /** 清理周期任务。 */
  clearInterval: (handle: unknown) => void
  /** 隔离恢复故障的日志出口。 */
  reportError?: (message: string, error: unknown) => void
  /** 成功发布代次时只记录脱敏分类。 */
  recordRecovery?: () => void
}

/** 保留既有应用代理优先、环境代理兜底的合同，不复用旧query注入的环境快照。 */
export function resolveRecoveryProxyEnvironment(configuredProxy: string | undefined, environment: NodeJS.ProcessEnv): string | undefined {
  if (configuredProxy?.trim()) return configuredProxy.trim()
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY']) {
    /** 大小写候选都检查，空白值不能遮蔽有效候选。 */
    const candidates = [key, ...Object.keys(environment).filter(name => name !== key && name.toLowerCase() === key.toLowerCase())]
    for (const name of candidates) {
      const value = environment[name]?.trim()
      if (value) return value
    }
  }
  return undefined
}

/** 生成仅驻留内存的本机网络签名，不发起任何外网请求。 */
function readLocalNetworkSignature(): string {
  /** 过滤回环并排序后的接口地址。 */
  const interfaces = Object.entries(networkInterfaces())
    .flatMap(([name, addresses]) => (addresses ?? [])
      .filter((address) => !address.internal)
      .map((address) => `${name}\u0000${address.family}\u0000${address.address}\u0000${address.netmask}`))
    .sort()
  /** 排序后的系统 DNS 服务器。 */
  const dnsServers = [...getServers()].sort()
  return JSON.stringify({ interfaces, dnsServers })
}

/**
 * 管理网络代次、系统代理刷新和自动恢复节流。
 *
 * epoch=0 表示尚未解析；epoch>0 且 proxyUrl=undefined 表示已经确认直连。
 */
export class NetworkRecoveryService {
  /** 当前公开状态。 */
  private status: NetworkRecoveryStatus = { epoch: 0 }
  /** 最近一次成功解析的跨进程快照。 */
  private snapshot: NetworkRecoveryNotice | undefined
  /** 恢复通知监听器。 */
  private readonly listeners = new Set<(notice: NetworkRecoveryNotice) => void>()
  /** 服务是否正在监测。 */
  private started = false
  /** 上一次本机网络签名。 */
  private networkSignature: string | undefined
  /** 五秒采样任务。 */
  private sampleTimer: unknown
  /** 300ms 合并任务。 */
  private debounceTimer: unknown
  /** 冷却期末尾任务。 */
  private trailingTimer: unknown
  /** 合并期间最后收到的恢复原因。 */
  private pendingReason: NetworkRecoveryReason | undefined
  /** 下一次自动恢复允许执行的单调时间。 */
  private cooldownUntil = 0
  /** 串行化显式与自动恢复，防止慢检测覆盖后发结果。 */
  private recoveryChain: Promise<void> = Promise.resolve()
  /** stop令已排队及执行中的任务失效，避免迟到通知复活旧query。 */
  private lifecycleGeneration = 0

  constructor(private readonly dependencies: NetworkRecoveryServiceDependencies) {}

  /** 返回当前公开状态的副本。 */
  getStatus(): NetworkRecoveryStatus {
    return { ...this.status }
  }

  /** 返回最近成功解析的通知副本；未初始化时返回 undefined。 */
  getSnapshot(): NetworkRecoveryNotice | undefined {
    return this.snapshot ? { ...this.snapshot } : undefined
  }

  /** 订阅恢复通知，并返回幂等取消函数。 */
  subscribe(listener: (notice: NetworkRecoveryNotice) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 启动本机五秒采样与系统恢复监听。 */
  start(): void {
    if (this.started) return
    this.started = true
    this.networkSignature = this.readSignatureSafely()
    this.sampleTimer = this.dependencies.setInterval(() => { this.sampleNetwork() }, NETWORK_SAMPLE_INTERVAL_MS)
    this.dependencies.resumeSource.on('resume', this.handleResume)
  }

  /** 停止采样并清除尚未执行的合并/尾随恢复。 */
  stop(): void {
    this.lifecycleGeneration += 1
    if (!this.started) return
    this.started = false
    this.dependencies.resumeSource.off('resume', this.handleResume)
    if (this.sampleTimer !== undefined) this.dependencies.clearInterval(this.sampleTimer)
    if (this.debounceTimer !== undefined) this.dependencies.clearTimeout(this.debounceTimer)
    if (this.trailingTimer !== undefined) this.dependencies.clearTimeout(this.trailingTimer)
    this.sampleTimer = undefined
    this.debounceTimer = undefined
    this.trailingTimer = undefined
    this.pendingReason = undefined
    this.cooldownUntil = 0
  }

  /** 刷新系统代理并发布新的网络代次；检测故障保持旧状态且不向调用方抛错。 */
  requestRecovery(reason: NetworkRecoveryReason): Promise<NetworkRecoveryStatus> {
    /** 未启动时仍支持显式恢复；任何后续stop都会使旧任务失效。 */
    const generation = this.lifecycleGeneration
    /** 排入串行链的本次恢复。 */
    const recovery = this.recoveryChain.then(async () => await this.performRecovery(reason, generation))
    this.recoveryChain = recovery.then(() => {}, () => {})
    return recovery
  }

  /** 系统恢复事件只登记自动恢复，不在事件回调中执行系统命令。 */
  private readonly handleResume = (): void => { this.scheduleAutomaticRecovery('resume') }

  /** 安全读取本机网络签名；读取失败不终止主进程。 */
  private readSignatureSafely(): string | undefined {
    try {
      return this.dependencies.readNetworkSignature()
    } catch (error) {
      this.reportError('读取本机网络状态失败', error)
      return undefined
    }
  }

  /** 比较周期采样结果，仅在真实变化时排队恢复。 */
  private sampleNetwork(): void {
    if (!this.started) return
    /** 本次接口与 DNS 签名。 */
    const nextSignature = this.readSignatureSafely()
    if (nextSignature === undefined) return
    if (this.networkSignature === undefined) {
      this.networkSignature = nextSignature
      return
    }
    if (nextSignature === this.networkSignature) return
    this.networkSignature = nextSignature
    this.scheduleAutomaticRecovery('interface')
  }

  /** 合并短时间内的多个系统信号，保留最后一个原因。 */
  private scheduleAutomaticRecovery(reason: NetworkRecoveryReason): void {
    if (!this.started) return
    this.pendingReason = reason
    if (this.debounceTimer !== undefined) this.dependencies.clearTimeout(this.debounceTimer)
    this.debounceTimer = this.dependencies.setTimeout(() => {
      this.debounceTimer = undefined
      this.flushAutomaticRecovery()
    }, NETWORK_CHANGE_DEBOUNCE_MS)
  }

  /** 在冷却期结束时执行一次尾随恢复，确保最终网络状态不会丢失。 */
  private flushAutomaticRecovery(): void {
    if (!this.started || this.pendingReason === undefined) return
    /** 当前冷却期剩余时间。 */
    const remainingMs = Math.max(0, this.cooldownUntil - this.dependencies.now())
    if (remainingMs > 0) {
      if (this.trailingTimer !== undefined) this.dependencies.clearTimeout(this.trailingTimer)
      this.trailingTimer = this.dependencies.setTimeout(() => {
        this.trailingTimer = undefined
        this.flushAutomaticRecovery()
      }, remainingMs)
      return
    }
    /** 本次合并后的最终恢复原因。 */
    const reason = this.pendingReason
    this.pendingReason = undefined
    this.cooldownUntil = this.dependencies.now() + NETWORK_RECOVERY_COOLDOWN_MS
    void this.requestRecovery(reason)
  }

  /** 执行一次真实代理刷新，并在成功后广播不可变通知。 */
  private async performRecovery(reason: NetworkRecoveryReason, generation: number): Promise<NetworkRecoveryStatus> {
    if (generation !== this.lifecycleGeneration) return this.getStatus()
    try {
      this.dependencies.invalidateProxyCache()
      /** 刷新缓存后解析出的有效代理，undefined 是明确直连。 */
      const proxyUrl = await this.dependencies.resolveProxyUrl()
      if (generation !== this.lifecycleGeneration) return this.getStatus()
      /** 发布前保留的旧快照。 */
      const previous = this.snapshot
      /** 新的单调网络代次。 */
      const epoch = this.status.epoch + 1
      /** 本次恢复的公开时间。 */
      const lastChangedAt = Date.now()
      /** 供 utility 精确采用的不可变通知。 */
      const notice: NetworkRecoveryNotice = {
        epoch,
        lastChangedAt,
        reason,
        ...(previous ? { previousProxyUrl: previous.proxyUrl } : {}),
        proxyUrl,
      }
      this.status = { epoch, lastChangedAt, reason }
      this.snapshot = notice
      try { this.dependencies.recordRecovery?.() } catch { /* 诊断不得改变已确认恢复。 */ }
      for (const listener of this.listeners) {
        try {
          listener({ ...notice })
        } catch (error) {
          this.reportError('网络恢复监听器执行失败', error)
        }
      }
      return { ...this.status }
    } catch (error) {
      this.reportError('刷新网络代理失败', error)
      return { ...this.status }
    }
  }

  /** 统一隔离日志依赖，测试无需污染标准错误输出。 */
  private reportError(message: string, error: unknown): void {
    ;(this.dependencies.reportError ?? ((text, cause) => { console.warn(`[网络恢复] ${text}:`, cause) }))(message, error)
  }
}

/** 默认系统依赖；定时器句柄保持不透明以兼容浏览器和 Node 类型。 */
const defaultDependencies: NetworkRecoveryServiceDependencies = {
  readNetworkSignature: readLocalNetworkSignature,
  invalidateProxyCache: invalidateSystemProxyCache,
  resolveProxyUrl: async () => resolveRecoveryProxyEnvironment(await getRecoveryProxyUrl(), process.env),
  recordRecovery: () => networkDiagnostics.record({ phase: 'recovery', code: 'network_changed' }),
  resumeSource: powerMonitor,
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

/** 主进程共享的网络恢复服务。 */
export const networkRecoveryService = new NetworkRecoveryService(defaultDependencies)
