import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CanvasLoadErrorPanel } from '../src/renderer/components/design/CanvasLoadErrorPanel'
import '../src/renderer/styles/globals.css'

/** 独立 fixture 只在内存记录复制内容，不接触用户业务数据或系统剪贴板。 */
const fixture = { copied: '', failCopy: false }
Object.assign(window, { __canvasLoadSmoke: fixture, electronAPI: {
  writeClipboardText: async (text: string) => {
    if (fixture.failCopy) throw new Error('模拟复制失败')
    fixture.copied = text
  },
} })
/** 禁用浏览器回退，确保失败场景可重复验证。 */
Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('模拟回退失败') } } })

/** 重试点击切换到成功状态，用于验证实际 React 事件绑定。 */
function Fixture(): React.ReactElement {
  const [ready, setReady] = useState(false)
  return <main className="min-h-screen bg-background p-4 text-foreground">{ready ? <p>重试已完成</p> :
    <CanvasLoadErrorPanel error={{ code: 'CANVAS_LOAD_FAILED', message: '画布暂时无法加载。', diagnostic: {
      stage: 'content-load', reason: 'access-denied', systemCode: 'WIN32_5', helperExitCode: 4,
      referenceId: '7a69c5a0-2cb3-4ea0-9b21-10aa9b621e40',
      logStatus: 'saved',
    } }} onRetry={() => setReady(true)} />}</main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
