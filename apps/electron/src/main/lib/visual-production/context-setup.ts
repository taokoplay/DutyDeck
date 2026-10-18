import type { VisualProductionReference } from '@dutydeck/shared'
import type { VisualTaskContextPolicy } from './context-contract'
import type { VisualTaskContextRuntime } from './task-context'

/**
 * 在首个模型请求前核验显式引用范围，不读取任何图像字节。
 * @param runtime 已绑定当前会话的影像域运行时。
 * @param runId 当前不可恢复授权身份。
 * @param references 已经过消息接管前校验的对象引用。
 * @param signal 当前运行撤销信号。
 * @returns 首轮可序列化策略与有界范围提示；多对象时由实际意图选择范围。
 */
export async function prepareVisualTaskContext(runtime: VisualTaskContextRuntime, runId: string, references: readonly VisualProductionReference[], signal?: AbortSignal): Promise<{ policy: VisualTaskContextPolicy; prompt: string }> {
  const policy: VisualTaskContextPolicy = { runId }
  const legacyMedia = new Map<string, { mediaId: string; hash: string }>()
  let prompt = ''
  for (const reference of references) {
    signal?.throwIfAborted()
    const opened = await runtime.open({ productionId: reference.productionId, productionRevision: reference.productionRevision,
      target: reference.target, objective: '根据用户本次消息检查引用对象；对象引用本身不授权生成或修改。' }, signal)
    const contextId = opened.details.visualTaskContext.contextId
    const scope = await runtime.describe(contextId, signal)
    if (scope.workspaceId !== reference.workspaceId) throw new Error('VISUAL_CONTEXT_WORKSPACE_CHANGED')
    for (const media of scope.media) legacyMedia.set(media.hash, { mediaId: media.id, hash: media.hash })
    if (references.length === 1) {
      policy.initialContextId = contextId
      prompt = `宿主已为本次引用准备视觉范围；这不代表已经看过图片。按用户目标选取 mediaId 调用 inspect_media，记录结论后 close_context。\n${JSON.stringify(scope)}`
    } else await runtime.close({ contextId })
  }
  if (legacyMedia.size) policy.legacyMedia = [...legacyMedia.values()]
  if (references.length > 1) prompt = '用户引用了多个对象。请依据当前意图调用 visual_production_open_context 选择主目标；跨镜头比较用显式 continuityShotIds。不同作品/资产逐范围检查，保留有版本的观察，不能默认采用最后一个引用。'
  if (prompt.length > 48 * 1024) throw new Error('VISUAL_CONTEXT_PROMPT_LIMIT: 请减少本次引用或缩小检查范围')
  return { policy, prompt }
}
