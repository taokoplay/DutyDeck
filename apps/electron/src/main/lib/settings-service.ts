/**
 * 应用设置服务
 *
 * 管理应用设置（主题模式等）的读写。
 * 存储在 ~/.proma/settings.json
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { getSettingsPath } from './config-paths'
import { writeJsonFileAtomic } from './safe-file'
import { DEFAULT_THEME_MODE, normalizeProductivityToolsSettings } from '../../types'
import type { AgentIslandSettings, AppSettings } from '../../types'
import { getTerminalProfilesForPlatform, isTerminalProfile } from '@dutydeck/shared'

function sanitizeAgentIslandSettings(input: unknown): AgentIslandSettings | undefined {
  if (!input || typeof input !== 'object') return undefined
  const raw = input as { enabled?: unknown }
  return typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : undefined
}

/** 将旧版或未知应用图标偏好统一为当前 DutyDeck 默认图标。 */
function normalizeAppIconVariant(input: unknown): 'default' {
  void input
  return 'default'
}

export function sanitizeWindowsTerminalProfile(input: unknown): AppSettings['lastWindowsTerminalProfile'] {
  return isTerminalProfile(input) && getTerminalProfilesForPlatform('win32').includes(input)
    ? input
    : undefined
}

/**
 * 设置文件读取缓存。
 *
 * 设置读取遍布主进程（约 60 处调用点），此前每次调用都同步 readFileSync + JSON.parse，
 * 在键盘事件需要经主进程转发的同步路径上反复阻塞。这里按 mtime + size 校验缓存：
 * 既避免重复解析，也允许外部直接改写 settings.json 后被正确感知。
 * 调用方只读取字段，不得原地修改返回值（否则会污染后续读取）。
 */
let settingsCache: { data: AppSettings; mtimeMs: number; size: number } | null = null

/** 按当前文件状态记录缓存；stat 失败时丢弃缓存而不是保留可疑数据。 */
function cacheSettings(data: AppSettings): void {
  try {
    const stat = statSync(getSettingsPath())
    settingsCache = { data, mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    settingsCache = null
  }
}

/**
 * 获取应用设置
 *
 * 如果文件不存在，返回默认设置。
 */
export function getSettings(): AppSettings {
  const filePath = getSettingsPath()

  if (!existsSync(filePath)) {
    settingsCache = null
    return {
      themeMode: DEFAULT_THEME_MODE,
      onboardingCompleted: false,
      environmentCheckSkipped: false,
      notificationsEnabled: true,
      preventSystemSleep: false,
      longTextPasteAsAttachmentEnabled: false,
      richTextRenderingEnabled: false,
      feishuSessionMirror: { mode: 'off' },
      visionRelay: { enabled: false },
      windowsShellPreference: 'auto',
      agentThinking: { type: 'adaptive' },
      productivityTools: normalizeProductivityToolsSettings(undefined),
    }
  }

  /** 命中缓存时省掉一次同步读盘与 JSON 解析；stat 失败按未命中处理。 */
  try {
    const stat = statSync(filePath)
    if (settingsCache && settingsCache.mtimeMs === stat.mtimeMs && settingsCache.size === stat.size) {
      return settingsCache.data
    }
  } catch {
    settingsCache = null
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as Partial<AppSettings> & {
      experimentalAgentRuntimeSwitchEnabled?: boolean
      agentRuntime?: unknown
      agentChannelIds?: unknown
      builtinMcpDisabledIds?: unknown
      interfaceVariant?: unknown
      /** PR #1895 早期构建写入的无平台 profile 字段；仅在 Windows 上迁移。 */
      lastTerminalProfile?: unknown
    }
    // Pi-only：读取时丢弃旧 runtime selector、界面风格与 Claude 白名单，避免下次写回复活。
    const {
      experimentalAgentRuntimeSwitchEnabled: _legacyRuntimeSwitch,
      agentRuntime: _legacyAgentRuntime,
      agentChannelIds: _legacyAgentChannelIds,
      builtinMcpDisabledIds: _legacyBuiltinMcpDisabledIds,
      interfaceVariant: _legacyInterfaceVariant,
      lastTerminalProfile: legacyLastTerminalProfile,
      ...settings
    } = data
    const normalizedSettings: AppSettings = {
      ...settings,
      themeMode: data.themeMode || DEFAULT_THEME_MODE,
      onboardingCompleted: data.onboardingCompleted ?? false,
      environmentCheckSkipped: data.environmentCheckSkipped ?? false,
      notificationsEnabled: data.notificationsEnabled ?? true,
      preventSystemSleep: data.preventSystemSleep === true,
      longTextPasteAsAttachmentEnabled: data.longTextPasteAsAttachmentEnabled ?? false,
      richTextRenderingEnabled: data.richTextRenderingEnabled ?? false,
      feishuSessionMirror: data.feishuSessionMirror ?? { mode: 'off' },
      visionRelay: data.visionRelay ?? { enabled: false },
      windowsShellPreference: settings.windowsShellPreference ?? 'auto',
      lastWindowsTerminalProfile: process.platform === 'win32'
        ? sanitizeWindowsTerminalProfile(settings.lastWindowsTerminalProfile ?? legacyLastTerminalProfile)
        : undefined,
      agentThinking: settings.agentThinking ?? { type: 'adaptive' },
      // 缺省 true：老配置文件未写该字段时保持推广默认开启
      // 缺省全部开启：老配置文件不会因升级意外隐藏生产力工具。
      productivityTools: normalizeProductivityToolsSettings(data.productivityTools),
      // 仅保留 macOS 原生 Island 开关；清理旧非原生 surface 的持久化残留字段。
      agentIsland: sanitizeAgentIslandSettings(data.agentIsland),
      appIconVariant: normalizeAppIconVariant(data.appIconVariant),
    }
    if (data.appIconVariant !== undefined && data.appIconVariant !== 'default') {
      try {
        writeJsonFileAtomic(filePath, normalizedSettings)
      } catch (error) {
        console.warn('[设置] 归一化旧应用图标偏好失败:', error)
      }
    }
    cacheSettings(normalizedSettings)
    return normalizedSettings
  } catch (error) {
    console.error('[设置] 读取失败:', error)
    return {
      themeMode: DEFAULT_THEME_MODE,
      onboardingCompleted: false,
      environmentCheckSkipped: false,
      notificationsEnabled: true,
      preventSystemSleep: false,
      longTextPasteAsAttachmentEnabled: false,
      richTextRenderingEnabled: false,
      feishuSessionMirror: { mode: 'off' },
      visionRelay: { enabled: false },
      windowsShellPreference: 'auto',
      agentThinking: { type: 'adaptive' },
      productivityTools: normalizeProductivityToolsSettings(undefined),
    }
  }
}

/** 仅供测试与数据根切换时丢弃缓存，避免跨根残留。 */
export function resetSettingsCache(): void {
  settingsCache = null
}

/**
 * 更新应用设置
 *
 * 合并更新字段并写入文件。
 */
export function updateSettings(updates: Partial<AppSettings>): AppSettings {
  const current = getSettings()
  const updated: AppSettings = {
    ...current,
    ...updates,
    // 仅保留 macOS 原生 Island 开关，避免旧非原生 surface 字段被继续回写。
    agentIsland: updates.agentIsland === undefined
      ? sanitizeAgentIslandSettings(current.agentIsland)
      : sanitizeAgentIslandSettings({ ...current.agentIsland, ...updates.agentIsland }),
    productivityTools: updates.productivityTools === undefined
      ? normalizeProductivityToolsSettings(current.productivityTools)
      : normalizeProductivityToolsSettings({ ...current.productivityTools, ...updates.productivityTools }),
  }
  const filePath = getSettingsPath()

  try {
    writeJsonFileAtomic(filePath, updated)
    console.log('[设置] 已更新 keys:', Object.keys(updates).join(', '))
  } catch (error) {
    console.error('[设置] 写入失败:', error)
    throw new Error('写入应用设置失败')
  }

  /** 写入后立即刷新缓存，避免同进程下一次读取回落到旧值。 */
  cacheSettings(updated)
  return updated
}
