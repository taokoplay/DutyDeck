import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { createStore, Provider } from 'jotai'
import { DiffPanelTabBar } from '../src/renderer/components/diff/DiffPanelTabBar'
import type { WorkspacePanelTab } from '../src/renderer/components/diff/DiffPanelTabBar'
import { TabBar } from '../src/renderer/components/tabs/TabBar'
import { TooltipProvider } from '../src/renderer/components/ui/tooltip'
import { activeTabIdAtom, tabsAtom } from '../src/renderer/atoms/tab-atoms'
import type { AgentSidePanelTab } from '../src/renderer/atoms/agent-atoms'
import '../src/renderer/styles/globals.css'

/** 隔离 fixture 禁止调用真实 IPC；界面数据仅保存在临时浏览器的内存里。 */
Object.defineProperty(window, 'electronAPI', { value: new Proxy({}, {
  get: (_target, property) => property === 'platform' ? 'darwin' : () => {
    throw new Error(`标签栏滚动验收意外调用 IPC：${String(property)}`)
  },
}) })
/** 独立 Jotai store 提供足够多的标签，以真实布局产生横向溢出。 */
const store = createStore()
store.set(tabsAtom, Array.from({ length: 15 }, (_, index) => ({
  id: `wheel-${index}`, sessionId: `wheel-${index}`, type: 'chat' as const, title: `测试会话 ${index + 1}`,
})))
store.set(activeTabIdAtom, 'wheel-0')
/** 使用真实右侧标签身份，保留切换、关闭与拖动事件绑定。 */
const workspaceTabs: WorkspacePanelTab[] = [
  { id: 'files', label: '文件', icon: null },
  { id: 'changes', label: '改动', icon: null },
  ...Array.from({ length: 12 }, (_, index) => ({
    id: `browser:wheel-${index}` as AgentSidePanelTab, label: `网页标签 ${index + 1}`, icon: null, closable: true,
  })),
]
/** 返回两种生产标签栏；右侧切换由真实 React 状态驱动，供验收末项可达。 */
function Fixture(): React.ReactElement {
  /** 当前右侧活动标签，初始项保持在起点。 */
  const [activeTab, setActiveTab] = React.useState<AgentSidePanelTab>('files')
  return <Provider store={store}><TooltipProvider>
    <main className="min-h-screen bg-background p-4 text-foreground">
      <section data-smoke-main className="mb-8"><TabBar /></section>
      <section data-smoke-workspace><DiffPanelTabBar tabs={workspaceTabs} activeTab={activeTab}
        onTabChange={setActiveTab} onCloseTab={() => undefined}
        onTabDragChange={() => undefined} onTabDrop={() => undefined} /></section>
    </main>
  </TooltipProvider></Provider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
