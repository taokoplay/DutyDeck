import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { AgentModuleRunAuditView } from '../src/renderer/components/agent/AgentModuleRunAuditView'
import '../src/renderer/styles/globals.css'

/** 仅托管真实审计弹窗，不连接用户会话、模型或项目文件。 */
function AuditSmokeApp(): React.ReactElement {
  /** 测试切会话和关闭后的焦点归还。 */
  const [sessionId, setSessionId] = React.useState('audit-a')
  const [open, setOpen] = React.useState(false)
  const trigger = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    /** DOM 事件只驱动夹具导航，审计数据仍经过生产 preload/IPC。 */
    const changeSession = (): void => setSessionId(value => value === 'audit-a' ? 'audit-b' : 'audit-a')
    window.addEventListener('smoke-switch-session', changeSession)
    return () => window.removeEventListener('smoke-switch-session', changeSession)
  }, [])
  return <main className="min-h-screen bg-background p-4 text-foreground">
    <button ref={trigger} data-testid="open-audit" onClick={() => setOpen(true)}>查看模块运行记录</button>
    <output data-testid="session-id">{sessionId}</output>
    {open && <AgentModuleRunAuditView sessionId={sessionId} onClose={() => setOpen(false)} onReturnFocus={() => trigger.current?.focus()} />}
  </main>
}

createRoot(document.getElementById('root')!).render(<AuditSmokeApp />)
