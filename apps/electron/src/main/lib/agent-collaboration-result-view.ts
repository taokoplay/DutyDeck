/** 协作结果读取选项；字符偏移针对未截断正文。 */
export interface CollaborationResultViewOptions {
  /** metadata 不带正文，preview 返回短摘录，full 返回单项原文范围。 */
  detail?: 'metadata' | 'preview' | 'full'
  /** 列表起始位置。 */
  offset?: number
  /** 列表页大小，默认20。 */
  limit?: number
  /** 整页 JSON 字符预算，默认12000，上限50000。 */
  maxChars?: number
  /** full 模式的原文字符偏移。 */
  resultOffset?: number
}
/** 展示文字可以摘要化；身份、状态、权限及阻塞请求不在此名单内。 */
const DISPLAY_TEXT_FIELDS = ['goal', 'title', 'error'] as const

/** 限制单项展示元数据，给正文和分页控制字段留出空间；原文长度显式标注。 */
function fitDisplayMetadata(metadata: Record<string, unknown>, budget: number): Record<string, unknown> {
  /** 每项元数据通常最多占半页或2000字符，避免长任务说明吞掉全部正文预算。 */
  const targetSize = Math.min(2000, Math.floor(budget / 2))
  if (JSON.stringify(metadata).length <= targetSize) return metadata
  /** 仅对三个展示字段建立视图，底层记录从不修改。 */
  const fields = DISPLAY_TEXT_FIELDS.filter((key) => typeof metadata[key] === 'string')
  if (fields.length === 0) return metadata
  /** 使用同一长度上限逐步压缩，JSON转义和截断标记一并计入预算。 */
  const project = (length: number): Record<string, unknown> => {
    const result = { ...metadata }
    for (const key of fields) {
      const text = metadata[key] as string
      if (text.length <= length) continue
      result[key] = text.slice(0, length)
      result[`${key}Truncated`] = true
      result[`${key}TotalChars`] = text.length
    }
    return result
  }
  /** 保留最长且能放下的展示片段；必要字段过大时交由页面预算例外处理。 */
  let low = 0
  let high = Math.max(...fields.map((key) => (metadata[key] as string).length))
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (JSON.stringify(project(middle)).length <= targetSize) low = middle
    else high = middle - 1
  }
  return project(low)
}

/** 返回列表分页与正文续读入口；reservedChars 预留外层 JSON 空间，readBody 仅加载入选页的原文。 */
export function buildCollaborationResultView(items: Array<Record<string, unknown>>, options: CollaborationResultViewOptions = {}, reservedChars = 0, readBody?: (item: Record<string, unknown>) => string | undefined): {
  delegations: Array<Record<string, unknown>>
  nextOffset?: number
  totalCount: number
  budgetExceededForRequiredMetadata: boolean
} {
  /** 约束分页与预算输入，避免 NaN 或负数导致不可续读的范围。 */
  const integer = (value: number | undefined, fallback: number, min: number, max: number): number =>
    value === undefined ? fallback : Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback
  /** 本次输出模式与总预算。 */
  const detail = options.detail ?? 'preview'
  const budget = Math.max(1, integer(options.maxChars, 12000, 1000, 50000) - reservedChars)
  const offset = integer(options.offset, 0, 0, items.length)
  const limit = integer(options.limit, 20, 1, 100)
  if (detail === 'full' && items.length !== 1) throw new Error('full 模式仅支持单个委派 ID')
  if (options.resultOffset !== undefined && detail !== 'full') throw new Error('resultOffset 仅支持 full 模式')
  /** 页面先保留可操作元数据，再分配正文空间。 */
  const page = { delegations: [] as Array<Record<string, unknown>>, nextOffset: undefined as number | undefined, totalCount: items.length, budgetExceededForRequiredMetadata: false }
  const selected = items.slice(offset, offset + limit)
  for (const source of selected) {
    const { resultSummary: _body, ...metadata } = source
    page.delegations.push(fitDisplayMetadata({ ...metadata, resultReadTool: 'mcp__collaboration__get_delegation_results' }, budget))
    page.nextOffset = offset + page.delegations.length < items.length ? offset + page.delegations.length : undefined
    // 每条预留原文范围字段空间，确保分页时已计算后续必需开销。
    if (JSON.stringify(page).length + (detail === 'metadata' ? 0 : page.delegations.length * 160) > budget && page.delegations.length > 1) {
      page.delegations.pop()
      page.nextOffset = offset + page.delegations.length
      break
    }
  }
  /** 仅加载当前页需要的正文；metadata 完全跳过历史消息读取。 */
  const bodies = page.delegations.map((_, index) => detail === 'metadata' ? undefined : readBody ? readBody(selected[index]!) : selected[index]?.resultSummary)
  // 为所有正文范围字段预留空间，避免后续条目挤破前一条已分配的预算。
  if (detail !== 'metadata') {
    page.delegations.forEach((target, index) => {
      const body = bodies[index]
      if (typeof body !== 'string') return
      target.resultSummary = ''
      target.resultOffset = detail === 'full' ? integer(options.resultOffset, 0, 0, body.length) : 0
      target.resultTotalChars = body.length
      target.resultTruncated = true
      target.nextResultOffset = body.length
    })
  }
  for (let index = 0; index < page.delegations.length; index++) {
    const target = page.delegations[index]!
    const body = bodies[index]
    if (detail === 'metadata' || typeof body !== 'string') continue
    const start = detail === 'full' ? integer(options.resultOffset, 0, 0, body.length) : 0
    /** JSON 转义也计入预算；二分寻找能够容纳的最长正文片段。 */
    let low = 0
    let high = detail === 'preview' ? Math.min(1000, body.length - start) : body.length - start
    const assignRange = (length: number): void => {
      target.resultSummary = body.slice(start, start + length)
      target.resultOffset = start
      target.resultTotalChars = body.length
      target.resultTruncated = start > 0 || start + length < body.length
      target.nextResultOffset = start + length < body.length ? start + length : undefined
    }
    assignRange(0)
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      assignRange(middle)
      if (JSON.stringify(page).length <= budget) low = middle
      else high = middle - 1
    }
    assignRange(low)
    // 若必需元数据已占满预算，明确要求更大预算，禁止 full 范围原地死循环。
    if (detail === 'full' && low === 0 && start < body.length) {
      throw new Error('当前字符预算无法容纳正文；请提高 maxChars 或先处理 pendingBlockedEvents')
    }
  }
  page.budgetExceededForRequiredMetadata = JSON.stringify(page).length > budget
  return page
}
