import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import type { VisualProductionReference, VisualProductionSnapshot } from '@dutydeck/shared'
import { VisualProductionWorkspace } from '../src/renderer/components/visual-production/VisualProductionWorkspace'
import { currentVisualProductionReferenceAtomFamily, snapshotVisualProductionReferences, visualProductionReferencesAtomFamily } from '../src/renderer/atoms/visual-production-reference-atoms'
import { visualProductionViewsAtom } from '../src/renderer/atoms/visual-production-atoms'

/** 全部测试数据只保存在隔离 renderer 内存中。 */
const store = createStore()
/** 两部无媒体作品用于验证选择与版本，不触发生成。 */
const productions: Record<string, VisualProductionSnapshot> = Object.fromEntries(['first', 'second'].map((id, index) => [id, {
  document: { schemaVersion: 1, id, revision: 1, title: index ? '第二部作品' : '第一部作品', kind: 'film', brief: '', ratio: '16:9', fps: 24, voice: '', music: '', episodes: [{ id: `${id}-episode`, title: '第一集' }], assets: [], shots: [], createdAt: 1, updatedAt: 1 },
  media: [], assetVersions: {}, shotStates: {}, candidates: [], jobs: [],
}]))
/** 所有调用、异常和延迟响应均暴露给测试，不静默忽略未知接口。 */
const calls: string[] = []
const errors: string[] = []
const listeners = new Set<(event: { workspaceId: string; productionId: string }) => void>()
const pending: Array<() => void> = []
let delayLoads = false
let sent: VisualProductionReference[] = []
window.addEventListener('error', event => errors.push(event.message))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))
Object.defineProperty(window, 'electronAPI', { value: { visualProduction: {
  onChanged: (listener: (event: { workspaceId: string; productionId: string }) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
  invoke: async (method: string, input: { sessionId: string; productionId?: string }): Promise<unknown> => {
    calls.push(`${method}:${input.sessionId}:${input.productionId ?? ''}`)
    if (method === 'list') return Object.values(productions).map(({ document }) => ({ id: document.id, title: input.sessionId === 'session-two' ? `新会话${document.title}` : document.title, kind: document.kind, revision: document.revision, episodeCount: 1, assetCount: 0, shotCount: 0, updatedAt: 1 }))
    /** 原工作台打开时调用 autoAdoptShots；此假接口仅返回内存快照，不采用任何真实候选。 */
    if (method === 'load' || method === 'autoAdoptShots') {
      if (!input.productionId || !productions[input.productionId]) throw new Error('测试作品不存在')
      const snapshot = structuredClone(productions[input.productionId])
      if (input.sessionId === 'session-two') snapshot.document.title = `新会话${snapshot.document.title}`
      if (delayLoads) await new Promise<void>(resolve => pending.push(resolve))
      return snapshot
    }
    const message = `未预期的 IPC：${method}`
    errors.push(message)
    throw new Error(message)
  },
} } })
store.set(visualProductionViewsAtom, { workspace: { productionId: 'first', episodeId: null, shotId: null, tab: 'project' } })

/** 真实工作台加最小发送快照按钮，不挂载完整 AgentView 或调用模型。 */
function Fixture(): React.ReactElement {
  const [sessionId, setSessionId] = React.useState('session-one')
  const [active, setActive] = React.useState(true)
  const [mounted, setMounted] = React.useState(true)
  Object.assign(window, { targetSmoke: {
    calls, errors, pending,
    current: (session: string = sessionId) => store.get(currentVisualProductionReferenceAtomFamily(session)),
    sent: () => sent,
    delay: () => { delayLoads = true },
    release: () => { delayLoads = false; pending.splice(0).forEach(resolve => resolve()) },
    refresh: () => { productions.second!.document.revision++; listeners.forEach(listener => listener({ workspaceId: 'workspace', productionId: 'second' })) },
    setActive, setMounted, setSessionId,
  } })
  return <Provider store={store}>
    <button id="send-snapshot" onClick={() => { sent = snapshotVisualProductionReferences(store.get(visualProductionReferencesAtomFamily(sessionId)), store.get(currentVisualProductionReferenceAtomFamily(sessionId)), 'workspace') }}>冻结发送快照</button>
    {mounted && <VisualProductionWorkspace projectId="workspace" sessionId={sessionId} paneActive={active} />}
  </Provider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
