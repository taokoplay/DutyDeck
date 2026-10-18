/** 影像对象引用只表达身份，不授权生成或修改。 */
export interface VisualProductionReference {
  /** 所属授权 Agent 工作区。 */
  workspaceId: string
  /** 作品稳定身份。 */
  productionId: string
  /** 引用时的正式作品版本，发送时必须仍一致。 */
  productionRevision: number
  /** 明确目标；目标丢失不能降级为整部作品。 */
  target: { kind: 'production' } | { kind: 'shot'; shotId: string } | { kind: 'asset'; assetId: string }
  /** 对象展示名，宿主读取权威值覆盖。 */
  title: string
  /** 作品展示名，宿主读取权威值覆盖。 */
  productionTitle: string
}

/** 验证外部引用结构并返回不共享原对象的快照；不负责授权。 */
export function parseVisualProductionReferences(value: unknown): VisualProductionReference[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error('影像引用无效，请重新引用对象。')
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('影像引用无效，请重新引用对象。')
    /** 按白名单读取，避免额外字段进入运行上下文。 */
    const record = item as Record<string, unknown>
    /** 身份和标题都限定为无控制字符的有限字符串。 */
    const text = (key: string): string => {
      const field = record[key]
      if (typeof field !== 'string' || !field.trim() || field.length > 1024 || /[\u0000-\u001f]/u.test(field)) throw new Error('影像引用无效，请重新引用对象。')
      return field
    }
    if (!Number.isSafeInteger(record.productionRevision) || (record.productionRevision as number) < 1) throw new Error('影像引用版本无效，请重新引用对象。')
    if (!record.target || typeof record.target !== 'object' || Array.isArray(record.target)) throw new Error('影像引用目标无效。')
    /** 目标合同保持区分，不把无效子对象转换为作品。 */
    const target = record.target as Record<string, unknown>
    const targetId = target.kind === 'shot' ? target.shotId : target.assetId
    if (target.kind !== 'production' && (target.kind !== 'shot' && target.kind !== 'asset' || typeof targetId !== 'string' || !targetId.trim() || targetId.length > 1024 || /[\u0000-\u001f]/u.test(targetId))) throw new Error('影像引用目标无效。')
    return {
      workspaceId: text('workspaceId'), productionId: text('productionId'), productionRevision: record.productionRevision as number,
      target: target.kind === 'production' ? { kind: 'production' } : target.kind === 'shot' ? { kind: 'shot', shotId: targetId as string } : { kind: 'asset', assetId: targetId as string },
      title: text('title'), productionTitle: text('productionTitle'),
    }
  })
}

/** 同一对象的稳定键，不因标题或作品版本更新而变化。 */
export function visualProductionReferenceKey(reference: VisualProductionReference): string {
  return JSON.stringify([reference.workspaceId, reference.productionId, reference.target.kind,
    reference.target.kind === 'shot' ? reference.target.shotId : reference.target.kind === 'asset' ? reference.target.assetId : ''])
}

/** 添加显式引用时更新相同对象；不会改变用户文本草稿。 */
export function mergeVisualProductionReferences(current: readonly VisualProductionReference[], additions: readonly VisualProductionReference[]): VisualProductionReference[] {
  /** Map 保持首次出现顺序，同时只保留明确选取的最新快照。 */
  const references = new Map(current.map(reference => [visualProductionReferenceKey(reference), reference]))
  for (const reference of additions) references.set(visualProductionReferenceKey(reference), reference)
  return [...references.values()]
}

/** 仅清除本次已接管快照；异步期间新增或更新的引用继续保留。 */
export function removeSentVisualProductionReferences(current: readonly VisualProductionReference[], sent: readonly VisualProductionReference[]): VisualProductionReference[] {
  return current.filter(reference => !sent.some(item => visualProductionReferenceKey(item) === visualProductionReferenceKey(reference) && item.productionRevision === reference.productionRevision))
}

/** 失败或退回草稿时补回缺失对象，不能覆盖用户后来添加的版本。 */
export function restoreVisualProductionReferences(current: readonly VisualProductionReference[], restored: readonly VisualProductionReference[]): VisualProductionReference[] {
  return mergeVisualProductionReferences(restored, current)
}
