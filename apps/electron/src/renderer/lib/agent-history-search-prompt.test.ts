import { describe, expect, test } from 'bun:test'
import { buildAgentHistorySearchPrompt } from './agent-history-search-prompt'

describe('Agent 历史语义搜索提示词', () => {
  test('Given 默认或自定义活动数据根 When 构造提示词 Then 使用当前根而非旧 .proma 路径', () => {
    const prompt = buildAgentHistorySearchPrompt('查找发布事故', '/Users/example/CustomDutyDeck')

    expect(prompt).toContain('/Users/example/CustomDutyDeck/conversations/')
    expect(prompt).toContain('/Users/example/CustomDutyDeck/agent-sessions/')
    expect(prompt).not.toContain('~/.proma')
  })

  test('Given Windows 数据根和末尾分隔符 When 构造提示词 Then 生成 Windows 子目录路径', () => {
    const prompt = buildAgentHistorySearchPrompt('查找数据库迁移', 'D:\\DutyDeck Data\\')

    expect(prompt).toContain('D:\\DutyDeck Data\\conversations\\')
    expect(prompt).toContain('D:\\DutyDeck Data\\agent-sessions\\')
  })
})
