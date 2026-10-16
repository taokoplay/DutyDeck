import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { createStore, Provider } from 'jotai'
import { agentPendingPromptAtom } from '../src/renderer/atoms/agent-atoms'
import { visualProductionViewsAtom } from '../src/renderer/atoms/visual-production-atoms'
import { TooltipProvider } from '../src/renderer/components/ui/tooltip'
import { VisualProductionWorkspace } from '../src/renderer/components/visual-production/VisualProductionWorkspace'
import '../src/renderer/styles/globals.css'

/** 仅挂载真实组件；媒体、版本和写入由隔离主进程真实服务处理。 */
const store = createStore()
/** smoke 可检查主 Agent 输入引用，但不发模型请求。 */
let setActive: (active: boolean) => void = () => undefined
Object.defineProperty(window, '__visualSmoke', { value: {
  prompt: () => store.get(agentPendingPromptAtom),
  active: (value: boolean) => setActive(value),
  select: (productionId: string) => store.set(visualProductionViewsAtom, previous => ({ ...previous, 'smoke-project': { productionId, episodeId: null, shotId: null, tab: 'project' } })),
} })
/** 宿主隐藏仅改变 paneActive，覆盖保留挂载时的媒体暂停。 */
function Fixture(): React.ReactElement {
  const [active, updateActive] = React.useState(true)
  setActive = updateActive
  return <Provider store={store}><TooltipProvider><div style={{ height: '100vh' }}><VisualProductionWorkspace projectId="smoke-project" sessionId="smoke-session" paneActive={active} /></div></TooltipProvider></Provider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
