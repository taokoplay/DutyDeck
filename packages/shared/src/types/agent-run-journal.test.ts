import { describe, expect, test } from 'bun:test'
import { isJournalEventSequenceValid } from './agent-modules'

describe('Agent Run Journal 合同', () => {
  test('Given 空或连续序列 When 校验 Then 通过', () => {
    expect(isJournalEventSequenceValid([])).toBe(true)
    expect(isJournalEventSequenceValid([1, 2, 3])).toBe(true)
  })

  test('Given 缺失或重复序列 When 校验 Then 拒绝恢复', () => {
    expect(isJournalEventSequenceValid([1, 3])).toBe(false)
    expect(isJournalEventSequenceValid([1, 1])).toBe(false)
    expect(isJournalEventSequenceValid([0])).toBe(false)
  })
})
