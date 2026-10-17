import { describe, expect, test } from 'bun:test'
import { VISUAL_PRODUCTION_CHANNELS } from '@dutydeck/shared'
import { createVisualProductionPreload } from './visual-production-preload'

describe('影像创作窄桥', () => {
  test('Given 模块请求 When invoke Then 保留关联输入且只使用专属通道', async () => {
    const requests: unknown[] = []
    const api = createVisualProductionPreload(async (channel, value) => { requests.push({ channel, value }); return [] }, () => () => undefined)
    expect(await api.invoke('list', { sessionId: 'session-1' })).toEqual([])
    expect(requests).toEqual([{ channel: VISUAL_PRODUCTION_CHANNELS.INVOKE, value: { method: 'list', input: { sessionId: 'session-1' } } }])
  })
  test('Given 损坏广播 When 收到通知 Then 忽略非法数据并允许取消监听', () => {
    let listener: ((value: unknown) => void) | undefined
    let removed = false
    const values: unknown[] = []
    const api = createVisualProductionPreload(async () => undefined, (_channel, callback) => { listener = callback; return () => { removed = true } })
    const unsubscribe = api.onChanged(value => values.push(value))
    listener!(null); listener!({ workspaceId: '../bad' }); listener!({ workspaceId: 'project-1', productionId: {} })
    listener!({ workspaceId: 'project-1', productionId: 'production-1', html: 'discard' })
    expect(values).toEqual([{ workspaceId: 'project-1', productionId: 'production-1' }])
    unsubscribe(); expect(removed).toBe(true)
  })
})
