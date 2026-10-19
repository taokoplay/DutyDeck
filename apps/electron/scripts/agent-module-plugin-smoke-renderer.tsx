import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'jotai'
import { AgentModuleBar } from '../src/renderer/components/agent/AgentModuleBar'
import { AgentModuleCommandReceipt } from '../src/renderer/components/agent/AgentModuleCommandReceipt'
import { AgentRunRecoveryNotice } from '../src/renderer/components/agent/AgentRunRecoveryNotice'
import { AgentStatusBar } from '../src/renderer/components/agent/AgentStatusBar'
import { ModuleCatalog } from '../src/renderer/components/agent-skills/ModuleCatalog'
import { parseQueuedMessageMentions } from '../src/renderer/lib/agent-message-queue'
import '../src/renderer/styles/globals.css'

/** 挂载生产组件与 preload，只有执行驱动使用隔离夹具。 */
function ModuleSmokeApp(): React.ReactElement {
  // 会话、发送计数和运行态用于验证真实组件生命周期。
  const [sessionId, setSessionId] = React.useState('smoke-a')
  const [result, setResult] = React.useState('')
  const [submissions, setSubmissions] = React.useState(0)
  const [running, setRunning] = React.useState(false)
  /** 通过正式输入解析器和 preload 提交模块命令，不模拟 renderer API。 */
  const submit = async (): Promise<void> => {
    try {
      const parsed = parseQueuedMessageMentions('/module:canvas @module:canvas 创建节点')
      const policy = await window.electronAPI.getSessionModulePolicy(sessionId)
      const command = await window.electronAPI.submitAgentModuleCommand({
        sessionId, moduleId: parsed.moduleIds[0]!, capabilityId: 'canvas.create_node', baseRevision: policy.revision,
        invocationMode: parsed.moduleInvocationMode!, deliveryMode: 'enqueue', requestSummary: parsed.cleanedText,
        input: {}, idempotencyKey: `${sessionId}:create-node`,
      })
      setResult(`${command.commandId}:${command.status}`)
      setSubmissions((count) => count + 1)
    } catch (cause) { setResult(cause instanceof Error ? cause.message : String(cause)) }
  }
  return <Provider><main className="min-h-screen bg-background p-3 text-foreground">
    <h1 className="mb-3 text-lg font-semibold">Agent 模块集成验收</h1>
    <div className="mb-3 flex flex-wrap gap-3">
      <button data-testid="switch-session" onClick={() => setSessionId((value) => value === 'smoke-a' ? 'smoke-b' : 'smoke-a')}>切换会话</button>
      <button data-testid="submit-command" onClick={() => void submit()}>提交显式模块命令</button>
      <button data-testid="toggle-running" onClick={() => setRunning((value) => !value)}>切换运行态</button>
    </div>
    <output data-testid="session-id">{sessionId}</output>
    <output data-testid="submit-result" data-count={submissions}>{result}</output>
    <AgentModuleBar sessionId={sessionId} />
    <AgentModuleCommandReceipt sessionId={sessionId} />
    <AgentRunRecoveryNotice sessionId={sessionId} running={running} />
    <div data-testid="idle-status-fixture"><AgentStatusBar
      messagesLoaded messagesRefreshing={false} streaming={false} backgroundWaiting={false}
      queuedCount={0} waitingPermission={false} waitingAnswer={false} stopping={false}
      hasError={false} hasChannel hasModel
    /></div>
    <ModuleCatalog workspaceSlug="smoke" loadedWorkspaceSlug="smoke" skills={[{slug: "canvas-production", name: "画布", enabled: true}, {slug: "disabled-skill", name: "停用", enabled: false}]} />
  </main></Provider>
}
createRoot(document.getElementById('root')!).render(<ModuleSmokeApp />)
