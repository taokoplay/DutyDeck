import { expect, test } from 'bun:test'
import { sliceRetainedTranscript } from './agent-transcript-detail'
test('Given 超长保留正文及内嵌图片 When 分片查看 Then 不展开全量字符串且图片省略', () => {
  const message = { type:'assistant', message:{content:[{type:'text',text:'汉'.repeat(1000000)}]},data:'A'.repeat(1000000) }
  const first = sliceRetainedTranscript(message,0)
  expect(first.text.length).toBe(16000)
  expect(first.nextOffset).toBe(16000)
  const small = sliceRetainedTranscript({text:'hello',data:'secret',nested:{base64:'secret'}},0)
  expect(small.text).not.toContain('secret')
  expect(small.nextOffset).toBeUndefined()
})
test('Given 循环对象和深层工具参数 When 查看 Then 有界降级并能返回', () => {
  const value: {self?:unknown} = {}; value.self=value
  expect(sliceRetainedTranscript(value,0).text).toContain('循环')
})
