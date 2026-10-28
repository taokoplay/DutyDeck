import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeDriverResponse, getComputerUseDriverCandidates, LocalComputerUseDriver } from './driver'

describe('Cua 子进程协议', () => {
  test('Given MCP业务错误 When 退出0 Then 仍拒绝操作', () => {
    expect(() => decodeDriverResponse({ structuredContent: { success: false } })).toThrow('失败')
    expect(() => decodeDriverResponse({ content: [{ type: 'text', text: '{"error":"denied"}' }] })).toThrow('失败')
    expect(decodeDriverResponse({ content: [{ type: 'text', text: '{"success":true}' }] })).toEqual({ success: true })
  })
  test('Given 真实假Driver子进程 When 检测和调用 Then 保留JSON参数且拒绝旧版', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dutydeck-fake-driver-'))
    const path = join(directory, 'cua-driver')
    const driver = new LocalComputerUseDriver()
    try {
      await writeFile(path, `#!${process.execPath}\nif(process.argv[2]==='--version')console.log('cua-driver 0.38.0');else console.log(JSON.stringify({structuredContent:{success:true,args:JSON.parse(process.argv[4])}}))\n`)
      await chmod(path, 0o700)
      expect((await driver.check(path)).status).toBe('installed')
      expect(await driver.call(path, 'click', { text: '$(touch should-not-exist)\n中文' })).toEqual({ success: true, args: { text: '$(touch should-not-exist)\n中文' } })
      await writeFile(path, `#!${process.execPath}\nconsole.log('cua-driver 0.17.0')\n`)
      expect((await driver.check(path)).status).toBe('needs_attention')
      await writeFile(path, `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});setInterval(()=>{},1000)\n`)
      const controller = new AbortController()
      const pending = driver.call(path, 'get_window_state', {}, controller.signal)
      controller.abort()
      await expect(pending).rejects.toThrow('调用失败')

    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test('Given Windows Driver When 检测路径和版本 Then 接受 cua-driver.exe 并返回 Windows 平台', async () => {
    /** Windows 路径规则由显式平台参数驱动，便于在 macOS CI 模拟协议。 */
    const directory = await mkdtemp(join(tmpdir(), 'dutydeck-fake-driver-win-'))
    const path = join(directory, 'cua-driver.exe')
    const driver = new LocalComputerUseDriver({ platform: 'win32' })
    try {
      await writeFile(path, `#!${process.execPath}\nconsole.log('cua-driver 0.38.0')\n`)
      await chmod(path, 0o700)
      const result = await driver.check(path, 'win32')
      expect(result).toMatchObject({ platform: 'windows', status: 'installed', version: '0.38.0', driverPath: path })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test('Given Windows 环境变量 When 查找 Driver Then 优先用户目录并包含本地应用与系统目录', () => {
    /** 候选顺序保持用户级优先，避免写入 Program Files。 */
    expect(getComputerUseDriverCandidates('win32', {
      USERPROFILE: 'C:\\Users\\alice', LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local', ProgramFiles: 'C:\\Program Files',
    })).toEqual([
      'C:\\Users\\alice\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe',
      'C:\\Users\\alice\\.local\\bin\\cua-driver.exe',
      'C:\\Users\\alice\\AppData\\Local\\CuaDriver\\cua-driver.exe',
      'C:\\Program Files\\CuaDriver\\cua-driver.exe',
    ])
  })
})
