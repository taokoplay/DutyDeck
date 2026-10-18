import { applyAgentQueuedMessageFailedStatus, applyAgentQueuedMessageStartedStatus, mergeRestoredAgentQueuedMessages } from '@/hooks/useGlobalAgentListeners'
import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { mergeVisualProductionReferences, removeSentVisualProductionReferences, restoreVisualProductionReferences } from '@dutydeck/shared'
import type { VisualProductionReference } from '@dutydeck/shared'
import { visualProductionReferencesAtomFamily } from '@/atoms/visual-production-reference-atoms'
import { agentSessionDraftsAtom, agentSessionMessageQueueAtom, liveMessagesMapAtom } from '@/atoms/agent-atoms'
import { VisualProductionReferenceChips } from './VisualProductionReferenceChips'
import { createAgentQueuedMessage, buildQueuedMessageSendPayload, submitQueuedMessagePayload } from '@/lib/agent-message-queue'
import { shouldRenderUserMessageContent } from '@/components/agent/SDKMessageRenderer'
import { UserMessageContent } from '@/components/ai-elements/message'

/** 影像引用夹具。 */
const reference: VisualProductionReference = { workspaceId: 'w', productionId: 'p', productionRevision: 3, target: { kind: 'shot', shotId: 's' }, title: '刀下暂留人', productionTitle: '大胤刑警' }
describe('影像对象引用交互', () => {
  test('Given 已有草稿 When 添加引用 Then 保留正文且会话隔离，显示可读chip而非内部ID', () => {
    const store = createStore()
    store.set(agentSessionDraftsAtom, new Map([['s', '不要修改的草稿\n第二行']]))
    store.set(visualProductionReferencesAtomFamily('s'), current => mergeVisualProductionReferences(current, [reference]))
    expect(store.get(agentSessionDraftsAtom).get('s')).toBe('不要修改的草稿\n第二行')
    expect(store.get(visualProductionReferencesAtomFamily('other'))).toEqual([])
    const html = renderToStaticMarkup(<VisualProductionReferenceChips references={store.get(visualProductionReferencesAtomFamily('s'))} onRemove={() => {}} />)
    expect(html).toContain('刀下暂留人')
    expect(html).toContain('大胤刑警')
    expect(html).toContain('v3')
    expect(html).toContain('移除刀下暂留人引用')
    expect(html).not.toContain('productionId')
  })
  test('Given 仅引用无正文 When 排队和提交 Then 身份版本完整保留且可发送', async () => {
    const message = createAgentQueuedMessage('', 'm', 1, null, { visualProductionReferences: [reference] })
    const payload = buildQueuedMessageSendPayload(message)
    expect(payload.visualProductionReferences).toEqual([reference])
    let submitted = false
    expect(await submitQueuedMessagePayload(payload, async () => { submitted = true })).toBe('submitted')
    expect(submitted).toBe(true)
    expect(shouldRenderUserMessageContent('', undefined, [reference])).toBe(true)
    expect(renderToStaticMarkup(<UserMessageContent sdkUserMessage={{ _visualProductionReferences: [reference] }}>{''}</UserMessageContent>)).toContain('刀下暂留人')
  })
  test('Given 主进程队列快照 When 恢复后启动或失败 Then 引用随历史/草稿完整恢复', () => {
    const store = createStore()
    const restored = mergeRestoredAgentQueuedMessages([], [{ queuedAt: 1, input: { sessionId: 's', queueMessageId: 'm', userMessage: '', channelId: 'c', visualProductionReferences: [reference] } }])
    expect(restored[0]?.visualProductionReferences).toEqual([reference])
    store.set(agentSessionMessageQueueAtom, new Map([['s', restored]]))
    applyAgentQueuedMessageStartedStatus(store, { sessionId: 's', messageId: 'm', status: 'started', userMessage: '', startedAt: 100 })
    expect(store.get(liveMessagesMapAtom).get('s')?.[0]).toMatchObject({ _visualProductionReferences: [reference] })
    store.set(agentSessionMessageQueueAtom, new Map([['s', restored]]))
    store.set(agentSessionDraftsAtom, new Map([['s', '后来写的草稿']]))
    expect(applyAgentQueuedMessageFailedStatus(store, { sessionId: 's', messageId: 'm', status: 'failed', error: { code: 'VISUAL_REFERENCE_INVALID', message: '版本变化' } })).toBe(true)
    expect(store.get(visualProductionReferencesAtomFamily('s'))).toEqual([reference])
    expect(store.get(agentSessionDraftsAtom).get('s')).toContain('后来写的草稿')
  })

  test('Given 发送期间用户更新引用 When 清理或失败恢复 Then 不覆盖新版本', () => {
    const updated = { ...reference, productionRevision: 4 }
    expect(removeSentVisualProductionReferences([updated], [reference])).toEqual([updated])
    expect(restoreVisualProductionReferences([updated], [reference])).toEqual([updated])
  })
})
