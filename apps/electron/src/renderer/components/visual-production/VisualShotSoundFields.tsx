import * as React from 'react'
import { Mic, Music2, Waves } from 'lucide-react'
import type { VisualShot } from '@dutydeck/shared'
import { Textarea } from '@/components/ui/textarea'

/** 声音表单只返回本次修改的声音字段，不接触画面、影片或引用资产。 */
interface VisualShotSoundFieldsProps {
  /** 当前编辑草稿，旧镜头允许缺少 soundDesign。 */
  shot: VisualShot
  /** 图片作品仍可填写对白文案，但不显示音效和配乐。 */
  includeSound?: boolean
  /** 将字段变更交回工作台，沿用草稿隔离和版本校验。 */
  onChange: (patch: Partial<Pick<VisualShot, 'dialogue' | 'soundDesign'>>) => void
}

/** 独立声音弹窗与镜头编辑器共用三项制作要求，最长文本与保存合同一致。 */
export function VisualShotSoundFields({ shot, includeSound = true, onChange }: VisualShotSoundFieldsProps): React.ReactElement {
  return <div className="vp-form-fields vp-sound-fields">
    <label><span><Mic size={14} />对白 / 旁白</span><Textarea rows={3} maxLength={8000} value={shot.dialogue} placeholder="角色、台词与情绪" onChange={event => onChange({ dialogue: event.target.value })} /></label>
    {includeSound && <>
      <label><span><Waves size={14} />环境 / 音效</span><Textarea rows={3} maxLength={8000} value={shot.soundDesign?.effects ?? ''} placeholder="描述声音、出现时机与强弱" onChange={event => onChange({ soundDesign: { effects: event.target.value, music: shot.soundDesign?.music ?? '' } })} /></label>
      <label><span><Music2 size={14} />配乐</span><Textarea rows={2} maxLength={8000} value={shot.soundDesign?.music ?? ''} placeholder="描述情绪、节奏与配器" onChange={event => onChange({ soundDesign: { effects: shot.soundDesign?.effects ?? '', music: event.target.value } })} /></label>
    </>}
  </div>
}
