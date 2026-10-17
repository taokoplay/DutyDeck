import { AsyncLocalStorage } from 'node:async_hooks'
import type { MediaRunOrigin } from '../media/media-run-service'

/** 影像工具包装器签发的主进程上下文，不属于模型可填写的参数。 */
export interface VisualMediaExecutionContext {
  sessionId: string
  productionId: string
  jobId: string
  baseRevision: number
}
/** AsyncLocalStorage 隔离同一 Agent 并发工具，避免使用共享可变的当前任务。 */
export const visualMediaExecutionContext = new AsyncLocalStorage<VisualMediaExecutionContext>()

/** 将当前可信任务加入 ComfyUI 冻结来源；普通媒体准备保持原来源。 */
export function visualMediaOrigin(origin: MediaRunOrigin, sessionId: string): MediaRunOrigin {
  const current = visualMediaExecutionContext.getStore()
  if (!current || current.sessionId !== sessionId) return origin
  return { ...origin, visualProduction: { productionId: current.productionId, jobId: current.jobId, baseRevision: current.baseRevision } }
}

/** 提交前复核持久影像来源，跨轮普通工具不能执行旧任务或改派作品。 */
export function assertVisualMediaOrigin(origin: MediaRunOrigin, sessionId: string): void {
  const binding = origin.visualProduction
  if (!binding) return
  const current = visualMediaExecutionContext.getStore()
  if (!current || current.sessionId !== sessionId || origin.actor?.sessionId !== sessionId
    || current.productionId !== binding.productionId || current.jobId !== binding.jobId || current.baseRevision !== binding.baseRevision) throw new Error('MEDIA_VISUAL_BINDING_REQUIRED')
}
