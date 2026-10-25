import { describe, expect, test } from 'bun:test'
import {
  installPluginWhenIdle,
  isPluginManagementBusyError,
  pluginImportErrorMessage,
  validatePluginDropFiles,
} from './PluginPackageImporter.logic'

describe('Given 插件中心拖放文件', () => {
  test('When 只有一个合法 ddplugin Then 接受', () => {
    expect(validatePluginDropFiles([{ name: 'interaction.ddplugin', size: 1024 }])).toBeNull()
  })

  test('When 扩展名错误、包含多项或超过 50 MiB Then 返回可行动提示', () => {
    expect(validatePluginDropFiles([{ name: 'plugin.zip', size: 1024 }])).toContain('.ddplugin')
    expect(validatePluginDropFiles([
      { name: 'one.ddplugin', size: 1024 },
      { name: 'two.ddplugin', size: 1024 },
    ])).toContain('一次只能导入一个')
    expect(validatePluginDropFiles([{ name: 'large.ddplugin', size: 50 * 1024 * 1024 + 1 }])).toContain('50 MB')
  })

  test('When 没有文件 Then 忽略拖放', () => {
    expect(validatePluginDropFiles([])).toBeNull()
  })
})

describe('Given Agent 正在运行时安装插件', () => {
  test('When 前两次返回 AGENT_BUSY Then 空闲后自动完成且只提示一次', async () => {
    let attempts = 0
    let busyNotices = 0
    let waits = 0
    const result = await installPluginWhenIdle(async () => {
      attempts += 1
      if (attempts < 3) throw new Error("Error invoking remote method 'module-runtime-plugin:install': Error: AGENT_BUSY")
      return 'installed'
    }, {
      onBusy: () => { busyNotices += 1 },
      wait: async () => { waits += 1 },
    })
    expect(result).toBe('installed')
    expect(attempts).toBe(3)
    expect(waits).toBe(2)
    expect(busyNotices).toBe(1)
  })

  test('When 等待超过期限 Then 返回可行动提示而不暴露 IPC 包装', async () => {
    let clock = 0
    await expect(installPluginWhenIdle(
      async () => { throw new Error('AGENT_BUSY') },
      {
        maxWaitMs: 4_000,
        retryMs: 2_000,
        now: () => clock,
        wait: async milliseconds => { clock += milliseconds },
      },
    )).rejects.toThrow('PLUGIN_INSTALL_WAIT_TIMEOUT')
    expect(pluginImportErrorMessage(new Error('PLUGIN_INSTALL_WAIT_TIMEOUT'))).toContain('Agent 仍在运行')
    expect(pluginImportErrorMessage(new Error('x AGENT_BUSY y'))).not.toContain('invoking remote method')
  })

  test('When 取消等待 Then 不继续重试', async () => {
    const controller = new AbortController()
    let attempts = 0
    await expect(installPluginWhenIdle(async () => {
      attempts += 1
      throw new Error('AGENT_BUSY')
    }, {
      signal: controller.signal,
      wait: async () => { controller.abort() },
    })).rejects.toThrow('PLUGIN_INSTALL_WAIT_CANCELLED')
    expect(attempts).toBe(1)
  })
})
