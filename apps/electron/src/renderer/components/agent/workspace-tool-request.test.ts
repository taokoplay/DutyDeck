import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { currentAgentSessionIdAtom, currentSessionSidePanelOpenAtom } from '@/atoms/agent-atoms'
import { workspaceToolReceiptAtom, clearWorkspaceToolRequestAtom, openWorkspaceToolAtom, pendingWorkspaceToolRequestAtom, requestWorkspaceToolAtom, subscribeWorkspaceToolRequestContext } from '@/atoms/workspace-tools'
import { createWorkspaceToolNavigationGuard, runPendingWorkspaceToolRequest } from './workspace-tool-request'

describe('工具菜单资源请求交付', () => {
  test('Given 画布关联仍加载 When 消费并重试 Then 就绪后只打开一次', async () => {
    /** 真实 store 模拟从菜单到 SidePanel 的跨挂载传递。 */
    const store = createStore()
    const opened: string[] = []
    const actions = {
      canvasReady: false, canvasError: null,
      openBrowser: () => { opened.push('browser') },
      openTerminal: () => { opened.push('terminal') },
      openCanvas: () => { opened.push('canvas') },
      reportError: (message: string) => { opened.push(message) },
    }
    store.set(currentAgentSessionIdAtom, 'session-a')
    store.set(requestWorkspaceToolAtom, { sessionId: 'session-a', tool: 'canvas' })
    await runPendingWorkspaceToolRequest(store, 'session-a', actions)
    expect(opened).toEqual([])
    await runPendingWorkspaceToolRequest(store, 'session-a', { ...actions, canvasReady: true })
    await runPendingWorkspaceToolRequest(store, 'session-a', { ...actions, canvasReady: true })
    expect(opened).toEqual(['canvas'])
  })

  test('Given 浏览器和终端点击 When 重复Effect或错误重试 Then 不重复创建并报告失败', async () => {
    const store = createStore()
    const opened: string[] = []
    const actions = {
      canvasReady: false, canvasError: null,
      openBrowser: async () => { throw new Error('测试 IPC 失败') },
      openTerminal: () => { opened.push('terminal') },
      openCanvas: () => { opened.push('canvas') },
      reportError: (message: string) => { opened.push(message) },
    }
    store.set(currentAgentSessionIdAtom, 'session-a')
    store.set(requestWorkspaceToolAtom, { sessionId: 'session-a', tool: 'terminal' })
    await runPendingWorkspaceToolRequest(store, 'session-a', actions)
    await runPendingWorkspaceToolRequest(store, 'session-a', actions)
    expect(opened).toEqual(['terminal'])
    store.set(requestWorkspaceToolAtom, { sessionId: 'session-a', tool: 'browser' })
    await runPendingWorkspaceToolRequest(store, 'session-a', actions)
    expect(opened).toEqual(['terminal', '打开浏览器失败，请重试'])
  })

  test('Given 画布关联失败 When 消费 Then 提示失败且不会等待到未来突然打开', async () => {
    const store = createStore()
    const opened: string[] = []
    const actions = {
      canvasReady: false, canvasError: '画布关联加载失败',
      openBrowser: () => undefined, openTerminal: () => undefined,
      openCanvas: () => { opened.push('canvas') },
      reportError: (message: string) => { opened.push(message) },
    }
    store.set(currentAgentSessionIdAtom, 'session-a')
    store.set(requestWorkspaceToolAtom, { sessionId: 'session-a', tool: 'canvas' })
    await runPendingWorkspaceToolRequest(store, 'session-a', actions)
    await runPendingWorkspaceToolRequest(store, 'session-a', { ...actions, canvasReady: true, canvasError: null })
    expect(opened).toEqual(['画布关联加载失败'])
  })
  test('Given 浏览器或Canvas异步在途 When 用户后续导航或关闭 Then 旧完成不得抢回焦点', async () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'session-a')
    store.set(currentSessionSidePanelOpenAtom, true)
    const release = subscribeWorkspaceToolRequestContext(store)
    const canNavigate = createWorkspaceToolNavigationGuard(store, 'session-a')
    expect(canNavigate()).toBe(true)
    store.set(openWorkspaceToolAtom, 'files')
    expect(canNavigate()).toBe(false)
    const afterFiles = createWorkspaceToolNavigationGuard(store, 'session-a')
    store.set(currentSessionSidePanelOpenAtom, false)
    expect(afterFiles()).toBe(false)
    release()
  })

  test('Given 当前会话有待处理请求 When 另一会话关闭Tab Then 不撤销当前请求或焦点授权', () => {
    /** 模拟后台会话的延迟关闭回调，当前会话必须继续收到自己的资源。 */
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'session-b')
    store.set(currentSessionSidePanelOpenAtom, true)
    store.set(requestWorkspaceToolAtom, { sessionId: 'session-b', tool: 'browser' })
    const canNavigate = createWorkspaceToolNavigationGuard(store, 'session-b')
    store.set(clearWorkspaceToolRequestAtom, 'session-a')
    expect(store.get(pendingWorkspaceToolRequestAtom('session-b'))).toMatchObject({ tool: 'browser' })
    expect(canNavigate()).toBe(true)
  })

  test('Given 请求在途且活动Tab未变化 When 当前会话关闭其他Tab Then 旧请求失去焦点授权', () => {
    /** 关闭非活动 Tab 同样表达新导航意图，不能只依赖活动 Tab 值变化。 */
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'session-a')
    store.set(currentSessionSidePanelOpenAtom, true)
    store.set(requestWorkspaceToolAtom, { sessionId: 'session-a', tool: 'canvas' })
    const canNavigate = createWorkspaceToolNavigationGuard(store, 'session-a')
    store.set(clearWorkspaceToolRequestAtom, 'session-a')
    expect(store.get(pendingWorkspaceToolRequestAtom('session-a'))).toBeNull()
    expect(canNavigate()).toBe(false)
  })

})

describe('动态工具导航回执', () => {
  test('Given 请求已消费但浏览器未返回 When 导航离开 Then 立即取消且迟到响应不覆盖重试', async () => {
    /** 显式控制 IPC 完成时机，覆盖真实在途窗口。 */
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'session-a')
    const unsubscribe = subscribeWorkspaceToolRequestContext(store)
    let finish: () => void = () => undefined
    const errors: string[] = []
    const actions = { canvasReady: true, canvasError: null, openBrowser: () => new Promise<void>((resolve) => { finish = resolve }), openTerminal: () => undefined, openCanvas: () => undefined, reportError: (message: string) => { errors.push(message) } }
    store.set(requestWorkspaceToolAtom, { sessionId: 'session-a', tool: 'browser' })
    const first = store.get(workspaceToolReceiptAtom('session-a'))!
    expect(first).toMatchObject({ status: 'pending', sessionId: 'session-a', surfaceId: 'browser' })
    expect(first.requestId).toBeTruthy()
    const running = runPendingWorkspaceToolRequest(store, 'session-a', actions)
    expect(store.get(pendingWorkspaceToolRequestAtom('session-a'))).toBeNull()
    store.set(clearWorkspaceToolRequestAtom)
    expect(store.get(workspaceToolReceiptAtom('session-a'))?.status).toBe('canceled')
    store.set(requestWorkspaceToolAtom, { sessionId: 'session-a', tool: 'terminal' })
    await runPendingWorkspaceToolRequest(store, 'session-a', actions)
    const latest = store.get(workspaceToolReceiptAtom('session-a'))
    expect(latest?.status).toBe('opened')
    finish()
    await running
    expect(store.get(workspaceToolReceiptAtom('session-a'))).toEqual(latest)
    expect(errors).toEqual([])
    unsubscribe()
  })

  test('Given 画布打开失败 When 再点击重试 Then 新请求从 pending 进入 opened', async () => {
    /** false 返回值同样是失败，不能把回调完成误认为成功。 */
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'session-a')
    const actions = { canvasReady: true, canvasError: null, openBrowser: () => undefined, openTerminal: () => undefined, openCanvas: () => Promise.resolve(false), reportError: () => undefined }
    store.set(requestWorkspaceToolAtom, { sessionId: 'session-a', tool: 'canvas' })
    await runPendingWorkspaceToolRequest(store, 'session-a', actions)
    const failed = store.get(workspaceToolReceiptAtom('session-a'))!
    expect(failed.status).toBe('failed')
    store.set(requestWorkspaceToolAtom, { sessionId: 'session-a', tool: 'canvas' })
    expect(store.get(workspaceToolReceiptAtom('session-a'))?.status).toBe('pending')
    await runPendingWorkspaceToolRequest(store, 'session-a', { ...actions, openCanvas: () => Promise.resolve(true) })
    expect(store.get(workspaceToolReceiptAtom('session-a'))?.status).toBe('opened')
    expect(store.get(workspaceToolReceiptAtom('session-a'))?.requestId).not.toBe(failed.requestId)
  })

  test('Given 会话A请求在途 When 切到B并且A失败 Then 回执隔离且不弹迟到错误', async () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'session-a')
    const unsubscribe = subscribeWorkspaceToolRequestContext(store)
    let reject: (reason: Error) => void = () => undefined
    const errors: string[] = []
    const actions = { canvasReady: true, canvasError: null, openBrowser: () => new Promise<void>((_resolve, fail) => { reject = fail }), openTerminal: () => undefined, openCanvas: () => undefined, reportError: (message: string) => { errors.push(message) } }
    store.set(requestWorkspaceToolAtom, { sessionId: 'session-a', tool: 'browser' })
    const running = runPendingWorkspaceToolRequest(store, 'session-a', actions)
    store.set(currentAgentSessionIdAtom, 'session-b')
    expect(store.get(workspaceToolReceiptAtom('session-a'))?.status).toBe('canceled')
    store.set(requestWorkspaceToolAtom, { sessionId: 'session-b', tool: 'terminal' })
    reject(new Error('迟到失败'))
    await running
    expect(store.get(workspaceToolReceiptAtom('session-b'))?.status).toBe('pending')
    expect(store.get(workspaceToolReceiptAtom('session-a'))?.status).toBe('canceled')
    expect(errors).toEqual([])
    unsubscribe()
  })
})

test('Given 连续新请求 When 捕获导航授权及积累会话 Then 旧请求不能抢焦点且回执有界', () => {
  /** 新请求代次独立于原 Tab 是否变化。 */
  const store = createStore()
  store.set(currentAgentSessionIdAtom, 'session-a')
  store.set(currentSessionSidePanelOpenAtom, true)
  store.set(requestWorkspaceToolAtom, { sessionId: 'session-a', tool: 'browser' })
  const canNavigate = createWorkspaceToolNavigationGuard(store, 'session-a')
  store.set(requestWorkspaceToolAtom, { sessionId: 'session-a', tool: 'terminal' })
  expect(canNavigate()).toBe(false)
  for (let index = 0; index < 65; index += 1) {
    store.set(requestWorkspaceToolAtom, { sessionId: `session-${index}`, tool: 'browser' })
  }
  expect(store.get(workspaceToolReceiptAtom('session-a'))).toBeNull()
  expect(store.get(workspaceToolReceiptAtom('session-0'))).toBeNull()
  expect(store.get(workspaceToolReceiptAtom('session-1'))?.status).toBe('canceled')
  expect(store.get(workspaceToolReceiptAtom('session-64'))?.status).toBe('pending')
})
