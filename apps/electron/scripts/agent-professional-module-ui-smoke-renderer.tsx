import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'jotai'
import { AgentModuleBar } from '../src/renderer/components/agent/AgentModuleBar'
import { RichTextInput, type RichTextInputHandle } from '../src/renderer/components/ai-elements/rich-text-input'
import '../src/renderer/styles/globals.css'

/** 隔离夹具托管生产组件，不连接模型或真实项目。 */
function ProfessionalModuleSmokeApp(): React.ReactElement {
  /** 会话和受控草稿用于验证切换后的选择隔离。 */
  const [sessionId, setSessionId] = React.useState('professional-a')
  const [draft, setDraft] = React.useState('请检查当前项目')
  const inputRef = React.useRef<RichTextInputHandle>(null)
  return <Provider><main className="flex min-h-screen flex-col bg-background p-4 text-foreground">
    <h1>专业模块消息选择验收</h1>
    <button data-testid="switch-session" onClick={() => { setSessionId('professional-b'); setDraft('新会话要求') }}>切换会话</button>
    <output data-testid="session-id">{sessionId}</output>
    <div className="flex-1" />
    <section className="rounded-lg border p-3">
      <RichTextInput ref={inputRef} sessionId={sessionId} draftScopeKey={sessionId} value={draft} onChange={setDraft} onSubmit={() => undefined} enableMentions placeholder="消息模块" />
      <AgentModuleBar sessionId={sessionId} messageMode inputRef={inputRef} />
    </section>
    <output data-testid="message-draft" className="break-all text-xs">{draft}</output>
  </main></Provider>
}
createRoot(document.getElementById('root')!).render(<ProfessionalModuleSmokeApp />)
