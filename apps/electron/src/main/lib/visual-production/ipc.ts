import { VISUAL_PRODUCTION_CHANNELS, parseVisualProductionCommand } from '@dutydeck/shared'
import type { VisualProductionExecutor } from './access'

/** 不泄漏 Electron 对象到业务服务的 sender 形状。 */
export interface VisualProductionIpcEvent { sender: { id: number } }

/** 注册宿主最小能力。 */
export interface VisualProductionIpcDependencies {
  /** 只注册一个严格解析的命令通道。 */
  ipc: { handle(channel: string, handler: (event: VisualProductionIpcEvent, input: unknown) => Promise<unknown>): void; removeHandler(channel: string): void }
  /** 仅允许应用正式窗口。 */
  isAuthorizedSender(event: VisualProductionIpcEvent): boolean
  /** 身份、项目路径和权限一律由宿主解析。 */
  createAccess(sessionId: string, assertCaller: () => void): VisualProductionExecutor
}

/** 注册经过 sender、命令和会话三层校验的模块 IPC。 */
export function registerVisualProductionIpc(dependencies: VisualProductionIpcDependencies): { dispose(): void } {
  dependencies.ipc.handle(VISUAL_PRODUCTION_CHANNELS.INVOKE, async (event, value) => {
    const assertCaller = (): void => {
      if (!dependencies.isAuthorizedSender(event)) throw new Error('VISUAL_PRODUCTION_ACCESS_DENIED: 非法窗口')
    }
    assertCaller()
    const command = parseVisualProductionCommand(value)
    const access = dependencies.createAccess(command.input.sessionId, assertCaller)
    return access.execute(command.method, command.input)
  })
  return { dispose: () => dependencies.ipc.removeHandler(VISUAL_PRODUCTION_CHANNELS.INVOKE) }
}
