import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { Provider, atom, useAtom } from 'jotai'
import { ModuleRuntimePluginSettings } from '../src/renderer/components/settings/ModuleRuntimePluginSettings'
import { PluginMarketView } from '../src/renderer/components/settings/PluginMarketView'
import '../src/renderer/styles/globals.css'

const marketVisibleAtom = atom(true)
function SmokeViews(): React.ReactElement {
  const [visible, setVisible] = useAtom(marketVisibleAtom)
  return <main className="min-h-screen bg-background p-4 text-foreground">
    <ModuleRuntimePluginSettings allowInstall={false} />
    <button onClick={() => setVisible(value => !value)}>{visible ? '验收：离开市场' : '验收：返回市场'}</button>
    {visible && <PluginMarketView />}
  </main>
}
/** 使用生产组件和真实 preload；仅模拟父Tab卸载，不替换 renderer API。 */
createRoot(document.getElementById('root')!).render(<Provider><SmokeViews /></Provider>)
