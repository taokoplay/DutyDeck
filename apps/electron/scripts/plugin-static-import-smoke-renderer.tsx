import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { Provider, createStore, useAtom } from 'jotai'
import { agentWorkspacesAtom, currentAgentWorkspaceIdAtom } from '../src/renderer/atoms/agent-atoms'
import { PluginStaticImportView } from '../src/renderer/components/settings/PluginStaticImportView'
import '../src/renderer/styles/globals.css'

const store = createStore()
store.set(agentWorkspacesAtom, ['a', 'b'].map(key => ({ id: `workspace-${key}`, slug: `fixture-${key}`, name: `验收项目 ${key.toUpperCase()}`, createdAt: 0, updatedAt: 0 })))
store.set(currentAgentWorkspaceIdAtom, 'workspace-a')
function Smoke(): React.ReactElement {
  const [workspace, setWorkspace] = useAtom(currentAgentWorkspaceIdAtom)
  return <main className="min-h-screen bg-background p-4 text-foreground">
    <button onClick={() => setWorkspace(workspace === 'workspace-a' ? 'workspace-b' : 'workspace-a')}>验收：切换项目</button>
    <PluginStaticImportView />
  </main>
}
createRoot(document.getElementById('root')!).render(<Provider store={store}><Smoke /></Provider>)
