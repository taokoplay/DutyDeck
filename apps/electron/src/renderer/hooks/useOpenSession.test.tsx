import { describe, expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { activeViewAtom } from '@/atoms/active-view'
import {
  agentSessionIndicatorMapAtom,
  agentStreamErrorsAtom,
  unviewedCompletedSessionIdsAtom,
} from '@/atoms/agent-atoms'
import { agentTerminalRunMarkersAtom, recordAgentTerminalRun } from '@/lib/agent-active-session-snapshot'
import {
  channelFormDirtyAtom,
  settingsOpenAtom,
  settingsPendingSessionNavigationAtom,
} from '@/atoms/settings-tab'
import type { TabType } from '@/atoms/tab-atoms'
import { useOpenSession } from './useOpenSession'

/** 捕获统一会话打开命令，便于直接验证跨视图状态联动。 */
function captureOpenSession(
  store: ReturnType<typeof createStore>,
): (type: TabType, sessionId: string, title: string) => void {
  /** 静态渲染期间由测试探针写入的真实 hook 回调。 */
  let openSession: ReturnType<typeof useOpenSession> | null = null
  /** 测试探针只负责取得统一会话打开命令。 */
  const Probe = (): null => {
    openSession = useOpenSession()
    return null
  }

  renderToStaticMarkup(<Provider store={store}><Probe /></Provider>)
  if (!openSession) throw new Error('未捕获会话打开命令')
  return openSession
}

describe('统一会话打开', () => {
  test('Given 未查看的失败会话 When 点击打开后离开 Then 红条消失且错误详情与终态保留', () => {
    /** 独立状态容器保存失败提醒及会话内可见的错误。 */
    const store = createStore()
    store.set(unviewedCompletedSessionIdsAtom, new Set(['failed-session', 'other-session']))
    store.set(agentStreamErrorsAtom, new Map([['failed-session', '连接失败']]))
    recordAgentTerminalRun(store, 'failed-session', { startedAt: 100, runGeneration: 1, failed: true })
    expect(store.get(agentSessionIndicatorMapAtom).get('failed-session')).toBe('failed')
    /** 调用侧栏共用的真实导航入口，覆盖点击已打开会话的重复清除。 */
    const openSession = captureOpenSession(store)

    openSession('agent', 'failed-session', '失败任务')
    openSession('agent', 'failed-session', '失败任务')
    openSession('chat', 'chat-1', '其它对话')

    expect(store.get(agentSessionIndicatorMapAtom).has('failed-session')).toBe(false)
    expect(store.get(agentSessionIndicatorMapAtom).get('other-session')).toBe('completed')
    expect(store.get(agentStreamErrorsAtom).get('failed-session')).toBe('连接失败')
    expect(store.get(agentTerminalRunMarkersAtom).get('failed-session')).toEqual({
      startedAt: 100, runGeneration: 1, failed: true,
    })

    recordAgentTerminalRun(store, 'failed-session', { startedAt: 200, runGeneration: 2, failed: true })
    store.set(unviewedCompletedSessionIdsAtom, new Set(['failed-session', 'other-session']))
    expect(store.get(agentSessionIndicatorMapAtom).get('failed-session')).toBe('failed')
  })

  test('Given 未查看失败且设置页有未保存配置 When 打开被拦截 Then 保留红色提醒', () => {
    /** 导航尚未发生时，不能提前把失败标为已查看。 */
    const store = createStore()
    store.set(unviewedCompletedSessionIdsAtom, new Set(['failed-session']))
    recordAgentTerminalRun(store, 'failed-session', { startedAt: 100, failed: true })
    store.set(settingsOpenAtom, true)
    store.set(channelFormDirtyAtom, true)
    /** 捕获受设置守卫保护的真实导航回调。 */
    const openSession = captureOpenSession(store)

    openSession('agent', 'failed-session', '失败任务')

    expect(store.get(agentSessionIndicatorMapAtom).get('failed-session')).toBe('failed')
    expect(store.get(unviewedCompletedSessionIdsAtom).has('failed-session')).toBe(true)
  })

  test('Given 当前显示其它顶层能力 When 打开普通会话 Then 只依赖普通会话状态并切回会话视图', () => {
    const store = createStore()
    store.set(activeViewAtom, 'planning')
    /** 通过真实 hook 执行普通会话导航。 */
    const openSession = captureOpenSession(store)

    openSession('chat', 'chat-1', '需求讨论')

    expect(store.get(activeViewAtom)).toBe('conversations')
  })

  test('Given 设置页存在未保存配置 When 会话导航被拦截 Then 保留当前顶层视图', () => {
    const store = createStore()
    store.set(settingsOpenAtom, true)
    store.set(channelFormDirtyAtom, true)
    store.set(activeViewAtom, 'planning')
    /** 通过真实 hook 触发会被设置守卫延后的导航。 */
    const openSession = captureOpenSession(store)

    openSession('chat', 'chat-1', '需求讨论')

    expect(store.get(activeViewAtom)).toBe('planning')
    expect(store.get(settingsPendingSessionNavigationAtom)).toEqual({
      type: 'chat',
      sessionId: 'chat-1',
      title: '需求讨论',
    })
  })
})
