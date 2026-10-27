/**
 * 全局代理配置服务
 *
 * 管理应用的全局代理配置，支持系统代理自动检测和手动配置。
 * 配置文件存储在 ~/.proma/proxy-settings.json。
 */

import { existsSync, readFileSync } from 'node:fs'
import type { ProxyConfig } from '@dutydeck/shared'
import { getProxySettingsPath } from './config-paths'
import { writeJsonFileAtomic } from './safe-file'
import { detectSystemProxy } from './system-proxy-detector'

/**
 * 默认代理配置
 */
const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  enabled: false,
  mode: 'system',
  manualUrl: '',
}

const SYSTEM_PROXY_CACHE_TTL_MS = 30_000
let systemProxyCache: { expiresAt: number; result: Awaited<ReturnType<typeof detectSystemProxy>> } | undefined
/** 当前系统代理缓存代次；失效后旧异步检测不得回填新代缓存。 */
let systemProxyCacheGeneration = 0
/** 当前代正在执行的系统代理检测。 */
let pendingSystemProxyDetection: {
  generation: number
  promise: Promise<Awaited<ReturnType<typeof detectSystemProxy>>>
} | undefined

/**
 * 立即失效系统代理缓存及当前代检测。
 *
 * 已启动的系统命令无法可靠取消，但其结果会被 generation 拒绝，不能覆盖新网络的代理。
 */
export function invalidateSystemProxyCache(): void {
  systemProxyCacheGeneration += 1
  systemProxyCache = undefined
  pendingSystemProxyDetection = undefined
}

/**
 * 系统代理检测可能需要调用 OS 命令。合并并短暂缓存检测，避免网络请求热路径重复触发它。
 */
async function getCachedSystemProxy(): Promise<Awaited<ReturnType<typeof detectSystemProxy>>> {
  /** 本次读取绑定的缓存代次。 */
  const generation = systemProxyCacheGeneration
  const now = Date.now()
  if (systemProxyCache && systemProxyCache.expiresAt > now) return systemProxyCache.result

  if (!pendingSystemProxyDetection || pendingSystemProxyDetection.generation !== generation) {
    /** 本代唯一的检测 Promise。 */
    const promise = detectSystemProxy()
      .then((result) => {
        if (systemProxyCacheGeneration === generation) {
          systemProxyCache = { result, expiresAt: Date.now() + SYSTEM_PROXY_CACHE_TTL_MS }
        }
        return result
      })
      .finally(() => {
        if (pendingSystemProxyDetection?.promise === promise) pendingSystemProxyDetection = undefined
      })
    pendingSystemProxyDetection = { generation, promise }
  }

  return await pendingSystemProxyDetection.promise
}

/** 代理 URL 可能携带认证信息；日志中绝不能输出其用户名或密码。 */
export function redactProxyUrl(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl)
    if (!['http:', 'https:', 'socks:', 'socks4:', 'socks5:'].includes(url.protocol)) {
      return '[invalid proxy URL]'
    }
    if (url.username || url.password) {
      url.username = '***'
      url.password = '***'
    }
    return url.toString()
  } catch {
    return '[invalid proxy URL]'
  }
}

/**
 * 读取代理配置
 *
 * 如果配置文件不存在，返回默认配置。
 */
export async function getProxySettings(): Promise<ProxyConfig> {
  const configPath = getProxySettingsPath()

  if (!existsSync(configPath)) {
    console.log('[代理配置] 配置文件不存在，使用默认配置')
    return DEFAULT_PROXY_CONFIG
  }

  try {
    const raw = readFileSync(configPath, 'utf-8')
    return JSON.parse(raw) as ProxyConfig
  } catch (error) {
    console.error('[代理配置] 读取配置失败:', error)
    return DEFAULT_PROXY_CONFIG
  }
}

/**
 * 保存代理配置
 *
 * @param config 代理配置
 */
export async function saveProxySettings(config: ProxyConfig): Promise<void> {
  const configPath = getProxySettingsPath()

  try {
    writeJsonFileAtomic(configPath, config)
    invalidateSystemProxyCache()
    console.log('[代理配置] 配置已保存:', {
      ...config,
      manualUrl: config.manualUrl ? redactProxyUrl(config.manualUrl) : '',
    })
  } catch (error) {
    console.error('[代理配置] 保存配置失败:', error)
    throw new Error('保存代理配置失败')
  }
}

/**
 * 获取当前生效的代理 URL
 *
 * 根据配置返回实际使用的代理地址：
 * - 如果代理未启用，返回 undefined
 * - 如果是系统代理模式，自动检测系统代理
 * - 如果是手动模式，返回手动配置的地址
 *
 * @returns 代理 URL（如果有）
 */
export async function getEffectiveProxyUrl(): Promise<string | undefined> {
  const config = await getProxySettings()

  if (!config.enabled) {
    return undefined
  }

  if (config.mode === 'system') {
    const result = await getCachedSystemProxy()
    if (result.success && result.proxyUrl) {
      console.log('[代理配置] 使用系统代理:', redactProxyUrl(result.proxyUrl))
      return result.proxyUrl
    }
    console.log('[代理配置] 系统代理检测失败:', result.message)
    return undefined
  }

  // 手动模式
  if (config.manualUrl.trim()) {
    console.log('[代理配置] 使用手动配置代理:', redactProxyUrl(config.manualUrl))
    return config.manualUrl.trim()
  }

  return undefined
}

/** 恢复连接专用解析：只有确认无代理才返回直连，检测失败抛固定信息保留旧快照。 */
export async function getRecoveryProxyUrl(): Promise<string | undefined> {
  const config = await getProxySettings()
  if (!config.enabled) return undefined
  if (config.mode === 'manual') return config.manualUrl.trim() || undefined
  const result = await getCachedSystemProxy()
  if (result.success && result.proxyUrl?.trim()) return result.proxyUrl.trim()
  if (!result.success && result.detectionState === 'direct') return undefined
  throw new Error('系统代理检测失败，保留现有连接设置')
}
