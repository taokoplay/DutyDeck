import type { VisualCandidate, VisualProductionInputs, VisualProductionMethod, VisualProductionResults, VisualProductionSnapshot } from '@dutydeck/shared'

/** 交付声明不执行写操作；正式写入与候选必须由本轮宿主回执证明。 */
export interface VisualTaskDelivery {
  outcome: 'written' | 'candidate' | 'read-only' | 'blocked'
  productionIds: string[]
  reason: string
}

/** 仅保留交付事实，不复制剧本、媒体或历史候选正文。 */
interface DeliveryFact {
  productionId: string
  revision?: number
  candidateId?: string
  shotCount?: number
}

/**
 * 每轮运行独立核验交付；不从用户关键词或模型聊天正文猜测写入授权。
 * @param productionIds 本轮经主进程校验的显式作品范围。
 * @returns 记录实际工具结果、核对交付声明及生成有界续行要求的方法。
 */
export function createVisualDeliveryCheck(productionIds: readonly string[] = []) {
  /** 当前范围只用于完成核查，不构成跨作品写入权限。 */
  const targets = new Set(productionIds)
  const writes = new Map<string, DeliveryFact>()
  const candidates = new Map<string, DeliveryFact>()
  let engaged = targets.size > 0
  /** 后续任意领域操作都会使提前提交的声明失效。 */
  let sequence = 0
  let confirmedSequence = -1
  return {
    /** 只接收已成功返回的领域结果；失败、聊天及 beginJob 均不能冒充交付。 */
    record<M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M], result: VisualProductionResults[M]): void {
      engaged = true
      sequence++
      if ('productionId' in input) targets.add(input.productionId)
      if (method === 'create' || method === 'updateShotPlan' || method === 'adopt') {
        const snapshot = result as VisualProductionSnapshot
        /** 采用必须匹配精确候选和新正式版本，不能借旧候选或其它作品回执。 */
        const adopted = method !== 'adopt' || ('candidateId' in input && 'baseRevision' in input
          && snapshot.document.id === input.productionId && snapshot.document.revision > input.baseRevision
          && snapshot.candidates.some(item => item.id === input.candidateId && item.status === 'adopted'))
        if (adopted) {
          targets.add(snapshot.document.id)
          writes.set(snapshot.document.id, { productionId: snapshot.document.id, revision: snapshot.document.revision, shotCount: snapshot.document.shots.length })
        }
      }
      if (method === 'propose' || method === 'proposeScript' || method === 'proposeShot') {
        const candidate = result as VisualCandidate
        if ('productionId' in input && (candidate.status === 'ready' || candidate.status === 'adopted')) {
          candidates.set(input.productionId, { productionId: input.productionId, candidateId: candidate.id })
          if (candidate.status === 'adopted' && candidate.adoptedRevision !== undefined) {
            writes.set(input.productionId, { productionId: input.productionId, revision: candidate.adoptedRevision, candidateId: candidate.id })
          }
        }
      }
      if ((method === 'adoptTimelineEdit' || method === 'createRoughCut') && 'productionId' in input) {
        const timeline = result as VisualProductionResults['loadTimeline']
        if (timeline.timeline?.productionId === input.productionId) {
          writes.set(input.productionId, { productionId: input.productionId, revision: timeline.timeline.revision })
        }
      }
      if (method === 'proposeTimelineEdit' && 'productionId' in input) {
        const candidate = result as VisualProductionResults['proposeTimelineEdit']
        candidates.set(input.productionId, { productionId: input.productionId, candidateId: candidate.id })
      }
    },
    /** 声明必须说明真实结果；只读、受阻不触发采用、媒体生成或收费重试。 */
    complete(input: VisualTaskDelivery) {
      if (!input.reason.trim()) throw new Error('交付说明不能为空')
      const ids = [...new Set(input.productionIds)]
      if (input.outcome === 'written' && (!ids.length || ids.some(id => !writes.has(id)))) throw new Error('本轮没有这些作品的正式写入回执；聊天文字、读取、启动任务或提交候选均不等于已保存')
      if (input.outcome === 'candidate' && (!ids.length || ids.some(id => !candidates.has(id)))) throw new Error('本轮没有这些作品的候选提交回执')
      if (ids.some(id => !targets.has(id))) throw new Error('交付作品不属于本轮已确认范围')
      if (input.outcome === 'read-only' && (writes.size || candidates.size)) throw new Error('本轮已有写入或候选，不能报告为纯只读')
      confirmedSequence = sequence
      return { outcome: input.outcome, productionIds: ids, writes: [...writes.values()], candidates: [...candidates.values()] }
    },
    /** 只对触达影像范围的运行检查；普通聊天不增加推理回合。 */
    pending(): string | null {
      if (!engaged || confirmedSequence === sequence) return null
      return `本轮尚未核验影像交付，不能把聊天中的剧本或分镜表当作已写入作品。请根据用户原始要求继续：要求创建/修改时，核对准确 productionId 和最新 revision，完成 begin_job → propose/propose_script → adopt_candidate；新增镜头须提交完整 draft。仅讨论、只读审查或用户仅要候选时不得擅自采用；计划模式、缺权限、版本冲突或能力不足时说明未保存的具体原因，不重发收费请求。结束前调用 visual_production_complete_task，outcome 使用 written（有正式写入回执）、candidate（仅候选）、read-only（无须写入）或 blocked（未完成），提供准确 productionIds 和 reason；声明本身不会保存内容。\n宿主本轮事实：${JSON.stringify({ productionIds: [...targets].slice(0, 32), writes: [...writes.values()].slice(0, 32), candidates: [...candidates.values()].slice(0, 32) })}`
    },
  }
}
