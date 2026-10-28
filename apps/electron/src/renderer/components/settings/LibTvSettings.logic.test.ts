import { describe, expect, test } from 'bun:test'
import { createLibTvMcpEntry } from '@dutydeck/shared'
import type { WorkspaceMcpConfig } from '@dutydeck/shared'
import { connectLibTv, disableLibTv, getLibTvConnectionState, verifyLibTv, type LibTvApi } from './LibTvSettings.logic'

/** 创建只在内存中保存配置的 IPC 替身，记录授权与启用顺序。 */
function fixture(initial: WorkspaceMcpConfig = { servers: {} }) {
  let config = initial
  const calls: string[] = []
  const api: LibTvApi = {
    getWorkspaceMcpConfig: async () => config,
    installMcpAndValidate: async (_slug, name, entry) => {
      calls.push('install')
      config = { servers: { ...config.servers, [name]: entry } }
      return { config, installed: true, verification: { success: false, message: '' } }
    },
    startMcpOAuth: async () => { calls.push('oauth'); return { provider: 'libtv', serverName: 'libtv' } },
    setMcpEnabledAndValidate: async (_slug, name, enabled) => {
      calls.push(enabled ? 'enable' : 'disable')
      config = { servers: { ...config.servers, [name]: { ...config.servers[name]!, enabled, lastTestResult: { success: enabled, message: '', timestamp: 1 } } } }
      return { config, verification: { success: true, message: '' } }
    },
  }
  return { api, calls }
}

describe('LibTV 工作区授权', () => {
  test('Given 未配置 When 连接 Then 先安装禁用预设再授权验证，保留其他服务', async () => {
    const { api, calls } = fixture({ servers: { other: { type: 'stdio', command: 'other', enabled: true } } })
    const config = await connectLibTv(api, 'workspace', () => true)
    expect(calls).toEqual(['install', 'oauth', 'enable'])
    expect(config?.servers.other?.command).toBe('other')
    expect(getLibTvConnectionState(config!.servers.libtv)).toBe('connected')
  })
  test('Given 用户拒绝授权 When 连接 Then 保留禁用配置且不启用', async () => {
    const { api, calls } = fixture()
    api.startMcpOAuth = async () => { throw new Error('已取消授权') }
    await expect(connectLibTv(api, 'workspace', () => true)).rejects.toThrow('已取消授权')
    expect(calls).toEqual(['install'])
    expect(getLibTvConnectionState((await api.getWorkspaceMcpConfig('workspace')).servers.libtv)).toBe('disabled')
  })
  test('Given 同名非官方服务 When 连接或停用 Then 不覆盖、不授权、不切换', async () => {
    const { api, calls } = fixture({ servers: { libtv: { type: 'http', url: 'https://example.com/mcp', enabled: true } } })
    await expect(connectLibTv(api, 'workspace', () => true)).rejects.toThrow('同名')
    await expect(disableLibTv(api, 'workspace', () => true)).rejects.toThrow('同名')
    expect(calls).toEqual([])
  })
  test('Given 授权期间切换工作区 When 旧授权完成 Then 不继续启用且不返回旧状态', async () => {
    const { api, calls } = fixture()
    let current = true
    api.startMcpOAuth = async () => { current = false; return { provider: 'libtv', serverName: 'libtv' } }
    expect(await connectLibTv(api, 'workspace', () => current)).toBeNull()
    expect(calls).toEqual(['install'])
  })
  test('Given 握手失败 When 连接 Then 报告失败而非已连接', async () => {
    const { api } = fixture()
    api.setMcpEnabledAndValidate = async () => ({ config: { servers: { libtv: createLibTvMcpEntry() } }, verification: { success: false, message: '工具发现失败' } })
    await expect(connectLibTv(api, 'workspace', () => true)).rejects.toThrow('工具发现失败')
  })
  test('Given 已启用 When 停用 Then 只切换该服务且不删除凭据', async () => {
    const { api, calls } = fixture({ servers: { libtv: { ...createLibTvMcpEntry(), enabled: true } } })
    const config = await disableLibTv(api, 'workspace', () => true)
    expect(calls).toEqual(['disable'])
    expect(getLibTvConnectionState(config!.servers.libtv)).toBe('disabled')
  })
  test('Given 仅启用但没有验证成功 When 展示 Then 不声称已连接', () => {
    expect(getLibTvConnectionState({ ...createLibTvMcpEntry(), enabled: true })).toBe('pending')
    expect(getLibTvConnectionState(undefined)).toBe('unconfigured')
    expect(getLibTvConnectionState({ ...createLibTvMcpEntry(), headers: { Authorization: 'custom' } })).toBe('conflict')
  })
})


test('Given 已有授权 When 验证连接 Then 真实握手并传官方目标约束，不重启 OAuth', async () => {
  const { api, calls } = fixture({ servers: { libtv: { ...createLibTvMcpEntry(), enabled: true } } })
  const original = api.setMcpEnabledAndValidate
  api.setMcpEnabledAndValidate = async (slug, name, enabled, options) => {
    expect(options).toEqual({ expectedTarget: { type: 'http', url: 'https://mcp.liblib.tv/mcp' } })
    return original(slug, name, enabled, options)
  }
  const config = await verifyLibTv(api, 'workspace', () => true)
  expect(calls).toEqual(['enable'])
  expect(getLibTvConnectionState(config!.servers.libtv)).toBe('connected')
})

test('Given 上次断网导致连接停用 When 使用已有凭据重验 Then 成功启用且不要求重新授权', async () => {
  const { api, calls } = fixture({ servers: { libtv: { ...createLibTvMcpEntry(), enabled: false, lastTestResult: { success: false, message: '临时断网', timestamp: 1 } } } })
  const config = await verifyLibTv(api, 'workspace', () => true)
  expect(calls).toEqual(['enable'])
  expect(getLibTvConnectionState(config!.servers.libtv)).toBe('connected')
})
