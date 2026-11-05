import { describe, expect, test } from 'bun:test'
import { getGroupId, groupIntoTurns } from './SDKMessageRenderer'
import type { SDKMessage } from '@dutydeck/shared'
describe('分页展示稳定ID', () => {
  test('Given 历史无UUID或system消息 When 重载对象 Then groupID沿用展示身份', () => {
    const rows = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '问' }] }, _promaTranscriptId: '@g:0' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '答' }] }, _promaTranscriptId: '@g:100' },
      { type: 'system', subtype: 'permission_denied', _promaTranscriptId: '@g:200' },
    ] as unknown as SDKMessage[]
    const ids = groupIntoTurns(rows).map(getGroupId)
    expect(ids).toEqual(['@g:0', '@g:100', '@g:200'])
    expect(groupIntoTurns(structuredClone(rows)).map(getGroupId)).toEqual(ids)
  })
})
