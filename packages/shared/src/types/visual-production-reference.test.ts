import type { VisualProductionReference } from './visual-production-reference'
import { describe, expect, test } from 'bun:test'
import { parseVisualProductionReferences } from './visual-production-reference'

describe('影像结构化引用合同', () => {
  test('Given 镜头引用 When 解析 Then 完整保留身份版本且拒绝缺失目标', () => {
    /** 最小有效镜头快照。 */
    const reference: VisualProductionReference = { workspaceId: 'w', productionId: 'p', productionRevision: 3, target: { kind: 'shot', shotId: 's' }, title: '镜头', productionTitle: '作品' }
    expect(parseVisualProductionReferences([reference])).toEqual([reference])
    expect(() => parseVisualProductionReferences([{ ...reference, target: { kind: 'shot' } }])).toThrow()
    expect(() => parseVisualProductionReferences([{ ...reference, productionRevision: 0 }])).toThrow()
    expect(() => parseVisualProductionReferences(null)).toThrow()
  })
})
