import { VISUAL_PRODUCTION_CHANNELS, assertVisualProductionId } from '@proma/shared'
import type { VisualProductionApi, VisualProductionInputs, VisualProductionMethod, VisualProductionResults } from '@proma/shared'

/** 构造 renderer 窄桥，不向页面传递 Electron 事件或路径权限。 */
export function createVisualProductionPreload(
  invoke: (channel: string, value: unknown) => Promise<unknown>,
  subscribe: (channel: string, listener: (value: unknown) => void) => () => void,
): VisualProductionApi {
  return {
    async invoke<M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M]): Promise<VisualProductionResults[M]> {
      return await invoke(VISUAL_PRODUCTION_CHANNELS.INVOKE, { method, input }) as VisualProductionResults[M]
    },
    onChanged(callback) {
      return subscribe(VISUAL_PRODUCTION_CHANNELS.CHANGED, (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return
        /** 广播仅接受项目与作品标识，不转发附带正文。 */
        const event = value as { workspaceId?: unknown; productionId?: unknown }
        try {
          assertVisualProductionId(event.workspaceId)
          if (event.productionId !== undefined) assertVisualProductionId(event.productionId)
          callback({ workspaceId: event.workspaceId, ...(typeof event.productionId === 'string' ? { productionId: event.productionId } : {}) })
        } catch { /* 损坏广播不进入 UI 状态。 */ }
      })
    },
  }
}
