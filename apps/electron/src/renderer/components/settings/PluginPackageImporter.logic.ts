/** 浏览器拖放提供的文件摘要，避免业务函数依赖完整 File 对象。 */
export interface PluginDropFile {
  name: string
  size: number
}

/** 插件中心与主进程共享单包大小上限。 */
export const PLUGIN_DROP_MAX_BYTES = 50 * 1024 * 1024

/** 插件安装等待 Agent 空闲的最长时间，必须短于主进程十分钟预览有效期。 */
export const PLUGIN_INSTALL_BUSY_MAX_WAIT_MS = 9 * 60_000

/** 默认轮询间隔，避免高频 IPC 与界面重渲染。 */
export const PLUGIN_INSTALL_BUSY_RETRY_MS = 2_000

/** IPC 会把主进程错误包装成字符串，因此按稳定错误码识别忙碌状态。 */
export function isPluginManagementBusyError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.includes('AGENT_BUSY') || message.includes('宿主忙碌')
}

/** 把远程 IPC、超时和取消错误转换为可直接行动的界面文案。 */
export function pluginImportErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (message.includes('PLUGIN_INSTALL_WAIT_TIMEOUT')) {
    return 'Agent 仍在运行，插件尚未安装。请等待当前任务结束或停止任务后重试；已校验的插件预览仍会保留。'
  }
  if (message.includes('PLUGIN_INSTALL_WAIT_CANCELLED') || message === 'AbortError') {
    return '已停止等待，插件尚未安装。'
  }
  if (isPluginManagementBusyError(cause)) {
    return 'Agent 正在运行。当前任务结束后会自动安装，不会中断正在执行的任务。'
  }
  return message.trim() || '插件导入失败'
}

/** 忙碌重试所需的时间与取消依赖，便于确定性测试。 */
export interface PluginInstallRetryOptions {
  signal?: AbortSignal
  onBusy?: () => void
  maxWaitMs?: number
  retryMs?: number
  now?: () => number
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

/** 可取消的定时等待；取消时抛出稳定错误码而非平台相关 DOMException。 */
function defaultWait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('PLUGIN_INSTALL_WAIT_CANCELLED'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('PLUGIN_INSTALL_WAIT_CANCELLED'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 在 Agent 忙碌时保留已确认的安装意图，空闲后自动重试同一预览 token。
 * @param operation 可重复执行的安装事务；忙碌错误发生在任何写入之前。
 * @param options 超时、轮询、取消与测试替身。
 * @returns 安装事务的最终返回值。
 */
export async function installPluginWhenIdle<T>(
  operation: () => Promise<T>,
  options: PluginInstallRetryOptions = {},
): Promise<T> {
  const now = options.now ?? Date.now
  const wait = options.wait ?? defaultWait
  const maxWaitMs = options.maxWaitMs ?? PLUGIN_INSTALL_BUSY_MAX_WAIT_MS
  const retryMs = options.retryMs ?? PLUGIN_INSTALL_BUSY_RETRY_MS
  const startedAt = now()
  let reportedBusy = false
  while (true) {
    if (options.signal?.aborted) throw new Error('PLUGIN_INSTALL_WAIT_CANCELLED')
    try {
      return await operation()
    } catch (error) {
      if (!isPluginManagementBusyError(error)) throw error
      if (!reportedBusy) {
        reportedBusy = true
        options.onBusy?.()
      }
      const elapsed = now() - startedAt
      if (elapsed >= maxWaitMs) throw new Error('PLUGIN_INSTALL_WAIT_TIMEOUT')
      await wait(Math.min(retryMs, maxWaitMs - elapsed), options.signal)
    }
  }
}

/**
 * 在读取字节前校验拖放文件数量和格式。
 * @param files 当前拖放或选择操作提供的文件摘要。
 * @returns 可直接展示的错误；合法或空拖放返回 null。
 */
export function validatePluginDropFiles(files: readonly PluginDropFile[]): string | null {
  if (files.length === 0) return null
  if (files.length !== 1) return '一次只能导入一个插件包'
  const file = files[0]!
  if (!file.name.toLowerCase().endsWith('.ddplugin')) return '只支持 .ddplugin 插件包'
  if (file.size <= 0) return '插件包为空'
  if (file.size > PLUGIN_DROP_MAX_BYTES) return '插件包不能超过 50 MB'
  return null
}
