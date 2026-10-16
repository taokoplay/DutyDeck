import type { VisualProductionDraft, VisualProductionDocument, VisualShot } from '@proma/shared'

/** 从正式版本提取可编辑字段，深拷贝避免草稿污染已采用内容。 */
export function copyVisualDraft(document: VisualProductionDraft): VisualProductionDraft {
  return structuredClone({ title: document.title, kind: document.kind, brief: document.brief, ratio: document.ratio, fps: document.fps, voice: document.voice, music: document.music, episodes: document.episodes, assets: document.assets, shots: document.shots })
}
/** 只在当前集内交换镜头，其他集的位置与对象保持不变。 */
export function reorderVisualShot(shots: VisualShot[], shotId: string, offset: -1 | 1): VisualShot[] {
  const index = shots.findIndex(shot => shot.id === shotId)
  if (index < 0) return shots
  const indices = shots.map((shot, position) => shot.episodeId === shots[index]!.episodeId ? position : -1).filter(position => position >= 0)
  const target = indices[indices.indexOf(index) + offset]
  if (target === undefined) return shots
  const next = [...shots]
  ;[next[index], next[target]] = [next[target]!, next[index]!]
  return next
}
/** 引用绑定正式作品和版本，Agent 应先读取最新版本并提交候选。 */
export function buildVisualPrompt(document: VisualProductionDocument, shotId?: string, assetId?: string): string {
  return `请协助制作影像作品「${document.title}」。\nproductionId: ${document.id}\nrevision: ${document.revision}${shotId ? `\nshotId: ${shotId}` : ''}${assetId ? `\nassetId: ${assetId}` : ''}\n先读取当前作品和引用资产，保留范围外内容。请使用影像创作工具启动任务、生成真实媒体并提交候选，由我预览后采用。我的要求：`
}
/** 迟到请求只有在同一上下文且最新代次时才可回填界面。 */
export class VisualRequestGate {
  private sequence = 0
  next(): number { return ++this.sequence }
  accepts(ticket: number): boolean { return ticket === this.sequence }
}

/** 工作区往返仍产生新代次，字符串相同不代表旧异步操作仍拥有界面。 */
export class VisualScopeEpoch {
  private context = ''
  private epoch = 0
  enter(context: string): void { if (this.context !== context) { this.context = context; this.epoch++ } }
  capture(): number { return this.epoch }
  accepts(epoch: number): boolean { return this.epoch === epoch }
  invalidate(): void { this.epoch++ }
}
