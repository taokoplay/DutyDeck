import type { AgentPluginHealth } from '@dutydeck/shared'

export interface AgentPluginHealthEvent {
  type: 'plugin-health'
  health: AgentPluginHealth
}

export type AgentPluginHostEventListener = (event: AgentPluginHealthEvent) => void

/** 轻量健康事件总线；宿主和 renderer bridge 之间只传可序列化状态。 */
export class AgentPluginHostEventBus {
  private readonly listeners = new Set<AgentPluginHostEventListener>()

  /** 订阅健康变化并返回取消订阅函数。 */
  subscribe(listener: AgentPluginHostEventListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 发布一份不可变快照，避免监听方修改宿主状态。 */
  emit(event: AgentPluginHealthEvent): void {
    for (const listener of this.listeners) {
      try { listener({ type: event.type, health: { ...event.health } }) }
      catch (error) { console.warn('[Agent Plugin Host] 健康事件监听失败:', error) }
    }
  }
}
