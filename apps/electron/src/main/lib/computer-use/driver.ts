import { execFile } from 'node:child_process'
import { access, mkdtemp, rm, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import sharp from 'sharp'
import type { ComputerUseInstallation, ComputerUsePermissions } from '@dutydeck/shared'
import { readPng } from './screenshot'

/** 可注入的 Driver 边界；测试不接触真实桌面。 */
export interface ComputerUseDriver {
  check(path?: string, platform?: NodeJS.Platform): Promise<ComputerUseInstallation>
  validatePath(path: string, platform?: NodeJS.Platform): Promise<void>
  call(path: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  /** 可选的用户主动权限预检；缺失时服务保持未知，不伪造已授权。 */
  checkPermissions?(path: string, signal?: AbortSignal): Promise<Omit<ComputerUsePermissions, 'checkedAt'>>
}
/** 把 Node 平台映射成共享合同里的安装平台。 */
function installationPlatform(platform: NodeJS.Platform): ComputerUseInstallation['platform'] {
  return platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : 'unsupported'
}
/** 返回各系统的 Driver 候选路径；Windows 优先用户目录，避免要求管理员写入 Program Files。 */
export function getComputerUseDriverCandidates(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'darwin') return [join(homedir(), '.local/bin/cua-driver'), '/Applications/CuaDriver.app/Contents/MacOS/cua-driver']
  if (platform !== 'win32') return []
  /** Windows 环境变量可能缺失，缺失项不生成伪路径。 */
  const userProfile = environment.USERPROFILE
  const localAppData = environment.LOCALAPPDATA
  const programFiles = environment.ProgramFiles
  return [
    /** 官方当前目录优先，避免旧 .local 副本掩盖刚安装的新版本。 */
    localAppData ? win32.join(localAppData, 'Programs', 'Cua', 'cua-driver', 'bin', 'cua-driver.exe') : null,
    userProfile ? win32.join(userProfile, '.local', 'bin', 'cua-driver.exe') : null,
    localAppData ? win32.join(localAppData, 'CuaDriver', 'cua-driver.exe') : null,
    programFiles ? win32.join(programFiles, 'CuaDriver', 'cua-driver.exe') : null,
  ].filter((candidate): candidate is string => candidate !== null)
}
/** 只接受对象形式的协议记录。 */
export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
/** 有界子进程调用；不经 shell、不重放失败动作。 */
function execute(path: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    /** 超时后强制终止不响应 SIGTERM 的本地子进程。 */
    let hardTimeout: ReturnType<typeof setTimeout> | undefined
    /** 取消只终止本次 CLI，不触碰共享 daemon。 */
    const abort = (): void => { child.kill('SIGKILL') }
    /** 独立协议子进程。 */
    const child = execFile(path, args, { timeout: 8000, maxBuffer: 2 * 1024 * 1024, signal, encoding: 'utf8' }, (error, stdout) => {
      if (hardTimeout) clearTimeout(hardTimeout)
      signal?.removeEventListener('abort', abort)
      if (error) reject(new Error(`Cua Driver 调用失败：${error.code ?? error.name}`))
      else resolve(stdout)
    })
    hardTimeout = setTimeout(() => child.kill('SIGKILL'), 8500)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
/** 解开 MCP 包装并拒绝退出码为零的业务错误。 */
export function decodeDriverResponse(value: unknown): unknown {
  /** 当前协议层。 */
  const object = record(value)
  if (!object) throw new Error('Cua Driver 返回了无效对象')
  if (object.isError === true || object.success === false || object.error || object.landed_on_target === false) throw new Error('Cua Driver 操作失败，请重新观察窗口')
  if (object.structuredContent) return decodeDriverResponse(object.structuredContent)
  if (Array.isArray(object.content)) {
    /** MCP JSON 文本载荷。 */
    const content = object.content.map(record).find(item => item?.type === 'text' && typeof item.text === 'string')
    if (content && typeof content.text === 'string') {
      try { return decodeDriverResponse(JSON.parse(content.text)) } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        throw new Error('Cua Driver 返回了非 JSON 内容')
      }
    }
  }
  return object
}
/** 默认 Cua Driver 实现；macOS 与 Windows 共用同一 CLI 协议。 */
export class LocalComputerUseDriver implements ComputerUseDriver {
  /** 当前宿主平台；允许测试在其他平台模拟路径和协议。 */
  private platform: NodeJS.Platform
  /** 环境变量快照，避免检测过程中环境变化导致候选漂移。 */
  private environment: NodeJS.ProcessEnv
  constructor(options: { platform?: NodeJS.Platform; environment?: NodeJS.ProcessEnv } = {}) {
    this.platform = options.platform ?? process.platform
    this.environment = options.environment ?? process.env
  }
  /** 验证用户选择的真实可执行普通文件。 */
  async validatePath(path: string, platform = this.platform): Promise<void> {
    const pathApi = platform === 'win32' ? win32 : posix
    const expectedName = platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'
    if (!pathApi.isAbsolute(path) || pathApi.basename(path).toLowerCase() !== expectedName) throw new Error(`请选择绝对路径下的 ${expectedName}`)
    if (!(await stat(path)).isFile()) throw new Error('Driver 必须是普通文件')
    /** Windows 不使用 Unix 可执行位，扩展名和普通文件校验由系统负责。 */
    if (platform !== 'win32') await access(path, constants.X_OK)
  }
  /** 仅检测版本，不宣称系统权限已就绪。 */
  async check(path?: string, platform = this.platform): Promise<ComputerUseInstallation> {
    const hostPlatform = installationPlatform(platform)
    /** 显式路径失败时不悄悄换用其它驱动。 */
    const paths = path ? [path] : getComputerUseDriverCandidates(platform, this.environment)
    for (const candidate of paths) {
      try { await this.validatePath(candidate, platform) } catch { if (path) return { platform: hostPlatform, status: 'needs_attention', driverPath: candidate, message: 'Driver 路径不可执行' }; continue }
      try {
        /** 精确解析版本行，防止误识别其它程序。 */
        const output = (await execute(candidate, ['--version'])).trim()
        /** 仅支持已核验的窗口语义协议版本。 */
        const version = /^cua-driver\s+(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/.exec(output)
        if (!version || output.length > 120) throw new Error('无法识别 Driver 版本')
        if (Number(version[1]) === 0 && Number(version[2]) < 38) return { platform: hostPlatform, status: 'needs_attention', driverPath: candidate, version: output.slice(11), message: '需要 Cua Driver 0.38.0 或更新版本' }
        return { platform: hostPlatform, status: 'installed', driverPath: candidate, version: output.slice(11), message: '版本检测通过；系统权限和实际输入尚未验证' }
      } catch { return { platform: hostPlatform, status: 'needs_attention', driverPath: candidate, message: 'Driver 版本检测失败' } }
    }
    return { platform: hostPlatform, status: 'not_installed', message: '未找到 Cua Driver' }
  }
  /** 执行受宿主约束的一个协议调用。 */
  async call(path: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return decodeDriverResponse(JSON.parse(await execute(path, ['call', tool, JSON.stringify(args)], signal)))
  }

  /** 用户点击后检查控件和有界截图证据；返回摘要，临时内容不交给页面或模型。 */
  async checkPermissions(path: string, signal?: AbortSignal): Promise<Omit<ComputerUsePermissions, 'checkedAt'>> {
    /** 窗口列表只能用于定位，不能证明辅助功能已授权。 */
    let listed: Record<string, unknown> | null
    try { listed = record(await this.call(path, 'list_windows', {}, signal)) }
    catch { return { accessibility: 'needs_attention', screenRecording: 'needs_attention', message: this.platform === 'win32' ? 'UI Automation 预检失败；请检查 Cua Driver 与当前 Windows 用户会话' : '辅助功能预检失败；请在 macOS 系统设置中允许 Cua Driver 访问辅助功能' } }
    if (!Array.isArray(listed?.windows)) return { accessibility: 'needs_attention', screenRecording: 'needs_attention', message: this.platform === 'win32' ? 'Driver 未返回可验证的 Windows 窗口列表' : 'Driver 未返回可验证的窗口列表' }
    /** 最多检查列表前 200 项，只选一个可定位窗口。 */
    const window = listed.windows.slice(0, 200).map(record).find(value => value && Number.isSafeInteger(value.pid) && Number(value.pid) > 0 && Number.isSafeInteger(value.window_id) && Number(value.window_id) > 0)
    if (!window) return { accessibility: 'unknown', screenRecording: 'unknown', message: '当前没有可验证的窗口；请打开一个普通应用窗口后重试' }
    /** 路径切换取消后不得继续发起截图。 */
    if (signal?.aborted) return { accessibility: 'unknown', screenRecording: 'unknown', message: '权限预检已取消' }
    /** 临时截图沿用观察链路的有界读取与清理规则。 */
    const directory = await mkdtemp(join(tmpdir(), 'dutydeck-computer-permission-'))
    /** 保留已取得的控件证据，图像失败不抹掉独立成功结果。 */
    let accessibility: ComputerUsePermissions['accessibility'] = 'unknown'
    try {
      /** 同时请求结构化控件和小尺寸画面，不发送任何输入。 */
      const result = record(await this.call(path, 'get_window_state', {
        pid: Number(window.pid), window_id: Number(window.window_id), include_accessibility_tree: true, tree_format: 'elements',
        include_screenshot: true, screenshot_out_file: join(directory, 'permission.png'), max_image_dimension: 320,
      }, signal))
      if (!result || result.pid !== window.pid || result.window_id !== window.window_id) return { accessibility: 'unknown', screenRecording: 'needs_attention', message: '预检窗口身份不匹配，请重试' }
      if (Array.isArray(result.elements) && result.elements.some(value => { const element = record(value); return typeof element?.element_token === 'string' && element.element_token.length > 0 })) accessibility = 'granted'
      /** 有效捕获标识、Driver 帧状态和实际 PNG 必须同时存在。 */
      const screenshot = result.screenshot_frame_valid === true && typeof result.capture_id === 'string' && result.capture_id.trim().length > 0 ? await readPng(join(directory, 'permission.png')) : undefined
      /** 完整解码小图，拒绝只有 PNG 头或像素流已损坏的文件；像素预算最多 320²。 */
      if (screenshot) await sharp(Buffer.from(screenshot, 'base64'), { animated: false, limitInputPixels: 320 * 320, failOn: 'warning' }).raw().toBuffer()
      return { accessibility, screenRecording: screenshot ? 'granted' : 'needs_attention', message: accessibility === 'granted' && screenshot ? '控件读取和截图预检通过；真实输入仍需首次动作验证' : '预检证据不完整；请检查系统权限，或打开含普通控件的应用窗口后重试' }
    } catch { return { accessibility, screenRecording: 'needs_attention', message: this.platform === 'win32' ? '能力预检失败；请检查 Windows UI Automation、当前用户会话和屏幕捕获权限后重试' : '权限预检失败；请检查 macOS 辅助功能和屏幕录制权限后重试' }
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
}
