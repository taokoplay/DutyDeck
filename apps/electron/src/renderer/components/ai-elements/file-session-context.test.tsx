import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import { FileSessionContext, useFileSessionId } from './file-session-context'

function Probe({ sessionId }: { sessionId?: string | null }): React.ReactElement {
  return <span>{useFileSessionId(sessionId) ?? 'none'}</span>
}

describe('文件所属会话优先级', () => {
  test('Given 全局 A When 显式 B、继承 C 或明确 null Then 不串到 A', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'A')
    const render = (child: React.ReactNode) => renderToStaticMarkup(<Provider store={store}>{child}</Provider>)
    expect(render(<Probe />)).toBe('<span>A</span>')
    expect(render(<FileSessionContext.Provider value="C"><Probe /></FileSessionContext.Provider>)).toBe('<span>C</span>')
    expect(render(<FileSessionContext.Provider value="C"><Probe sessionId="B" /></FileSessionContext.Provider>)).toBe('<span>B</span>')
    expect(render(<FileSessionContext.Provider value="C"><Probe sessionId={null} /></FileSessionContext.Provider>)).toBe('<span>none</span>')
    expect(render(<FileSessionContext.Provider value={null}><Probe /></FileSessionContext.Provider>)).toBe('<span>none</span>')
  })
})
