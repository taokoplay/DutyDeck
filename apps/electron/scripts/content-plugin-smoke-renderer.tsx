import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'jotai'
import { PluginSettings } from '../src/renderer/components/settings/PluginSettings'
import { AgentModuleBar } from '../src/renderer/components/agent/AgentModuleBar'
import { RichTextInput, type RichTextInputHandle } from '../src/renderer/components/ai-elements/rich-text-input'
import '../src/renderer/styles/globals.css'

/** 生产设置页与消息组件共享同一 Store；不模拟 preload 或安装调用。 */
function ContentPluginSmoke(): React.ReactElement {
  /** 真实编辑器承接模块选择并展示草稿。 */
  const input = React.useRef<RichTextInputHandle>(null)
  const [draft, setDraft] = React.useState('')
  return <Provider><main className="min-h-screen bg-background p-4 text-foreground">
    <div className="mb-5 rounded border p-2">
      <RichTextInput enableMentions ref={input} sessionId="plugin-smoke" value={draft} onChange={setDraft} placeholder="消息模块" />
      <AgentModuleBar sessionId="plugin-smoke" messageMode inputRef={input} />
      <output data-testid="draft">{draft}</output>
    </div>
    <PluginSettings />
  </main></Provider>
}
createRoot(document.getElementById('root')!).render(<ContentPluginSmoke />)
