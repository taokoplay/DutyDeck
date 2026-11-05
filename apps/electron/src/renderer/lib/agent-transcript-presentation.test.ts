import { expect, test } from 'bun:test'
import { rememberTranscriptExpansion } from './agent-transcript-presentation'
test('Given 翻页卸载的代码或工具组 When 同ID再次挂载 Then 保留展开选择且缓存最多1000项', () => {
  const cache = new Map<string, boolean>()
  rememberTranscriptExpansion(cache, 'g:call', true)
  expect(cache.get('g:call')).toBe(true)
  for(let i=0;i<1100;i++) rememberTranscriptExpansion(cache, `g:${i}`, false)
  expect(cache.size).toBe(1000)
  expect(cache.has('g:call')).toBe(false)
})

test('Given 嵌套子代理搜索命中 When 找所属折叠组 Then 沿父工具链揭示目标且循环不无限递归', async () => {
  const { containsTargetRecord } = await import('./agent-transcript-presentation')
  const parent={type:'tool_use',id:'p',name:'Agent',input:{}}
  const nested={type:'tool_use',id:'n',name:'Agent',input:{}}
  const child={type:'text',text:'target'}
  const links=new Map([['p',[nested]],['n',[child,parent]]])
  expect(containsTargetRecord([parent],new Map([[child,'target']]),links,'target')).toBe(true)
  expect(containsTargetRecord([parent],new Map([[child,'target']]),links,'absent')).toBe(false)
})
