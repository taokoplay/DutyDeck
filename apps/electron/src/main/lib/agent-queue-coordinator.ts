import type { WebContents } from 'electron'
import type {
  AgentDeferredQueueMessageInput,
  AgentMoveQueuedMessageInput,
  AgentMessagePublicError,
  AgentQueuedMessageControlInput,
  AgentQueuedMessageStatus,
  AgentQueuedMessageSnapshot,
} from '@dutydeck/shared'
import type { PreparedAgentCanvasMessage } from './agent-canvas-message-preparation'

type DispatchedQueueRunInput = AgentDeferredQueueMessageInput & { runGeneration: number }

interface QueueEntry {
  input: AgentDeferredQueueMessageInput
  queuedAt: number
}

/** 单条准备的身份与协作取消入口，防旧异步回调释放新占用。 */
interface QueuePreparation {
  /** 当前正在解析的队列消息。 */
  messageId: string
  /** 取消引用读取与异步返回后的处理。 */
  controller: AbortController
}

/** deferred 在发布 started 前完成的权威运行准备结果。 */
export type PreparedAgentQueueRun = PreparedAgentCanvasMessage<AgentDeferredQueueMessageInput>

export interface AgentQueueCoordinatorOptions {
  isActive: (sessionId: string) => boolean
  getWebContents: (sessionId: string) => WebContents | null
  /** 解析输入，信号取消后不得继续创建运行或提交引用结果。 */
  prepareRun: (input: AgentDeferredQueueMessageInput, signal?: AbortSignal) => PreparedAgentQueueRun | Promise<PreparedAgentQueueRun>
  startRun: (prepared: PreparedAgentQueueRun, webContents: WebContents) => Promise<void>
  sendStatus: (webContents: WebContents, status: AgentQueuedMessageStatus) => void
  onPrepareError: (input: AgentDeferredQueueMessageInput, error: unknown) => AgentMessagePublicError
  /** 通知宿主未领取的消息被取消，或已接受的调度启动失败。 */
  onDiscard?: (input: AgentDeferredQueueMessageInput, reason: 'queue_cancelled' | 'dispatch_failed') => Promise<void> | void
}

/** 主进程持有 deferred queue；renderer 只保留展示投影。 */
export class AgentQueueCoordinator {
  private readonly queues = new Map<string, QueueEntry[]>()
  /** 正在读取引用的准备任务；取消时通过该控制器中断异步读取。 */
  private readonly preparing = new Map<string, QueuePreparation>()
  private readonly dispatching = new Map<string, string>()

  constructor(private readonly options: AgentQueueCoordinatorOptions) {}

  enqueue(input: AgentDeferredQueueMessageInput): 'started' | 'queued' {
    if (this.dispatching.get(input.sessionId) === input.queueMessageId) return 'started'
    const queue = this.queues.get(input.sessionId) ?? []
    if (queue.some((entry) => entry.input.queueMessageId === input.queueMessageId)) {
      const runStarted = this.dispatching.get(input.sessionId) === input.queueMessageId
      return runStarted ? 'started' : 'queued'
    }
    queue.push({ input, queuedAt: Date.now() })
    this.queues.set(input.sessionId, queue)
    this.tryDispatch(input.sessionId, input.queueMessageId)
    return 'queued'
  }

  cancel(input: AgentQueuedMessageControlInput): boolean {
    const queue = this.queues.get(input.sessionId)
    if (!queue) return false
    const index = queue.findIndex((entry) => entry.input.queueMessageId === input.messageId)
    if (index < 0) return false
    const [discarded] = queue.splice(index, 1)
    if (queue.length === 0) this.queues.delete(input.sessionId)
    if (discarded) {
      /** 先撤销占用身份，再发送取消信号，迟到回调只能无操作返回。 */
      const preparation = this.preparing.get(input.sessionId)
      if (preparation?.messageId === discarded.input.queueMessageId) {
        this.preparing.delete(input.sessionId)
        preparation.controller.abort()
      }
      this.notifyDiscard(discarded.input, 'queue_cancelled')
    }
    this.tryDispatch(input.sessionId)
    return true
  }

  move(input: AgentMoveQueuedMessageInput): boolean {
    const queue = this.queues.get(input.sessionId)
    if (!queue || input.sourceId === input.targetId) return false
    const sourceIndex = queue.findIndex((entry) => entry.input.queueMessageId === input.sourceId)
    const targetIndex = queue.findIndex((entry) => entry.input.queueMessageId === input.targetId)
    if (sourceIndex < 0 || targetIndex < 0) return false
    const [source] = queue.splice(sourceIndex, 1)
    if (!source) return false
    const adjustedTarget = queue.findIndex((entry) => entry.input.queueMessageId === input.targetId)
    const insertIndex = input.placement === 'after' ? adjustedTarget + 1 : adjustedTarget
    queue.splice(insertIndex, 0, source)
    return true
  }

  onRunComplete(
    sessionId: string,
    queueMessageId: string | undefined,
    backgroundTasksPending: boolean,
    stoppedByUser: boolean,
  ): void {
    if (queueMessageId && this.dispatching.get(sessionId) === queueMessageId) {
      this.dispatching.delete(sessionId)
    }
    if (backgroundTasksPending || stoppedByUser) return
    this.tryDispatch(sessionId)
  }

  onBackgroundTaskComplete(sessionId: string): void {
    this.tryDispatch(sessionId)
  }

  /** Renderer/webContents 重新可用后唤醒等待中的队列。tryDispatch 自身负责去重 active/dispatching。 */
  onTargetAvailable(sessionId: string): void {
    this.tryDispatch(sessionId)
  }

  snapshot(sessionId: string): AgentQueuedMessageSnapshot[] {
    return (this.queues.get(sessionId) ?? []).map((entry) => ({ input: { ...entry.input }, queuedAt: entry.queuedAt }))
  }

  isDispatching(sessionId: string): boolean {
    return this.preparing.has(sessionId) || this.dispatching.has(sessionId)
  }

  hasPending(sessionId: string): boolean {
    return this.dispatching.has(sessionId) || (this.queues.get(sessionId)?.length ?? 0) > 0
  }

  clear(sessionId: string): void {
    const queued = this.queues.get(sessionId) ?? []
    this.queues.delete(sessionId)
    /** 不等待底层 I/O 响应取消，立即释放会话准备槽位。 */
    const preparation = this.preparing.get(sessionId)
    this.preparing.delete(sessionId)
    preparation?.controller.abort()
    for (const entry of queued) this.notifyDiscard(entry.input, 'queue_cancelled')
    this.dispatching.delete(sessionId)
  }

  /** 回传失败不能破坏普通队列，也不能产生未处理的 Promise 拒绝。 */
  private notifyDiscard(input: AgentDeferredQueueMessageInput, reason: 'queue_cancelled' | 'dispatch_failed'): void {
    try {
      void Promise.resolve(this.options.onDiscard?.(input, reason)).catch((error: unknown) => {
        console.error('[Agent 队列] 调度终态回传失败', error)
      })
    } catch (error) {
      console.error('[Agent 队列] 调度终态回传失败', error)
    }
  }

  private tryDispatch(sessionId: string, synchronousMessageId?: string, resolved?: PreparedAgentQueueRun): void {
    if (this.preparing.has(sessionId) || this.dispatching.has(sessionId) || this.options.isActive(sessionId)) return
    while (true) {
      const queue = this.queues.get(sessionId)
      const entry = queue?.[0]
      if (!entry) return
      const messageId = entry.input.queueMessageId
      const webContents = this.options.getWebContents(sessionId)
      if (!webContents || webContents.isDestroyed()) return
      const startedAt = resolved?.input.startedAt ?? Date.now()
      let prepared: PreparedAgentQueueRun
      try {
        /** 同步端口保持原有同步拒绝语义；异步端口先锁定队首再等待。 */
        /** 每条准备独立取消，旧任务不得影响后续消息。 */
        const preparationController = new AbortController()
        const candidate = resolved ?? this.options.prepareRun({ ...entry.input, startedAt, userMessageUuid: messageId }, preparationController.signal)
        if (candidate instanceof Promise) {
          this.preparing.set(sessionId, { messageId, controller: preparationController })
          void candidate.then((result) => {
            if (this.preparing.get(sessionId)?.controller !== preparationController) return
            this.preparing.delete(sessionId)
            /** 取消、改序或外部运行抢先接管后不得启动过时队首。 */
            if (preparationController.signal.aborted || this.queues.get(sessionId)?.[0] !== entry || this.options.isActive(sessionId)) {
              this.tryDispatch(sessionId)
              return
            }
            this.tryDispatch(sessionId, undefined, result)
          }, (error: unknown) => {
            if (this.preparing.get(sessionId)?.controller !== preparationController) return
            this.preparing.delete(sessionId)
            const current = this.queues.get(sessionId)
            const index = current?.indexOf(entry) ?? -1
            if (preparationController.signal.aborted) {
              this.tryDispatch(sessionId)
              return
            }
            if (current && index >= 0) {
              current.splice(index, 1)
              if (!current.length) this.queues.delete(sessionId)
              this.notifyDiscard(entry.input, 'dispatch_failed')
              this.options.sendStatus(webContents, { sessionId, messageId, status: 'failed', error: this.options.onPrepareError(entry.input, error) })
            }
            this.tryDispatch(sessionId)
          }).catch(error => console.error('[Agent 队列] 异步引用准备失败:', error))
          return
        }
        prepared = candidate
      } catch (error) {
        this.notifyDiscard(entry.input, 'dispatch_failed')
        const publicError = this.options.onPrepareError(entry.input, error)
        queue.shift()
        if (queue.length === 0) this.queues.delete(sessionId)
        if (messageId === synchronousMessageId) throw error
        this.options.sendStatus(webContents, {
          sessionId,
          messageId,
          status: 'failed',
          error: publicError,
        })
        continue
      }
      queue.shift()
      if (queue.length === 0) this.queues.delete(sessionId)
      this.dispatching.set(sessionId, messageId)
      this.options.sendStatus(webContents, {
        sessionId,
        messageId,
        status: 'started',
        userMessage: entry.input.userMessage,
        rawUserMessage: entry.input.rawUserMessage,
        startedAt,
      })
      /** 启动端口既可能同步抛错，也可能异步拒绝；二者都必须释放精确槽位。 */
      const failed = (): void => {
        this.notifyDiscard(entry.input, 'dispatch_failed')
        this.options.sendStatus(webContents, {
          sessionId, messageId, status: 'failed',
          error: { code: 'AGENT_RUN_FAILED', message: '排队消息未能启动，请稍后重试。' },
        })
      }
      let run: Promise<void>
      try {
        run = this.options.startRun(prepared, webContents)
      } catch {
        failed()
        if (this.dispatching.get(sessionId) === messageId) this.dispatching.delete(sessionId)
        continue
      }
      void run.then(() => {
        // 正常返回也可能发生在 claim 前（预检失败或停止）；宿主仅清理仍匹配的未领取调度。
        this.notifyDiscard(entry.input, 'dispatch_failed')
        if (this.dispatching.get(sessionId) === messageId) this.dispatching.delete(sessionId)
      }, () => {
        try { failed() } finally {
          if (this.dispatching.get(sessionId) === messageId) this.dispatching.delete(sessionId)
          this.tryDispatch(sessionId)
        }
      }).catch((error: unknown) => {
        console.error('[Agent 队列] 启动失败回执发送失败', error)
      })
      return
    }
  }
}
