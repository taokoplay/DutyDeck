import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'jotai'
import type { ComputerUseApi, ComputerUseSnapshot } from '@dutydeck/shared'
import { ComputerUseSettings } from '../src/renderer/components/settings/ComputerUseSettings'
import { ComputerUseStatus } from '../src/renderer/components/computer-use/ComputerUseStatus'

/** 隔离 UI fixture 的全局句柄；所有 API 都为内存模拟。 */
interface SmokeWindow extends Window {
  computerUseSmoke?: { listeners(): number; calls: string[]; activate(): void; unmount(): void; allowStop(): void; holdCheck(): void; finishCheck(): void; finishInstall(success: boolean): void; setPlatform(platform: 'macos' | 'windows'): void; setPath(path: string): void }
}
/** 模拟当前配置与操作，不读取真实桌面或磁盘配置。 */
let snapshot: ComputerUseSnapshot = { config: { enabled: false }, installation: null, operation: null }
let rejectStop = true
/** 保留安装检测等待，验证用户停止不被慢请求阻挡。 */
let holdCheck = false
let finishCheck: (() => void) | null = null
/** 用户显式触发安装，延迟结果以测试进度和失败重试。 */
let finishInstall: ((success: boolean) => void) | null = null
const listeners = new Set<(snapshot: ComputerUseSnapshot) => void>()
const calls: string[] = []
/** 同步推送真实界面所依赖的状态变更。 */
function emit(): ComputerUseSnapshot { for (const listener of listeners) listener(snapshot); return snapshot }
/** 窄 API 模拟带有安装、配置和停止失败分支。 */
const api: ComputerUseApi = {
  getSnapshot: async () => snapshot,
  installDriver: async () => {
    calls.push('install')
    snapshot = { ...snapshot, driverSetup: { status: 'downloading', message: '正在下载 Cua 官方安装器…' }, permissions: undefined }; emit()
    /** 只控制假安装结果，不下载或执行任何真实脚本。 */
    const success = await new Promise<boolean>(resolve => { finishInstall = resolve })
    snapshot = { ...snapshot, installation: success ? { platform: 'macos', status: 'installed', version: '0.38.0' } : snapshot.installation, driverSetup: { status: success ? 'succeeded' : 'failed', message: success ? 'Driver 0.38.0 已安装。请继续验证系统权限。' : '模拟网络错误，请检查代理后重试。' } }
    return emit()
  },
  onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  setEnabled: async enabled => { calls.push('enabled'); snapshot = { ...snapshot, config: { enabled } }; return emit() },
  chooseDriver: async () => { calls.push('choose'); snapshot = { ...snapshot, config: { ...snapshot.config, driverPath: '/fixture/cua-driver' } }; return emit() },
  checkInstallation: async () => { calls.push('check'); if (holdCheck) await new Promise<void>(resolve => { finishCheck = resolve }); snapshot = { ...snapshot, installation: { platform: 'macos', status: 'installed', version: '0.38.0' } }; return emit() },
  checkPermissions: async () => { calls.push('permissions'); snapshot = { ...snapshot, permissions: { accessibility: 'granted', screenRecording: 'granted', checkedAt: Date.now() } }; return emit() },
  stop: async id => { calls.push(`stop:${id}`); if (rejectStop) throw new Error('模拟停止失败'); snapshot = { ...snapshot, operation: null }; return emit() },
}
Object.defineProperty(window, 'electronAPI', { value: { computerUse: api, openExternal: async () => {} } })
/** 实际 React 组件根，包含设置与两个不同会话。 */
const root = createRoot(document.getElementById('root')!)
root.render(<Provider><div className="mx-auto w-full max-w-[1080px] px-5 py-8 pb-12 sm:px-8"><ComputerUseSettings /></div><div id="owner"><ComputerUseStatus sessionId="owner" /></div><div id="other"><ComputerUseStatus sessionId="other" /></div></Provider>)
;(window as SmokeWindow).computerUseSmoke = {
  listeners: () => listeners.size, calls,
  activate: () => { snapshot = { ...snapshot, operation: { id: 'operation', sessionId: 'owner', pid: 1, windowId: '2', title: '测试窗口', startedAt: Date.now(), observedAt: Date.now(), status: 'active' } }; emit() },
  /** 仅改变模拟平台与路径，用于验证权限术语和窄窗口排版。 */
  setPlatform: platform => { snapshot = { ...snapshot, installation: { ...snapshot.installation, platform, status: 'installed', version: '0.38.0' } }; emit() },
  setPath: driverPath => { snapshot = { ...snapshot, config: { ...snapshot.config, driverPath } }; emit() },
  unmount: () => root.unmount(),
  allowStop: () => { rejectStop = false },
  holdCheck: () => { holdCheck = true },
  finishCheck: () => { holdCheck = false; finishCheck?.() },
  finishInstall: success => { finishInstall?.(success) },
}
