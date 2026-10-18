import * as React from 'react'
import type { VisualEditingTimelineCandidate } from '@dutydeck/shared'
import { Button } from '@/components/ui/button'

/** 将候选状态转换为用户可理解的文案，过期候选不能继续采用。 */
function statusLabel(candidate: VisualEditingTimelineCandidate, currentRevision: number): string {
  if (candidate.status === 'ready' && candidate.baseRevision !== currentRevision) return '已过期'
  if (candidate.status === 'ready') return '待审阅'
  if (candidate.status === 'adopted') return '已采用'
  if (candidate.status === 'discarded') return '已丢弃'
  return '已过期'
}

/** Agent 剪辑候选摘要；完整时间线只在用户点击预览时打开。 */
export function VisualEditingCandidates({ candidates, currentRevision, onPreview }: { candidates: VisualEditingTimelineCandidate[]; currentRevision: number; onPreview: (candidateId: string) => void }): React.ReactElement | null {
  if (!candidates.length) return null
  return <section className="vp-editing-candidates" aria-label="剪辑候选修改">
    <header className="vp-editing-candidates-header"><div><strong>候选修改</strong><span className="vp-muted">Agent 提交的时间线建议，采用后才会进入正式版本</span></div><span className="vp-muted">{candidates.length} 条</span></header>
    <div className="vp-editing-candidate-list">
      {candidates.map(candidate => <article className={`vp-editing-candidate vp-editing-candidate-${candidate.status}`} key={candidate.id}>
        <div className="vp-editing-candidate-main"><div className="vp-editing-candidate-title"><strong>{candidate.summary || '未命名修改'}</strong><span className="vp-badge">{statusLabel(candidate, currentRevision)}</span></div><span className="vp-muted">基于时间线 v{candidate.baseRevision} · {candidate.operations.length} 项操作 · {candidate.timeline.duration.toFixed(1)} 秒</span></div>
        <Button size="sm" variant="outline" onClick={() => onPreview(candidate.id)}>预览候选</Button>
      </article>)}
    </div>
  </section>
}
