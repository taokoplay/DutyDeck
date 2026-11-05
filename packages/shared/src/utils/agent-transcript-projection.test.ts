import { expect, test } from 'bun:test'
import type { SDKMessage } from '../types/agent'
import { projectDeferredTranscriptMessage } from './agent-transcript-projection'
test('Given 巨条工具调用 When 展示降级 Then 保留call身份和parent但不复制input正文', () => {
  const value = projectDeferredTranscriptMessage({type:'assistant',parent_tool_use_id:'parent',message:{content:[{type:'tool_use',id:'call',name:'Read',input:{path:'x'.repeat(300000)}}]}} as SDKMessage,'分段详情') as {parent_tool_use_id?:string;message?:{content?:unknown[]}}
  expect(value.parent_tool_use_id).toBe('parent')
  expect(value.message?.content).toContainEqual({type:'tool_use',id:'call',name:'Read',input:{_transcriptDeferred:true}})
  expect(JSON.stringify(value).length).toBeLessThan(2000)
})
