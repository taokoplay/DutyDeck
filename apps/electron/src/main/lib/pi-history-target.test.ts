import { describe, expect, test } from 'bun:test'
import type { SDKAssistantMessage, SDKMessage } from '@dutydeck/shared'
import { resolvePiHistoryTarget, type PiHistoryEntry } from './pi-history-target'

/** 返回毫秒时间对应的 Pi ISO 时间，便于构造严格有序的回合。 */
function timestamp(milliseconds: number): string { return new Date(milliseconds).toISOString() }

/** 创建带真实消息身份的展示 assistant；传入错误时生成宿主旧版提示。 */
function assistant(uuid: string, error?: string): SDKAssistantMessage {
  return {
    type: 'assistant', uuid, parent_tool_use_id: null,
    message: { content: [{ type: 'text', text: error ?? '已执行工具' }] },
    ...(error ? { error: { message: error }, _createdAt: 6500 } : {}),
  }
}

/** 构建旧版工具执行后超时的完整回合，所有文件数据均为内存夹具。 */
function fixture(): { messages: SDKMessage[]; bindings: Record<string, string>; branch: PiHistoryEntry[]; targetUuid: string } {
  return {
    messages: [
      { type: 'user', uuid: 'input', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '开始' }] } },
      assistant('anchor-ui'),
      { type: 'user', uuid: 'result-ui', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '完成' }] } },
      assistant('notice', 'Request timed out.'),
      { type: 'user', uuid: 'next-input', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '继续' }] } },
    ],
    bindings: { 'anchor-ui': 'anchor', 'original-error': 'terminal' },
    branch: [
      { type: 'message', id: 'input', timestamp: timestamp(1000), message: { role: 'user' } },
      { type: 'message', id: 'anchor', timestamp: timestamp(2000), message: { role: 'assistant', stopReason: 'toolUse' } },
      { type: 'message', id: 'result', timestamp: timestamp(3000), message: { role: 'toolResult', toolCallId: 'call-1' } },
      { type: 'message', id: 'retry', timestamp: timestamp(4000), message: { role: 'assistant', stopReason: 'error', errorMessage: 'Request timed out.' } },
      { type: 'context_edit', id: 'hide-retry', timestamp: timestamp(5000) },
      { type: 'message', id: 'terminal', timestamp: timestamp(6000), message: { role: 'assistant', stopReason: 'error', errorMessage: 'Request timed out.' } },
      { type: 'message', id: 'next-input', timestamp: timestamp(7000), message: { role: 'user' } },
    ],
    targetUuid: 'notice',
  }
}

describe('Pi 历史回退与分叉目标', () => {
  test('Given 正常回复存在有效映射 When 定位 Then 返回当前分支的原节点', () => {
    /** 已有正常回退路径必须保持可用。 */
    const input = fixture()
    expect(resolvePiHistoryTarget({ ...input, targetUuid: 'anchor-ui' })).toBe('anchor')
  })

  test('Given 旧错误提示缺少映射且工具回执和唯一终态均吻合 When 定位 Then 恢复原错误节点', () => {
    expect(resolvePiHistoryTarget(fixture())).toBe('terminal')
  })

  test('Given 新错误提示有显式来源 When 定位 Then 使用来源映射且不要求旧版时间匹配', () => {
    /** 新协议有直接身份凭据，错误文字可以继续做用户友好转换。 */
    const input = fixture()
    input.messages[3] = { ...assistant('notice', '请求过大'), _piSourceUuid: 'original-error' }
    expect(resolvePiHistoryTarget(input)).toBe('terminal')
  })

  test('Given 旧错误前已保存同一响应的部分正文 When 定位 Then 指向正文已验证的错误节点', () => {
    /** 原错误 UUID 已随部分正文落盘，提示没有必要再按 orphan 搜索。 */
    const input = fixture()
    input.messages.splice(3, 0, assistant('original-error'))
    expect(resolvePiHistoryTarget(input)).toBe('terminal')
  })

  test.each([
    ['候选存在两份已登记错误', (input: ReturnType<typeof fixture>) => { input.bindings['retry-ui'] = 'retry' }],
    ['工具回执身份不同', (input: ReturnType<typeof fixture>) => { input.branch[2]!.message!.toolCallId = 'other-call' }],
    ['丢失工具回执', (input: ReturnType<typeof fixture>) => { input.messages.splice(2, 1) }],
    ['错误正文不同', (input: ReturnType<typeof fixture>) => { input.branch[5]!.message!.errorMessage = 'Connection error.' }],
    ['终态映射不存在', (input: ReturnType<typeof fixture>) => { delete input.bindings['original-error'] }],
    ['终态属于另一分支', (input: ReturnType<typeof fixture>) => { input.branch.splice(5, 1) }],
    ['终态已跨过新输入', (input: ReturnType<typeof fixture>) => { input.branch.splice(5, 0, { type: 'message', id: 'other-input', timestamp: timestamp(5500), message: { role: 'user' } }) }],
    ['提示已跨过新输入', (input: ReturnType<typeof fixture>) => { input.messages.splice(3, 0, { type: 'user', uuid: 'other-input', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '新请求' }] } }) }],
    ['提示时间早于节点落盘', (input: ReturnType<typeof fixture>) => { Object.assign(input.messages[3]!, { _createdAt: 5500 }) }],
    ['提示时间跨过下一次请求', (input: ReturnType<typeof fixture>) => { Object.assign(input.messages[3]!, { _createdAt: 7500 }) }],
    ['同回合存在未展示成功回复', (input: ReturnType<typeof fixture>) => { input.branch[3]!.message!.stopReason = 'stop' }],
    ['存在压缩边界', (input: ReturnType<typeof fixture>) => { input.branch[4]!.type = 'compaction' }],
    ['目标属于子代理', (input: ReturnType<typeof fixture>) => { Object.assign(input.messages[3]!, { parent_tool_use_id: 'delegation' }) }],
    ['目标 UUID 重复', (input: ReturnType<typeof fixture>) => { input.messages.push(input.messages[3]!) }],
    ['普通无映射消息', (input: ReturnType<typeof fixture>) => { input.messages[3] = assistant('notice') }],
    ['显式来源失效', (input: ReturnType<typeof fixture>) => { Object.assign(input.messages[3]!, { _piSourceUuid: 'missing' }) }],
  ])('Given %s When 恢复旧提示 Then 拒绝猜测历史节点', (_label, modify) => {
    /** 每个边界独立修改夹具，保证失败来自身份或回合证据不完整。 */
    const input = fixture()
    modify(input)
    expect(() => resolvePiHistoryTarget(input)).toThrow('无法安全')
  })

  test('Given 直接映射节点已不在当前分支 When 定位 Then 拒绝旧映射', () => {
    /** 即便 metadata 仍有映射，也不能从另一棵树取节点。 */
    const input = fixture()
    input.bindings.notice = 'foreign-entry'
    expect(() => resolvePiHistoryTarget(input)).toThrow('无法安全')
  })
})
