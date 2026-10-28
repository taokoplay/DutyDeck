import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComputerUseConfig, ComputerUsePermissions, ComputerUseSnapshot, ComputerUseWindow, DutyDeckPermissionMode } from '@dutydeck/shared'
import { LocalComputerUseDriver, record } from './driver'
import { readPng } from './screenshot'
import type { ComputerUseDriver } from './driver'
import { installOfficialComputerUseDriver, DriverInstallError } from './installer'
import type { DriverInstallProgress } from './installer'

/** 一次观察发给模型的有界结果。 */
export interface ComputerUseObservation { observationId: string; text: string; image?: { data: string; mimeType: 'image/png' } }
/** 仅允许当前观察签发的语义 token 动作。 */
export type ComputerUseActionInput = { observationId: string; elementToken: string } & (
  { kind: 'click' } | { kind: 'type'; text: string } | { kind: 'key'; key: string } | { kind: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; amount?: number })
/** 动态运行授权，工具审批后仍须再次检查。 */
export interface ComputerUseRunContext { sessionId: string; signal: AbortSignal; assertActive: () => void; getPermissionMode: () => DutyDeckPermissionMode }
/** 每轮 Agent 的受控桌面接口。 */
export interface ComputerUseRun {
  discover(signal?: AbortSignal): Promise<ComputerUseWindow[]>
  observe(target: { pid: number; windowId: string }, signal?: AbortSignal): Promise<ComputerUseObservation>
  action(input: ComputerUseActionInput, signal?: AbortSignal): Promise<unknown>
  stop(): Promise<void>
  dispose(): Promise<void>
}
/** 不持久化任何窗口内容的服务依赖。 */
export interface ComputerUseServiceOptions {
  platform?: NodeJS.Platform
  driver?: ComputerUseDriver
  loadConfig: () => ComputerUseConfig
  saveConfig: (config: ComputerUseConfig) => void
  /** 可替换官方安装边界；不向 Agent 或 renderer 暴露命令。 */
  installDriver?: (progress: DriverInstallProgress, signal: AbortSignal) => Promise<void>
}
/** 主进程单实例服务，保证本应用内仅一个桌面租约。 */
export class ComputerUseService {
  /** 最新内存状态。 */
  private snapshot: ComputerUseSnapshot
  /** 状态订阅者。 */
  private listeners = new Set<(snapshot: ComputerUseSnapshot) => void>()
  /** 当前租约所属运行。 */
  private owner: ComputerUseRun | null = null
  /** 可替换驱动用于隔离测试。 */
  private driver: ComputerUseDriver
  /** 路径切换期间封闭所有新调用，防止使用旧安装授权。 */
  private changingDriver = false
  /** 安装检测序号，阻止旧检测覆盖新路径。 */
  private inspection = 0
  /** 权限预检独占桌面读取入口；切换路径时取消旧请求。 */
  private permissionCheck: AbortController | null = null
  /** 当前平台。 */
  private platform: NodeJS.Platform
  /** 安装期间拒绝路径、权限、发现和输入交错。 */
  private installing = false
  /** 应用退出时撤销安装，等待下载、子进程与临时文件完成清理。 */
  private installController: AbortController | null = null
  /** 退出调用等待此 Promise，直到安装器的 finally 已完成。 */
  private installCompletion: Promise<void> | null = null
  /** 退出后不再接受新的桌面或安装请求。 */
  private shuttingDown = false
  /** 包括尚未取得租约的发现运行；升级前全部撤销并等待退出。 */
  private runs = new Set<ComputerUseRun>()
  /** 初始化配置，不启动外部程序。 */
  constructor(private options: ComputerUseServiceOptions) {
    this.platform = options.platform ?? process.platform
    this.driver = options.driver ?? new LocalComputerUseDriver({ platform: this.platform })
    this.snapshot = { config: options.loadConfig(), installation: null, operation: null }
  }
  /** 返回独立快照，避免订阅方修改授权状态。 */
  getSnapshot(): ComputerUseSnapshot { return structuredClone(this.snapshot) }
  /** 订阅主进程状态变化。 */
  subscribe(listener: (snapshot: ComputerUseSnapshot) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  /** 发布更新；隔离 UI 监听器异常。 */
  private emit(): void { for (const listener of this.listeners) { try { listener(this.getSnapshot()) } catch { /* UI 异常不得破坏租约清理。 */ } } }
  /** 仅查询驱动版本。 */
  async checkInstallation(): Promise<ComputerUseSnapshot> {
    if (this.shuttingDown) throw new Error('应用正在退出，不能检测 Driver')
    if (this.installing) throw new Error('Driver 安装正在进行，请稍后重试')
    /** 当前检测版本。 */
    const revision = ++this.inspection
    /** 安装身份重新验证后，旧权限证据不再代表当前 Driver。 */
    delete this.snapshot.permissions
    this.emit()
    /** 检测期间配置可能改变。 */
    const installation: ComputerUseSnapshot['installation'] = this.platform === 'darwin' || this.platform === 'win32'
      ? await this.driver.check(this.snapshot.config.driverPath, this.platform)
      : { platform: this.platform === 'linux' ? 'linux' : 'unsupported', status: 'unsupported', message: '当前仅支持 macOS 和 Windows' }
    if (revision === this.inspection) { this.snapshot.installation = installation; this.emit() }
    return this.getSnapshot()
  }
  /** 用户主动安装：独占维护入口，重新检测真实版本后才报告成功。 */
  async installDriver(): Promise<ComputerUseSnapshot> {
    if (this.shuttingDown) throw new Error('应用正在退出，不能安装 Driver')
    if (this.platform !== 'darwin' && this.platform !== 'win32') throw new Error('当前仅支持 macOS 和 Windows')
    if (this.installing) throw new Error('Driver 安装正在进行，请稍后重试')
    if (this.changingDriver || this.permissionCheck) throw new Error('请等待路径切换或权限预检结束后再安装')
    this.installing = true
    /** 在首次异步操作前建立退出等待点，覆盖停止旧运行的阶段。 */
    const controller = new AbortController()
    this.installController = controller
    let complete!: () => void
    this.installCompletion = new Promise<void>(resolve => { complete = resolve })
    this.inspection += 1
    this.snapshot.installation = null
    delete this.snapshot.permissions
    this.snapshot.driverSetup = { status: 'downloading', message: '正在准备官方安装器，停止当前电脑控制…' }
    this.emit()
    try {
      await Promise.all([...this.runs].map(run => run.stop()))
      controller.signal.throwIfAborted()
      /** 只允许固定阶段，不把安装脚本输出当成用户说明。 */
      const progress: DriverInstallProgress = status => {
        this.snapshot.driverSetup = { status, message: status === 'downloading' ? '正在下载 Cua 官方安装器…' : '正在安装 Cua Driver，请勿退出应用；首次安装可能需要系统确认…' }
        this.emit()
      }
      await (this.options.installDriver ?? ((update, signal) => installOfficialComputerUseDriver(update, this.platform, signal)))(progress, controller.signal)
      controller.signal.throwIfAborted()
      this.snapshot.driverSetup = { status: 'verifying', message: '安装器已退出，正在核对 Driver 版本…' }; this.emit()
      /** 官方安装器使用标准位置，不能继续验证用户先前选择的自定义旧副本。 */
      const installation = await this.driver.check(undefined, this.platform)
      controller.signal.throwIfAborted()
      this.snapshot.installation = installation
      if (installation.status !== 'installed' || !installation.driverPath) throw new DriverInstallError('安装结束，但未检测到兼容版本。请检测安装，或选择已安装的 Driver 后重试。')
      /** 确认写盘后才切换实际执行路径，失败时保留用户配置。 */
      const config = { ...this.snapshot.config, driverPath: installation.driverPath }
      this.options.saveConfig(config); this.snapshot.config = config
      this.snapshot.driverSetup = { status: 'succeeded', message: `Driver ${installation.version ?? ''} 已安装。请继续验证系统权限。` }
    } catch (error) {
      this.snapshot.driverSetup = { status: 'failed', message: controller.signal.aborted ? '安装已取消' : error instanceof DriverInstallError ? error.message : '安装未完成，请检查网络、代理及安装目录权限后重试；也可打开官方安装说明。' }
    } finally { this.installing = false; this.installController = null; this.installCompletion = null; this.emit(); complete() }
    return this.getSnapshot()
  }
  /** 应用退出专用：立即撤权，返回所有安装和桌面运行实际清理完成的等待点。 */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    this.inspection += 1
    this.installController?.abort()
    this.permissionCheck?.abort()
    await Promise.all([this.installCompletion, ...[...this.runs].map(run => run.stop())])
  }
  /** 用户主动验证桌面控件树和截图能力；启动与普通对话不触发桌面读取。 */
  async checkPermissions(): Promise<ComputerUseSnapshot> {
    if (this.shuttingDown) throw new Error('应用正在退出，不能验证权限')
    if (this.installing) throw new Error('Driver 安装正在进行，请稍后重试')
    if (this.changingDriver) throw new Error('Driver 路径正在切换，请稍后重试')
    if (this.permissionCheck) throw new Error('权限预检正在进行，请稍后重试')
    if (this.owner) throw new Error('当前会话正在控制电脑，请先停止操作再验证权限')
    /** 在第一个 await 前占用预检入口，禁止并发采集。 */
    const controller = new AbortController()
    this.permissionCheck = controller
    try {
      /** 不支持的平台不启动任何外部进程；Windows 走 UI Automation 预检。 */
      if (this.platform !== 'darwin' && this.platform !== 'win32') {
        this.snapshot.permissions = { accessibility: 'unknown', screenRecording: 'unknown', checkedAt: Date.now(), message: '当前仅支持 macOS 和 Windows' }
        this.emit()
        return this.getSnapshot()
      }
      /** 安装检查可能等待外部进程，返回后必须复核路径切换和取消状态。 */
      const installation = this.snapshot.installation ?? (await this.checkInstallation()).installation
      if (this.changingDriver || controller.signal.aborted) return this.getSnapshot()
      if (!installation || installation.status !== 'installed' || !installation.driverPath) {
        this.snapshot.permissions = { accessibility: 'unknown', screenRecording: 'unknown', checkedAt: Date.now(), message: '请先安装并检测兼容的 Cua Driver' }
        this.emit()
        return this.getSnapshot()
      }
      /** 绑定本次安装身份，迟到结果不能覆盖新检测。 */
      const inspection = this.inspection
      /** 仅使用已确认的可执行路径。 */
      const driverPath = installation.driverPath
      /** 可选能力缺失时保持未知，不推断系统权限。 */
      const probe = this.driver.checkPermissions
        ? await this.driver.checkPermissions(driverPath, controller.signal)
        : { accessibility: 'unknown' as const, screenRecording: 'unknown' as const, message: '当前 Driver 未提供可验证的权限预检' }
      if (controller.signal.aborted || this.changingDriver || inspection !== this.inspection || this.snapshot.installation?.driverPath !== driverPath) return this.getSnapshot()
      /** 时间代表预检完成，不代表系统授权永久有效。 */
      const permissions: ComputerUsePermissions = { ...probe, checkedAt: Date.now() }
      this.snapshot.permissions = permissions
      this.emit()
      return this.getSnapshot()
    } finally { if (this.permissionCheck === controller) this.permissionCheck = null }
  }
  /** 关闭先撤权，随后取消租约。 */
  async setEnabled(enabled: boolean): Promise<ComputerUseSnapshot> {
    if (this.shuttingDown) throw new Error('应用正在退出，不能修改电脑控制配置')
    if (typeof enabled !== 'boolean') throw new Error('启用状态无效')
    /** 写盘成功后才发布配置。 */
    const config = { ...this.snapshot.config, enabled }
    this.options.saveConfig(config); this.snapshot.config = config; this.emit()
    if (!enabled) { this.permissionCheck?.abort(); await this.owner?.stop() }
    return this.getSnapshot()
  }
  /** 文件选择器提供路径；更换前终止旧驱动租约。 */
  async setDriverPath(path: string): Promise<ComputerUseSnapshot> {
    if (this.shuttingDown) throw new Error('应用正在退出，不能切换 Driver')
    if (this.installing) throw new Error('Driver 安装正在进行，请稍后重试')
    if (this.changingDriver) throw new Error('Driver 路径正在切换')
    this.changingDriver = true
    this.permissionCheck?.abort()
    try {
      await this.driver.validatePath(path, this.platform)
      await this.owner?.stop()
      /** 旧检测不能授权新路径。 */
      const config = { ...this.snapshot.config, driverPath: path }
      this.options.saveConfig(config); this.snapshot.config = config; this.inspection += 1; this.snapshot.installation = null; delete this.snapshot.permissions; this.emit()
      return await this.checkInstallation()
    } finally { this.changingDriver = false }
  }

  /** 旧 UI 标识不会误停新操作。 */
  async stop(operationId: string): Promise<ComputerUseSnapshot> { if (this.snapshot.operation?.id === operationId) await this.owner?.stop(); return this.getSnapshot() }
  /** 创建一次不可复活的 Agent 操作运行。 */
  createRun(context: ComputerUseRunContext): ComputerUseRun {
    /** Driver 会话并非权限边界，仅用于驱动内部清理。 */
    const session = `dutydeck-${randomUUID()}`
    /** 本轮宿主停止信号。 */
    const controller = new AbortController()
    /** 禁止同一运行交错命令。 */
    let pending: Promise<unknown> | null = null
    /** 终态清理 Promise，多次停止幂等。 */
    let stopping: Promise<void> | null = null
    /** 当前观察签发的语义授权。 */
    let observation: { id: string; target: ComputerUseWindow; tokens: Set<string> } | null = null
    /** 保存用过的 Driver 路径，清理不受后续配置影响。 */
    let usedPath: string | undefined
    /** 检测前也必须具备仍有效的用户运行授权。 */
    const assertRun = (): void => {
      if (this.shuttingDown) throw new Error('应用正在退出，电脑控制已停止')
      if (controller.signal.aborted || context.signal.aborted) throw new Error('电脑控制已停止')
      context.assertActive()
      if (this.installing) throw new Error('Driver 安装正在进行，请稍后重试')
      if (this.changingDriver) throw new Error('Driver 路径正在切换')
      if (this.permissionCheck) throw new Error('权限预检正在进行，请稍后重试')
      if (context.getPermissionMode() === 'plan') throw new Error('计划模式不允许电脑控制')
      if (!this.snapshot.config.enabled) throw new Error('电脑控制尚未启用')
    }
    /** 真正调用前复核安装及固定驱动身份。 */
    const assert = (): string => {
      assertRun()
      if ((this.platform !== 'darwin' && this.platform !== 'win32') || this.snapshot.installation?.status !== 'installed' || !this.snapshot.installation.driverPath) throw new Error('请先检测兼容的 Cua Driver')
      if (usedPath && usedPath !== this.snapshot.installation.driverPath) throw new Error('Driver 已更换，请开始新的电脑控制运行')
      return this.snapshot.installation.driverPath
    }
    /** 合并取消信号，在命令退出后释放所有监听器。 */
    const call = async (tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
      usedPath = assert()
      /** 工具调用局部取消控制器。 */
      const combined = new AbortController()
      /** 每个来源的同一清理函数。 */
      const abort = (): void => combined.abort()
      /** 当前调用关注的信号集合。 */
      const signals = [controller.signal, context.signal, ...(signal ? [signal] : [])]
      for (const item of signals) { item.addEventListener('abort', abort, { once: true }); if (item.aborted) abort() }
      try { if (combined.signal.aborted) throw new Error('电脑控制已取消'); const value = await this.driver.call(usedPath, tool, { ...args, session }, combined.signal); assert(); if (combined.signal.aborted) throw new Error('电脑控制已取消'); return value }
      finally { for (const item of signals) item.removeEventListener('abort', abort) }
    }
    /** 序列边界拒绝同时调用。 */
    const command = <T>(work: () => Promise<T>): Promise<T> => {
      if (pending) return Promise.reject(new Error('当前运行已有电脑控制调用'))
      /** 微任务起点确保 pending 在任何停止发生前赋值。 */
      const result = Promise.resolve().then(async () => {
        assertRun()
        if (!this.snapshot.installation) await this.checkInstallation()
        assert(); return work()
      })
      pending = result
      void result.then(() => { if (pending === result) pending = null }, () => { if (pending === result) pending = null })
      return result
    }
    /** 获取有限且格式准确的窗口。 */
    const windows = async (signal?: AbortSignal): Promise<ComputerUseWindow[]> => {
      /** 原始列表协议。 */
      const data = record(await call('list_windows', {}, signal))
      if (!Array.isArray(data?.windows)) throw new Error('Driver 窗口列表无效')
      return data.windows.slice(0, 200).flatMap(value => {
        /** 仅保留安全整数窗口身份。 */
        const entry = record(value)
        return entry && Number.isSafeInteger(entry.pid) && Number(entry.pid) > 0 && Number.isSafeInteger(entry.window_id) && Number(entry.window_id) > 0 ? [{ pid: Number(entry.pid), windowId: String(entry.window_id), title: typeof entry.title === 'string' ? entry.title.slice(0, 256) : '' }] : []
      })
    }
    /** 使用最新列表复核窗口身份，防止审批后目标失效。 */
    const verify = async (target: { pid: number; windowId: string }, signal?: AbortSignal): Promise<ComputerUseWindow> => {
      /** 可见窗口匹配项。 */
      const found = (await windows(signal)).find(item => item.pid === target.pid && item.windowId === target.windowId)
      if (!found) throw new Error('目标窗口已不可用，请重新发现')
      return found
    }
    /** 运行对象闭包持有唯一授权和清理状态。 */
    const run: ComputerUseRun = {
      discover: signal => command(() => windows(signal)),
      observe: (target, signal) => command(async () => {
        if (this.owner && this.owner !== run) throw new Error('桌面已被其它会话占用')
        this.owner = run
        observation = null
        /** 观察前创建租约，使等待期间也可停止。 */
        this.snapshot.operation = { ...target, title: '', id: this.snapshot.operation?.id ?? randomUUID(), sessionId: context.sessionId, startedAt: Date.now(), status: 'active' }; this.emit()
        /** 宿主独占临时截图路径。 */
        const directory = await mkdtemp(join(tmpdir(), 'dutydeck-computer-'))
        try {
          /** 最新窗口身份。 */
          const found = await verify(target, signal)
          /** 驱动仅能写当前临时文件。 */
          const path = join(directory, 'capture.png')
          /** 观察响应。 */
          const data = record(await call('get_window_state', { pid: found.pid, window_id: Number(found.windowId), include_accessibility_tree: true, tree_format: 'elements', include_screenshot: true, screenshot_out_file: path, max_image_dimension: 1280 }, signal))
          if (!data || data.pid !== found.pid || data.window_id !== Number(found.windowId)) throw new Error('观察窗口身份不匹配')
          /** 只向模型返回完整的有界 elements，签发集合与可见输出完全一致。 */
          const tokens = new Set<string>()
          /** 已选择的真实元素；不信任 tree_markdown 中的伪造 token 文本。 */
          const elements: Record<string, unknown>[] = []
          /** 输出累计长度，保证不会截断 JSON 或隐藏已授权 token。 */
          let textLength = 2
          if (!Array.isArray(data.elements)) throw new Error('Driver 缺少语义元素列表')
          for (const value of data.elements.slice(0, 200)) {
            /** 协议中单个语义节点。 */
            const element = record(value)
            if (!element || typeof element.element_token !== 'string' || !element.element_token || element.element_token.length > 512) continue
            /** 按完整节点计算有界输出长度。 */
            const encoded = JSON.stringify(element)
            if (textLength + encoded.length + 1 > 31800) continue
            elements.push(element); tokens.add(element.element_token); textLength += encoded.length + 1
          }
          /** 模型实际看到的 token 与当前授权严格对应。 */
          const text = JSON.stringify(elements)
          /** 图片只保留本轮最后一帧。 */
          const image = data.screenshot_frame_valid === true && typeof data.capture_id === 'string' ? await readPng(path) : undefined
          assert()
          if (signal?.aborted) throw new Error('观察已取消')
          /** 每次观察轮换授权身份。 */
          const id = randomUUID()
          observation = { id, target: found, tokens }
          if (this.snapshot.operation) this.snapshot.operation = { ...this.snapshot.operation, ...found, observedAt: Date.now(), image: image ? `data:image/png;base64,${image}` : undefined }
          this.emit()
          return { observationId: id, text: `${text}\n${image ? '截图对应本次观察。' : '本次截图不可用；仅提供语义元素，不代表视觉状态已验证。'}`, ...(image ? { image: { data: image, mimeType: 'image/png' as const } } : {}) }
        } finally { await rm(directory, { recursive: true, force: true }) }
      }),
      action: (input, signal) => command(async () => {
        if (this.owner !== run || !observation || observation.id !== input.observationId) throw new Error('观察已失效，请重新观察')
        if (!observation.tokens.has(input.elementToken)) throw new Error('element token 不属于当前观察')
        if (input.kind === 'type' && (typeof input.text !== 'string' || input.text.length > 4000)) throw new Error('输入文本超限')
        if (input.kind === 'key' && !/^(return|tab|escape|up|down|left|right|space|delete|home|end|pageup|pagedown|f(?:[1-9]|1[0-2])|[a-z0-9])$/.test(input.key)) throw new Error('不支持的按键')
        if (input.kind === 'scroll' && (!['up','down','left','right'].includes(input.direction) || (input.amount !== undefined && (!Number.isInteger(input.amount) || input.amount < 1 || input.amount > 10)))) throw new Error('滚动参数无效')
        if (!['click','type','key','scroll'].includes(input.kind)) throw new Error('不支持的动作')
        /** 审批返回后再核对目标。 */
        const target = await verify(observation.target, signal)
        /** 一次尝试即消费 token，失败也不可重放。 */
        observation = null
        /** 所有定位字段由宿主注入。 */
        const args: Record<string, unknown> = { target: { kind: 'window', pid: target.pid, window_id: Number(target.windowId) }, element_token: input.elementToken, delivery_mode: 'background' }
        if (input.kind === 'click') args.action = 'press'
        if (input.kind === 'type') args.text = input.text
        if (input.kind === 'key') args.key = input.key
        if (input.kind === 'scroll') { args.direction = input.direction; args.amount = input.amount ?? 3; args.by = 'line' }
        /** 操作结果不等于业务成功，调用方必须再次观察。 */
        return call(({ click: 'click', type: 'type_text', key: 'press_key', scroll: 'scroll' } as const)[input.kind], args, signal)
      }),
      stop: () => {
        if (stopping) return stopping
        controller.abort(); observation = null
        if (this.owner === run && this.snapshot.operation) { this.snapshot.operation.status = 'stopping'; this.emit() }
        stopping = (async () => {
          try { await pending?.catch(() => {}); if (usedPath) await this.driver.call(usedPath, 'end_session', { session }).catch(() => {}) }
          finally { this.runs.delete(run); context.signal.removeEventListener('abort', onAbort); if (this.owner === run) { this.owner = null; this.snapshot.operation = null; this.emit() } }
        })()
        return stopping
      },
      dispose: () => run.stop(),
    }
    /** Agent 结束信号立即撤权。 */
    const onAbort = (): void => { void run.stop() }
    this.runs.add(run)
    context.signal.addEventListener('abort', onAbort, { once: true })
    if (context.signal.aborted) onAbort()
    return run
  }
}
