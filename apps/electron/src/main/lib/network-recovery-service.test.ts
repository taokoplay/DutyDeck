import { afterAll, describe, expect, mock, test } from 'bun:test'
import type { NetworkRecoveryNotice } from '@dutydeck/shared'
import type { NetworkRecoveryService as NetworkRecoveryServiceInstance, NetworkRecoveryServiceDependencies } from './network-recovery-service'

/** Bun 测试环境中的最小 Electron powerMonitor 替身。 */
const defaultPowerMonitor = { on: () => {}, off: () => {} }
mock.module('electron', () => ({ powerMonitor: defaultPowerMonitor }))

/** Electron 替身登记后再加载被测服务。 */
const { NetworkRecoveryService, resolveRecoveryProxyEnvironment } = await import('./network-recovery-service')

afterAll(() => { mock.restore() })

/** 可手动推进的单调时钟，避免恢复节流测试依赖真实等待。 */
class ManualClock {
  /** 当前单调时间。 */
  private currentTime = 0
  /** 下一个定时器标识。 */
  private nextId = 1
  /** 尚未执行的定时任务。 */
  private readonly tasks = new Map<number, { at: number; callback: () => void; intervalMs?: number }>()

  /** 返回当前单调时间。 */
  now = (): number => this.currentTime

  /** 登记一次性定时任务。 */
  setTimeout = (callback: () => void, delayMs: number): unknown => this.add(callback, delayMs)

  /** 登记周期定时任务。 */
  setInterval = (callback: () => void, intervalMs: number): unknown => this.add(callback, intervalMs, intervalMs)

  /** 清除一次性或周期定时任务。 */
  clearTimer = (handle: unknown): void => {
    if (typeof handle === 'number') this.tasks.delete(handle)
  }

  /** 推进时钟并执行截止时间内的任务。 */
  async advance(ms: number): Promise<void> {
    /** 本次推进的目标时间。 */
    const target = this.currentTime + ms
    while (true) {
      /** 按时间和标识稳定选取下一项。 */
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort(([leftId, left], [rightId, right]) => left.at - right.at || leftId - rightId)[0]
      if (!next) break
      /** 当前执行的定时器标识与任务。 */
      const [id, task] = next
      this.currentTime = task.at
      if (task.intervalMs === undefined) this.tasks.delete(id)
      else task.at += task.intervalMs
      task.callback()
      await Promise.resolve()
      await Promise.resolve()
    }
    this.currentTime = target
    await Promise.resolve()
    await Promise.resolve()
  }

  /** 添加定时任务并返回不透明标识。 */
  private add(callback: () => void, delayMs: number, intervalMs?: number): number {
    /** 新任务的唯一标识。 */
    const id = this.nextId++
    this.tasks.set(id, { at: this.currentTime + delayMs, callback, ...(intervalMs === undefined ? {} : { intervalMs }) })
    return id
  }
}

/** 可观察注册和注销次数的系统恢复事件源。 */
class ResumeSource {
  /** 当前恢复监听器。 */
  private readonly listeners = new Set<() => void>()

  /** 注册系统恢复监听器。 */
  on = (_event: 'resume', listener: () => void): void => { this.listeners.add(listener) }

  /** 注销系统恢复监听器。 */
  off = (_event: 'resume', listener: () => void): void => { this.listeners.delete(listener) }

  /** 模拟系统从睡眠恢复。 */
  emit(): void { for (const listener of this.listeners) listener() }

  /** 返回当前监听器数量。 */
  size(): number { return this.listeners.size }
}

/** 创建可确定控制的网络恢复服务依赖。 */
function createFixture(): {
  service: NetworkRecoveryServiceInstance
  clock: ManualClock
  resumeSource: ResumeSource
  setSignature: (value: string) => void
  setProxyUrl: (value: string | undefined) => void
  invalidations: () => number
} {
  /** 测试单调时钟。 */
  const clock = new ManualClock()
  /** 测试系统恢复事件源。 */
  const resumeSource = new ResumeSource()
  /** 当前本机网络签名。 */
  let signature = 'network-a'
  /** 当前解析出的有效代理。 */
  let proxyUrl: string | undefined = 'http://127.0.0.1:7890'
  /** 系统代理缓存失效次数。 */
  let invalidationCount = 0
  /** 服务使用的可替换依赖。 */
  const dependencies: NetworkRecoveryServiceDependencies = {
    readNetworkSignature: () => signature,
    invalidateProxyCache: () => { invalidationCount += 1 },
    resolveProxyUrl: async () => proxyUrl,
    resumeSource,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimer,
    setInterval: clock.setInterval,
    clearInterval: clock.clearTimer,
  }
  return {
    service: new NetworkRecoveryService(dependencies),
    clock,
    resumeSource,
    setSignature: (value) => { signature = value },
    setProxyUrl: (value) => { proxyUrl = value },
    invalidations: () => invalidationCount,
  }
}

describe('NetworkRecoveryService', () => {
  test('Given current process proxy environment When resolving recovery Then keeps priority and explicit configured proxy', () => {
    expect(resolveRecoveryProxyEnvironment(undefined, { https_proxy: ' http://env:1 ', HTTP_PROXY: 'http://other:2' })).toBe('http://env:1')
    expect(resolveRecoveryProxyEnvironment('http://manual:3', { HTTPS_PROXY: 'http://env:1' })).toBe('http://manual:3')
    expect(resolveRecoveryProxyEnvironment(undefined, { HTTPS_PROXY: ' ', HTTP_PROXY: 'http://fallback:4' })).toBe('http://fallback:4')
    expect(resolveRecoveryProxyEnvironment(undefined, {})).toBeUndefined()
  })

  test('Given pending and queued recoveries When stopped Then old lifecycle cannot resolve or broadcast after restart', async () => {
    const fixture = createFixture()
    /** 暂停首次代理检测，确保stop发生在await之后。 */
    let resolveProxy: (value: string | undefined) => void = () => { throw new Error('尚未进入代理检测') }
    let resolutions = 0
    const service = new NetworkRecoveryService({ readNetworkSignature: () => 'network', invalidateProxyCache: () => {},
      resolveProxyUrl: () => { resolutions++; return resolutions === 1 ? new Promise((resolve) => { resolveProxy = resolve }) : Promise.resolve('http://stale:2') },
      resumeSource: fixture.resumeSource, now: fixture.clock.now, setTimeout: fixture.clock.setTimeout,
      clearTimeout: fixture.clock.clearTimer, setInterval: fixture.clock.setInterval, clearInterval: fixture.clock.clearTimer })
    const notices: NetworkRecoveryNotice[] = []
    service.subscribe(notice => notices.push(notice))
    service.start()
    const first = service.requestRecovery('resume')
    await Promise.resolve()
    const queued = service.requestRecovery('online')
    service.stop()
    service.start()
    resolveProxy('http://stale:1')
    await Promise.all([first, queued])
    expect(resolutions).toBe(1)
    expect(notices).toEqual([])
    expect(service.getStatus().epoch).toBe(0)
    service.stop()
  })

  test('Given no resolved network state When reading the snapshot Then epoch zero remains distinguishable from direct mode', () => {
    /** 尚未启动恢复的服务。 */
    const fixture = createFixture()

    expect(fixture.service.getStatus()).toEqual({ epoch: 0 })
    expect(fixture.service.getSnapshot()).toBeUndefined()
  })

  test('Given proxy changes to direct mode When recovery succeeds Then publishes an epoch-tagged explicit undefined proxy', async () => {
    /** 具备可变代理结果的服务。 */
    const fixture = createFixture()
    /** 服务发布的恢复通知。 */
    const notices: NetworkRecoveryNotice[] = []
    fixture.service.subscribe((notice) => { notices.push(notice) })

    await fixture.service.requestRecovery('manual')
    fixture.setProxyUrl(undefined)
    await fixture.service.requestRecovery('proxy-settings')

    expect(notices).toEqual([
      { epoch: 1, lastChangedAt: expect.any(Number), reason: 'manual', proxyUrl: 'http://127.0.0.1:7890' },
      { epoch: 2, lastChangedAt: expect.any(Number), reason: 'proxy-settings', previousProxyUrl: 'http://127.0.0.1:7890', proxyUrl: undefined },
    ])
    expect(fixture.service.getSnapshot()).toEqual(notices[1])
    expect(fixture.invalidations()).toBe(2)
  })

  test('Given bursty resume and interface changes When monitoring Then debounces and emits one trailing recovery after cooldown', async () => {
    /** 使用手动时钟的自动监测服务。 */
    const fixture = createFixture()
    /** 自动恢复通知。 */
    const notices: NetworkRecoveryNotice[] = []
    fixture.service.subscribe((notice) => { notices.push(notice) })

    fixture.service.start()
    fixture.service.start()
    expect(fixture.resumeSource.size()).toBe(1)

    fixture.resumeSource.emit()
    await fixture.clock.advance(300)
    expect(notices.map((notice) => notice.reason)).toEqual(['resume'])

    fixture.setSignature('network-b')
    await fixture.clock.advance(4_700)
    fixture.resumeSource.emit()
    await fixture.clock.advance(300)
    expect(notices).toHaveLength(2)
    expect(notices[1]?.reason).toBe('resume')

    fixture.service.stop()
    fixture.service.stop()
    expect(fixture.resumeSource.size()).toBe(0)
    fixture.resumeSource.emit()
    await fixture.clock.advance(10_000)
    expect(notices).toHaveLength(2)
  })

  test('Given proxy resolution fails When requesting recovery Then keeps the prior snapshot and does not reject callers', async () => {
    /** 会在解析代理时失败的依赖。 */
    const fixture = createFixture()
    await fixture.service.requestRecovery('manual')
    /** 失败前已经发布的稳定快照。 */
    const before = fixture.service.getSnapshot()
    /** 临时替换为失败服务所需的依赖。 */
    const failing = new NetworkRecoveryService({
      readNetworkSignature: () => 'network',
      invalidateProxyCache: () => {},
      resolveProxyUrl: async () => { throw new Error('detector unavailable') },
      resumeSource: fixture.resumeSource,
      now: fixture.clock.now,
      setTimeout: fixture.clock.setTimeout,
      clearTimeout: fixture.clock.clearTimer,
      setInterval: fixture.clock.setInterval,
      clearInterval: fixture.clock.clearTimer,
      reportError: () => {},
    })

    await expect(failing.requestRecovery('manual')).resolves.toEqual({ epoch: 0 })
    expect(failing.getSnapshot()).toBeUndefined()
    expect(before?.epoch).toBe(1)
  })
})
