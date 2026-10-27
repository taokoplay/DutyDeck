import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ProxyConfig, SystemProxyDetectResult } from '@dutydeck/shared'

/** 当前测试文件独占的配置目录。 */
const testDirectory = join(tmpdir(), `dutydeck-proxy-settings-${process.pid}`)
/** 代理配置测试文件。 */
const testConfigPath = join(testDirectory, 'proxy-settings.json')
/** 可替换的系统代理检测实现。 */
let detectImplementation: () => Promise<SystemProxyDetectResult> = async () => ({ success: false, message: 'none' })

mock.module('./config-paths', () => ({ getProxySettingsPath: () => testConfigPath }))
mock.module('./system-proxy-detector', () => ({ detectSystemProxy: () => detectImplementation() }))

/** 在依赖替换完成后加载被测服务。 */
const proxySettings = await import('./proxy-settings-service')
const {
  getEffectiveProxyUrl,
  invalidateSystemProxyCache,
  redactProxyUrl,
  saveProxySettings,
} = proxySettings

beforeEach(() => {
  rmSync(testDirectory, { recursive: true, force: true })
  mkdirSync(testDirectory, { recursive: true })
  detectImplementation = async () => ({ success: false, message: 'none' })
  invalidateSystemProxyCache()
})

afterAll(() => {
  rmSync(testDirectory, { recursive: true, force: true })
  mock.restore()
})

/** 直接准备系统代理模式配置，避免被测读取依赖其它设置流程。 */
function writeSystemProxyConfig(): void {
  /** 启用系统代理模式的配置。 */
  const config: ProxyConfig = { enabled: true, mode: 'system', manualUrl: '' }
  writeFileSync(testConfigPath, JSON.stringify(config), 'utf-8')
}

describe('proxy settings logging', () => {
  test('Given an authenticated proxy URL When formatting it for logs Then redacts both username and password', () => {
    const value = redactProxyUrl('http://alice:secret@127.0.0.1:7890')

    expect(value).not.toContain('alice')
    expect(value).not.toContain('secret')
    expect(value).toContain('127.0.0.1:7890')
  })

  test('Given a malformed proxy URL When formatting it for logs Then never returns the original value', () => {
    expect(redactProxyUrl('alice:secret@not a url')).toBe('[invalid proxy URL]')
  })

  test('Given an in-flight system detection When invalidated Then its late result cannot replace the new cache generation', async () => {
    writeSystemProxyConfig()
    /** 第一代检测的手动完成函数。 */
    let resolveStale!: (value: SystemProxyDetectResult) => void
    /** 系统代理检测调用次数。 */
    let calls = 0
    detectImplementation = () => {
      calls += 1
      if (calls === 1) return new Promise((resolve) => { resolveStale = resolve })
      return Promise.resolve({ success: true, proxyUrl: 'http://new.proxy:7890', message: 'new' })
    }

    /** 仍在执行的旧代检测。 */
    const staleRead = getEffectiveProxyUrl()
    await Bun.sleep(0)
    expect(calls).toBe(1)
    invalidateSystemProxyCache()
    await expect(getEffectiveProxyUrl()).resolves.toBe('http://new.proxy:7890')
    resolveStale({ success: true, proxyUrl: 'http://stale.proxy:7890', message: 'stale' })
    await expect(staleRead).resolves.toBe('http://stale.proxy:7890')

    await expect(getEffectiveProxyUrl()).resolves.toBe('http://new.proxy:7890')
    expect(calls).toBe(2)
  })

  test('Given existing proxy settings When saving replacements Then commits atomically and preserves the prior backup', async () => {
    /** 首次保存的手动代理配置。 */
    const first: ProxyConfig = { enabled: true, mode: 'manual', manualUrl: 'http://127.0.0.1:7890' }
    /** 第二次保存的直连配置。 */
    const second: ProxyConfig = { enabled: false, mode: 'system', manualUrl: '' }

    await saveProxySettings(first)
    await saveProxySettings(second)

    expect(JSON.parse(readFileSync(testConfigPath, 'utf-8'))).toEqual(second)
    expect(JSON.parse(readFileSync(`${testConfigPath}.bak`, 'utf-8'))).toEqual(first)
    expect(existsSync(`${testConfigPath}.tmp`)).toBeFalse()
  })
})

test('恢复解析区分确认直连、检测失败与不完整成功结果', async () => {
  writeSystemProxyConfig()
  detectImplementation = async () => ({ success: false, detectionState: 'direct', message: '系统未配置代理' })
  await expect(proxySettings.getRecoveryProxyUrl()).resolves.toBeUndefined()
  invalidateSystemProxyCache()
  detectImplementation = async () => ({ success: false, detectionState: 'error', message: 'timeout with secret' })
  await expect(proxySettings.getRecoveryProxyUrl()).rejects.toThrow('系统代理检测失败，保留现有连接设置')
  invalidateSystemProxyCache()
  detectImplementation = async () => ({ success: true, proxyUrl: ' ', message: 'bad' })
  await expect(proxySettings.getRecoveryProxyUrl()).rejects.toThrow('系统代理检测失败')
})

test('恢复解析保留禁用和手动配置语义，系统代理沿用代次缓存', async () => {
  await saveProxySettings({ enabled: false, mode: 'system', manualUrl: '' })
  await expect(proxySettings.getRecoveryProxyUrl()).resolves.toBeUndefined()
  await saveProxySettings({ enabled: true, mode: 'manual', manualUrl: ' http://manual:7890 ' })
  await expect(proxySettings.getRecoveryProxyUrl()).resolves.toBe('http://manual:7890')
  writeSystemProxyConfig()
  let calls = 0
  detectImplementation = async () => ({ success: true, proxyUrl: `http://proxy-${++calls}:7890`, message: 'ok' })
  await expect(proxySettings.getRecoveryProxyUrl()).resolves.toBe('http://proxy-1:7890')
  await expect(proxySettings.getRecoveryProxyUrl()).resolves.toBe('http://proxy-1:7890')
  invalidateSystemProxyCache()
  await expect(proxySettings.getRecoveryProxyUrl()).resolves.toBe('http://proxy-2:7890')
})
