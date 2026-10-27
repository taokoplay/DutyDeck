import { describe, expect, test } from 'bun:test'
import { buildCollaborationResultView } from './agent-collaboration-result-view'

/** 构造长正文与稳定 ID，模拟完成后的协作回执。 */
function result(index: number, text = '正文'.repeat(3000)) {
  return { delegationId: `d${index}`, status: 'completed', startedAt: index, resultSummary: text }
}

describe('协作结果按需读取', () => {
  test('Given 25 条历史 When 默认列表 Then 仅返回20条元数据并可续页', () => {
    const page = buildCollaborationResultView(Array.from({ length: 25 }, (_, index) => result(index)), { detail: 'metadata' })
    expect(page.delegations).toHaveLength(20)
    expect(page.delegations[0]?.resultSummary).toBeUndefined()
    expect(page.nextOffset).toBe(20)
  })
  test('Given 多份长结果 When preview Then 所有结果共享字符预算并保留精读入口', () => {
    const page = buildCollaborationResultView([result(1), result(2)], { maxChars: 1500 })
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(1500)
    expect(page.delegations[0]?.resultTruncated).toBe(true)
    expect(page.delegations[0]?.resultReadTool).toBe('mcp__collaboration__get_delegation_results')
  })
  test('Given 超过50k原文 When full分段 Then 能连续读到原文尾部', () => {
    const original = '甲'.repeat(60000) + '尾部'
    let offset = 0
    let reconstructed = ''
    do {
      const page = buildCollaborationResultView([result(1, original)], { detail: 'full', resultOffset: offset, maxChars: 50000 })
      const item = page.delegations[0]!
      reconstructed += item.resultSummary
      offset = item.nextResultOffset as number
    } while (offset !== undefined)
    expect(reconstructed).toBe(original)
  })
  test('Given full多项 When 读取 Then 拒绝歧义范围', () => {
    expect(() => buildCollaborationResultView([result(1), result(2)], { detail: 'full' })).toThrow('单个')
  })
  test('Given 阻塞问题超过预算 When 输出 Then 保留完整选项和请求ID并标注例外', () => {
    const pendingBlockedEvents = [{ id: 'block1', askUserRequestId: 'request1', askUserQuestions: [{ question: '问'.repeat(16000), options: [{ label: '允许' }] }] }]
    const page = buildCollaborationResultView([{ ...result(1), pendingBlockedEvents }], { maxChars: 1000 })
    expect(page.delegations[0]?.pendingBlockedEvents).toEqual(pendingBlockedEvents)
    expect(page.budgetExceededForRequiredMetadata).toBe(true)
  })
  test('Given JSON转义正文和外层字段 When 分页 Then 保留外层预算且可续读', () => {
    const page = buildCollaborationResultView([result(1, '\\"\n'.repeat(5000))], { detail: 'full', maxChars: 1000 }, 200)
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(800)
    expect(page.delegations[0]?.nextResultOffset).toBeGreaterThan(0)
  })
  test('Given 已分页历史 When metadata Then 不调用正文读取器', () => {
    let reads = 0
    const items = Array.from({ length: 30 }, (_, index) => result(index))
    buildCollaborationResultView(items, { detail: 'metadata' }, 0, () => { reads++; return '正文' })
    expect(reads).toBe(0)
    buildCollaborationResultView(items, { detail: 'preview', limit: 2 }, 0, () => { reads++; return '正文' })
    expect(reads).toBe(2)
  })

  test('Given 元数据已接近预算 When preview分页 Then 范围字段不能挤破预算', () => {
    const page = buildCollaborationResultView(Array.from({ length: 20 }, (_, index) => result(index)), { maxChars: 1500 })
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(1500)
    expect(page.nextOffset).toBeGreaterThan(0)
  })

})

test('超长goal/title/error不能突破metadata预算，必需标识与阻塞项保持完整', () => {
  /** 非关键展示文本可很长，但不能挤掉控制字段。 */
  const item = { ...result(1), goal: '任'.repeat(60000), title: '题'.repeat(10000), error: '错'.repeat(20000), pendingBlockedEvents: [] }
  const page = buildCollaborationResultView([item], { detail: 'metadata', maxChars: 1000 })
  expect(JSON.stringify(page).length).toBeLessThanOrEqual(1000)
  expect(page.budgetExceededForRequiredMetadata).toBe(false)
  expect(page.delegations[0]).toMatchObject({ delegationId: 'd1', status: 'completed', pendingBlockedEvents: [],
    goalTruncated: true, goalTotalChars: 60000, titleTruncated: true, titleTotalChars: 10000, errorTruncated: true, errorTotalChars: 20000 })
})

test('超长展示元数据下full默认预算仍能逐页完整读完正文', () => {
  /** 重建全部正文验证范围进展，而非仅检查首次返回。 */
  const original = '结果'.repeat(15000)
  const item = { ...result(1, original), goal: '任'.repeat(60000), title: '题'.repeat(10000), error: '错'.repeat(20000) }
  let offset = 0
  let reconstructed = ''
  do {
    const page = buildCollaborationResultView([item], { detail: 'full', resultOffset: offset })
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(12000)
    const output = page.delegations[0]!
    expect(String(output.resultSummary).length).toBeGreaterThan(0)
    reconstructed += output.resultSummary
    offset = output.nextResultOffset as number
  } while (offset !== undefined)
  expect(reconstructed).toBe(original)
})

test('小展示字段不改变，也不附加截断标记', () => {
  const page = buildCollaborationResultView([{ ...result(1), goal: '修复问题', title: '测试', error: '可重试' }], { detail: 'metadata' })
  expect(page.delegations[0]).toMatchObject({ goal: '修复问题', title: '测试', error: '可重试' })
  expect(page.delegations[0]?.goalTruncated).toBeUndefined()
})

test('最小预算且预留外层时，JSON转义展示文本仍留出可续读正文空间', () => {
  /** 转义字符会增大JSON尺寸，必须按实际输出而非字符串长度限额。 */
  const item = { ...result(1), goal: '\\"\n'.repeat(20000), title: '题'.repeat(10000), error: '错'.repeat(20000) }
  for (const detail of ['metadata', 'preview', 'full'] as const) {
    const page = buildCollaborationResultView([item], { detail, maxChars: 1000 }, 256)
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(744)
    expect(page.budgetExceededForRequiredMetadata).toBe(false)
    if (detail !== 'metadata') expect(page.delegations[0]?.nextResultOffset).toBeGreaterThan(0)
  }
})
