import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COMPUTER_USE_DRIVER_VERSION } from '@dutydeck/shared'

/** 固定发布资产及官方发布页校验值，不执行动态版本安装脚本。 */
const INSTALL_ASSETS = {
  'install.sh': 'a103177e0df86d04d752bfa20c73f99a3e501906f1814c3127da84788539d9ba',
  '_install-rust.sh': '0be0bd269056a7c0c5b15e77ff6c64c880267d091957c97efc19103380e4aeb7',
  'install.ps1': '31ff35434433d511457bac9638d568a7151a517bc613f478c29d52670a307727',
} as const

/** 官方安装进度；真实版本仍由服务重新检测。 */
export type DriverInstallProgress = (status: 'downloading' | 'installing') => void

/** 仅此类固定说明可传给页面，避免泄露代理凭据或安装日志。 */
export class DriverInstallError extends Error {}

/** 从固定官方 URL 下载有界脚本；入参 fetch 便于隔离网络测试，返回原始 UTF-8 脚本。 */
export async function downloadDriverInstaller(fetcher: (url: string, init: { signal: AbortSignal }) => Promise<Response>, asset: keyof typeof INSTALL_ASSETS, signal: AbortSignal): Promise<Uint8Array> {
  /** 固定 URL 与摘要由宿主决定；页面不能提供命令、URL 或校验值。 */
  const url = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${COMPUTER_USE_DRIVER_VERSION}/${asset}`
  /** 请求覆盖下载全程，包括流式读取。 */
  const response = await fetcher(url, { signal })
  if (!response.ok || response.headers.get('content-type')?.includes('text/html') || !response.body) throw new DriverInstallError('官方安装器下载失败，请检查网络或代理后重试')
  /** 即使服务器不提供 Content-Length，累计读取也不能超过 512 KiB。 */
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 512 * 1024) throw new DriverInstallError('官方安装器响应过大，已停止安装')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  if (!size) throw new DriverInstallError('官方安装器为空，请重试')
  /** 只合并已通过大小检查的响应。 */
  const bytes = Buffer.concat(chunks)
  if (/^\s*(?:<!doctype|<html)/i.test(bytes.toString('utf8', 0, 128))) throw new DriverInstallError('官方安装器返回了错误页面')
  if (createHash('sha256').update(bytes).digest('hex') !== INSTALL_ASSETS[asset]) throw new DriverInstallError('官方安装器校验失败，已停止执行。请稍后重试或使用官方安装说明。')
  return bytes
}

/** 运行固定安装器，超时回收进程树；不接收 renderer 参数、不解释子进程日志。 */
export function runDriverInstallerProcess(executable: string, args: string[], environment: NodeJS.ProcessEnv, timeoutMs = 10 * 60_000, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DriverInstallError('安装已取消'))
  return new Promise((resolve, reject) => {
    /** macOS 独立进程组用于同时回收 shell 与下载进程。 */
    const child = spawn(executable, args, { env: environment, stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' })
    /** 仅记录首次终止原因；取消和超时共用进程树清理。 */
    let failure: DriverInstallError | undefined
    let hardTimer: ReturnType<typeof setTimeout> | undefined
    let killing: Promise<void> | undefined
    /** 终止父安装器及下载后代；Windows 等待 taskkill 结束才释放互斥。 */
    const terminate = (message: string): void => {
      if (failure) return
      failure = new DriverInstallError(message)
      if (!child.pid) return
      if (process.platform === 'win32') {
        killing = new Promise<void>(done => {
          /** 固定系统工具，参数仅取当前安装进程 PID。 */
          const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
          killer.once('error', () => { child.kill(); done() })
          killer.once('close', code => { if (code !== 0) child.kill(); done() })
        })
      } else {
        try { process.kill(-child.pid, 'SIGTERM') } catch { /* 进程可能已结束。 */ }
        hardTimer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* 进程组已结束。 */ } }, 5000)
      }
    }
    /** 全程超时和应用取消监听，页面卸载不影响任务。 */
    const timer = setTimeout(() => terminate('安装超时，已停止安装任务。请检查网络、代理或其他安装任务后重试。'), timeoutMs)
    const cancel = (): void => terminate('安装已取消')
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    /** spawn 失败也由 close 统一完成监听器与计时器清理。 */
    child.once('error', () => { failure ??= new DriverInstallError('无法启动官方安装器，请检查系统环境及安装目录权限') })
    child.once('close', code => {
      clearTimeout(timer)
      if (hardTimer) clearTimeout(hardTimer)
      signal?.removeEventListener('abort', cancel)
      /** 父 shell 可能先退出；终止分支仍回收未退出的下载后代。 */
      if (failure && process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* 进程组已经退出。 */ } }
      void Promise.resolve(killing).then(() => {
        if (failure) reject(failure)
        else if (code !== 0) reject(new DriverInstallError(`官方安装器未完成（退出码 ${code ?? '未知'}），请检查网络、代理和安装目录权限后重试。`))
        else resolve()
      })
    })
  })
}

/** 用户点击后运行官方安装入口；复用应用代理，脚本与发布包仍由官方安装器校验。 */
export async function installOfficialComputerUseDriver(progress: DriverInstallProgress, platform: NodeJS.Platform, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (platform !== 'darwin' && platform !== 'win32') throw new DriverInstallError('当前仅支持 macOS 和 Windows')
  /** 惰性加载代理，普通设置读取不会访问网络或创建 dispatcher。 */
  const { getEffectiveProxyUrl } = await import('../proxy-settings-service')
  const { createManagedProxyFetch } = await import('../proxy-fetch')
  const proxy = await getEffectiveProxyUrl()
  const network = createManagedProxyFetch(proxy)
  /** 创建目录失败时也释放代理 dispatcher。 */
  let directory: string | undefined
  try {
    directory = await mkdtemp(join(tmpdir(), 'dutydeck-driver-install-'))
    progress('downloading')
    /** 下载和读取脚本限时 45 秒，失败时不执行任何脚本。 */
    const script = await downloadDriverInstaller(network.fetch, platform === 'win32' ? 'install.ps1' : 'install.sh', AbortSignal.any([signal, AbortSignal.timeout(45_000)]))
    const path = join(directory, platform === 'win32' ? 'install.ps1' : 'install.sh')
    await writeFile(path, script, { mode: 0o600 })
    /** macOS 主安装器优先使用同目录 helper，防止委派到动态版本。 */
    if (platform === 'darwin') await writeFile(join(directory, '_install-rust.sh'), await downloadDriverInstaller(network.fetch, '_install-rust.sh', AbortSignal.any([signal, AbortSignal.timeout(45_000)])), { mode: 0o600 })
    /** 明确沿用应用代理；不修改用户系统代理与 shell 配置。 */
    const environment = { ...process.env }
    environment.CUA_DRIVER_RS_VERSION = COMPUTER_USE_DRIVER_VERSION
    if (proxy) { environment.HTTPS_PROXY = proxy; environment.HTTP_PROXY = proxy; environment.https_proxy = proxy; environment.http_proxy = proxy }
    signal.throwIfAborted()
    progress('installing')
    if (platform === 'darwin') await runDriverInstallerProcess('/bin/bash', [path, '--no-modify-path'], environment, undefined, signal)
    /** 仅为本次已校验脚本设置进程级执行策略，不修改系统 PowerShell 策略。 */
    else await runDriverInstallerProcess(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path, '-Release', COMPUTER_USE_DRIVER_VERSION, '-NoAutoStart', '-NoPathUpdate'], environment, undefined, signal)
  } finally { try { if (directory) await rm(directory, { recursive: true, force: true }) } finally { await network.close() } }
}
