import type {
  AgentMessageInvokeResult,
  AgentQueueMessageInput,
  AgentSendInput,
  AgentSubmitOrEnqueueInput,
  AgentSubmitOrEnqueueResult,
} from '@dutydeck/shared'
import { AGENT_IPC_CHANNELS } from '@dutydeck/shared'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { PreparedAgentCanvasMessage } from './agent-canvas-message-preparation'
import { runAgentMessageInvoke } from './agent-canvas-message-preparation'

/** Agent 消息 handler 所需的最小 ipcMain 注册表面。 */
export interface AgentMessageIpcRegistrar {
  handle: (
    channel: string,
    handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>,
  ) => void
}

/** 三条 Agent 消息 IPC 的可注入生产依赖。 */
export interface AgentMessageIpcDependencies<TSession> {
  ipc: AgentMessageIpcRegistrar
  requireVisibleSession: (sessionId: string) => TSession
  prepareRun: (input: AgentSendInput) => PreparedAgentCanvasMessage<AgentSendInput> | Promise<PreparedAgentCanvasMessage<AgentSendInput>>
  reserveStart: (sessionId: string) => () => void
  startSessionMirrorRun: (session: TSession) => Promise<unknown>
  runPrepared: (prepared: PreparedAgentCanvasMessage<AgentSendInput>, webContents: WebContents) => Promise<void>
  queueMessage: (input: AgentQueueMessageInput, webContents: WebContents) => Promise<string>
  submitOrEnqueue: (input: AgentSubmitOrEnqueueInput, webContents: WebContents) => Promise<AgentSubmitOrEnqueueResult>
}

/** 注册普通发送、活跃注入与 deferred 原子提交的真实安全信封 handler。 */
export function registerAgentMessageIpcHandlers<TSession>(
  dependencies: AgentMessageIpcDependencies<TSession>,
): void {
  /** 保留统一 guard 名称，供全部 Renderer IPC 安全矩阵审计。 */
  const requireVisibleSession = dependencies.requireVisibleSession
  dependencies.ipc.handle(
    AGENT_IPC_CHANNELS.SEND_MESSAGE,
    async (event, input): Promise<AgentMessageInvokeResult<void>> => {
      const sendInput = withoutModuleCommandClaim(input as AgentSendInput)
      const session = requireVisibleSession(sendInput.sessionId)
      return runAgentMessageInvoke(async () => {
        /** 在任何消息接管副作用前固化 Canvas 引用。 */
        const preparation = dependencies.prepareRun(sendInput)
        /** 异步引用读取期间占住可停止启动槽位；同步解析失败仍不产生接管副作用。 */
        let releaseStart: () => void
        try { releaseStart = dependencies.reserveStart(sendInput.sessionId) } catch (error) {
          if (preparation instanceof Promise) void preparation.catch(() => undefined)
          throw error
        }
        try {
          const prepared = await preparation
          requireVisibleSession(sendInput.sessionId)
          await dependencies.startSessionMirrorRun(session).catch((error) => {
            console.error('[飞书 Session 镜像] 流式卡片初始化失败:', error)
          })
          await dependencies.runPrepared(prepared, event.sender)
        } finally {
          releaseStart()
        }
      })
    },
  )

  dependencies.ipc.handle(
    AGENT_IPC_CHANNELS.QUEUE_MESSAGE,
    async (event, input): Promise<AgentMessageInvokeResult<string>> => {
      const queueInput = withoutModuleCommandClaim(input as AgentQueueMessageInput)
      requireVisibleSession(queueInput.sessionId)
      return runAgentMessageInvoke(() => dependencies.queueMessage(queueInput, event.sender))
    },
  )

  dependencies.ipc.handle(
    AGENT_IPC_CHANNELS.SUBMIT_OR_ENQUEUE_MESSAGE,
    async (event, input): Promise<AgentMessageInvokeResult<AgentSubmitOrEnqueueResult>> => {
      const submitInput = withoutModuleCommandClaim(input as AgentSubmitOrEnqueueInput)
      requireVisibleSession(submitInput.sessionId)
      return runAgentMessageInvoke(() => dependencies.submitOrEnqueue(submitInput, event.sender))
    },
  )
}

/** 普通消息不可冒充持久化模块命令；只有专用 outbox dispatcher 能附加命令身份。 */
function withoutModuleCommandClaim<T extends object>(input: T): T {
  return { ...input, moduleCommandId: undefined }
}
