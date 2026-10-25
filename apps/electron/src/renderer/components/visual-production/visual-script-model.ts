import { assessVisualEpisodeProductionReadiness } from '@dutydeck/shared'
import type { VisualEpisodeProductionReadiness, VisualEpisodeScript, VisualProductionDocument, VisualProductionSnapshot, VisualScriptBeatPurpose } from '@dutydeck/shared'

/** 剧本页共用的叙事功能中文名称。 */
export const SCRIPT_PURPOSE_LABELS: Record<VisualScriptBeatPurpose, string> = {
  hook: '开场钩子',
  setup: '情境建立',
  'inciting-incident': '触发事件',
  'rising-action': '推进升级',
  reveal: '信息揭示',
  turn: '核心转折',
  resolution: '阶段结果',
  tag: '尾钩',
}

/** 从剧本和镜头派生的制作流程阶段。 */
export type VisualScriptFlowStageId = 'script' | 'storyboard' | 'continuity' | 'assets' | 'image' | 'video' | 'audio' | 'delivery'
/** 单个流程阶段的完成状态；warning 表示可继续但仍有风险。 */
export interface VisualScriptFlowStage {
  id: VisualScriptFlowStageId
  label: string
  status: 'missing' | 'warning' | 'ready'
  detail: string
}

/** 一集剧本的完整生产概览。 */
export interface VisualScriptOverview {
  status: 'missing' | 'incomplete' | 'ready'
  beatCount: number
  mappedShotCount: number
  totalShotCount: number
  shotDurationSeconds: number
  targetDurationSeconds: number
  issues: string[]
  stages: VisualScriptFlowStage[]
  production: VisualEpisodeProductionReadiness
}

/**
 * 从正式剧本、镜头和素材派生整集拍摄准备度，不修改数据。
 * @param snapshot 当前正式作品快照。
 * @param episodeId 目标集数。
 * @returns 流程阶段和可直接显示的风险说明。
 */
export function buildVisualScriptOverview(snapshot: VisualProductionSnapshot, episodeId: string): VisualScriptOverview {
  const episode = snapshot.document.episodes.find(item => item.id === episodeId)
  const shots = snapshot.document.shots.filter(item => item.episodeId === episodeId)
  const script = episode?.script
  const duration = shots.reduce((sum, shot) => sum + shot.duration, 0)
  if (!script) {
    const production = assessVisualEpisodeProductionReadiness(snapshot, episodeId)
    return {
      status: 'missing',
      beatCount: 0,
      mappedShotCount: 0,
      totalShotCount: shots.length,
      shotDurationSeconds: roundSeconds(duration),
      targetDurationSeconds: 0,
      issues: ['尚无结构化剧本；当前剧情只能从作品目标与镜头正文反推。'],
      stages: [
        { id: 'script', label: '剧本', status: 'missing', detail: '未写入正式版本' },
        { id: 'storyboard', label: '分镜', status: shots.length ? 'warning' : 'missing', detail: shots.length ? `${shots.length} 个镜头尚未映射到叙事节拍` : '尚无镜头' },
        { id: 'continuity', label: '衔接', status: 'missing', detail: '剧本未结构化，入场、出场和声音接续未建立' },
        { id: 'assets', label: '资产', status: 'warning', detail: '需从正式镜头反查' },
        { id: 'image', label: '画面', status: production.image.status === 'ready' ? 'ready' : 'warning', detail: `${production.image.readyShotCount} / ${production.image.totalShotCount} 镜有正式画面` },
        { id: 'video', label: '视频', status: 'missing', detail: '脚本未结构化，生成门禁未建立' },
        { id: 'audio', label: '声音', status: 'missing', detail: '逐镜声音责任未建立' },
        { id: 'delivery', label: '交付', status: 'missing', detail: '尚未形成完整审片与成片' },
      ],
      production,
    }
  }

  const mappedShotIds = new Set(script.beats.flatMap(beat => beat.shotIds))
  const mappedShots = shots.filter(shot => mappedShotIds.has(shot.id))
  const issues: string[] = []
  const coreMissing = [script.logline, script.audiencePromise, script.hook, script.turningPoint, script.payoff].some(value => !value.trim())
  if (coreMissing) issues.push('一句话故事、观众承诺、开场钩子、核心转折或阶段结果仍有空缺。')
  if (script.beats.length < 3) issues.push('至少需要三个节拍才能形成可检查的因果推进。')
  if (script.beats.some(beat => !beat.shotIds.length)) issues.push('仍有剧本节拍没有映射到镜头。')
  const unmappedShots = shots.filter(shot => !mappedShotIds.has(shot.id))
  if (unmappedShots.length) issues.push(`${unmappedShots.length} 个镜头未归属任何叙事节拍。`)
  if (script.beats.some(beat => !beat.continuity.trim())) issues.push('仍有节拍缺少人物、道具、空间或视线连续性约束。')
  const missingBreakdown = mappedShots.filter(shot => !shot.scene.trim() || !shot.motion.trim())
  if (missingBreakdown.length) issues.push(`${missingBreakdown.length} 个映射镜头缺少画面或动作设计。`)
  const missingPlans = mappedShots.filter(shot => !shot.videoPlan)
  if (missingPlans.length) issues.push(`${missingPlans.length} 个映射镜头尚未填写视频生成方式与转场依据。`)
  const missingContinuity = mappedShots.filter(shot => !shot.continuityPlan?.entryState.trim() || !shot.continuityPlan.exitState.trim() || !shot.continuityPlan.rationale.trim())
  if (missingContinuity.length) issues.push(`${missingContinuity.length} 个映射镜头尚未写明入场、出场状态和衔接依据。`)
  const missingAssets = mappedShots.flatMap(shot => shot.assetIds).filter(assetId => {
    const asset = snapshot.document.assets.find(item => item.id === assetId)
    return !asset?.mediaId || !snapshot.media.some(media => media.id === asset.mediaId)
  })
  if (missingAssets.length) issues.push(`${new Set(missingAssets).size} 个镜头引用资产尚无可用素材。`)
  if (script.targetDurationSeconds > 0 && Math.abs(script.targetDurationSeconds - duration) > Math.max(2, script.targetDurationSeconds * 0.1)) {
    issues.push(`分镜总时长 ${roundSeconds(duration)} 秒与剧本目标 ${script.targetDurationSeconds} 秒偏差较大。`)
  }

  const scriptReady = !coreMissing && script.beats.length >= 3
  const mappedReady = mappedShotIds.size > 0 && unmappedShots.length === 0 && script.beats.every(beat => beat.shotIds.length > 0)
  const assetsReady = missingAssets.length === 0
  const continuityReady = missingContinuity.length === 0
  const production = assessVisualEpisodeProductionReadiness(snapshot, episodeId)
  const deliveredCount = shots.filter(shot => Boolean(shot.outputs?.video)).length
  return {
    status: scriptReady && mappedReady && assetsReady && production.image.status === 'ready' && production.video.status === 'ready' && production.audio.status === 'ready' ? 'ready' : 'incomplete',
    beatCount: script.beats.length,
    mappedShotCount: mappedShots.length,
    totalShotCount: shots.length,
    shotDurationSeconds: roundSeconds(duration),
    targetDurationSeconds: script.targetDurationSeconds,
    issues,
    stages: [
      { id: 'script', label: '剧本', status: scriptReady ? 'ready' : 'warning', detail: `${script.beats.length} 个叙事节拍` },
      { id: 'storyboard', label: '分镜', status: mappedReady ? 'ready' : 'warning', detail: `${mappedShots.length} / ${shots.length} 镜已映射` },
      { id: 'continuity', label: '衔接', status: continuityReady ? 'ready' : 'warning', detail: `${mappedShots.length - missingContinuity.length} / ${mappedShots.length} 镜已定义入场、出场与声音接续` },
      { id: 'assets', label: '资产', status: assetsReady ? 'ready' : 'warning', detail: assetsReady ? '引用资产均有正式素材' : `${new Set(missingAssets).size} 项待补素材` },
      { id: 'image', label: '画面', status: readinessStage(production.image.status), detail: `${production.image.readyShotCount} / ${production.image.totalShotCount} 镜有正式画面` },
      { id: 'video', label: '视频', status: readinessStage(production.video.status), detail: missingPlans.length ? `${missingPlans.length} 镜待定生成方式` : missingContinuity.length ? `${missingContinuity.length} 镜缺衔接合同` : `${production.video.readyShotCount} / ${production.video.totalShotCount} 镜可生成` },
      { id: 'audio', label: '声音', status: readinessStage(production.audio.status), detail: `${production.audio.readyShotCount} / ${production.audio.totalShotCount} 镜已有声音设计` },
      { id: 'delivery', label: '交付', status: deliveredCount === shots.length && shots.length > 0 && production.audio.status === 'ready' ? 'ready' : 'warning', detail: `${deliveredCount} / ${shots.length} 镜已有可剪辑视频` },
    ],
    production,
  }
}

/**
 * 构造交给主 Agent 的整集剧本请求，只填充输入框，不自动发送。
 * @param document 当前正式作品。
 * @param episodeId 目标集数。
 * @returns 可追加到 Agent 输入框的结构化要求。
 */
export function buildVisualScriptPrompt(document: VisualProductionDocument, episodeId: string): string | null {
  const episode = document.episodes.find(item => item.id === episodeId)
  if (!episode) return null
  const shots = document.shots.filter(item => item.episodeId === episodeId)
  const duration = roundSeconds(shots.reduce((sum, shot) => sum + shot.duration, 0))
  return `请为影像作品「${document.title}」的「${episode.title}」生成或重构结构化剧本候选。先读取作品 ${document.id} 的 brief、全部资产与本集 ${shots.length} 个镜头（当前分镜总时长 ${duration} 秒），再创建本轮影像任务并调用 visual_production_propose_script（proposeScript）提交候选。

剧本必须从整集拍摄流程出发，补齐：1. 一句话故事与观众承诺；2. 前几秒钩子和注意力承诺；3. 有因果关系的节拍，而不是事件清单；4. 每个节拍唯一的戏剧问题、视觉动作方向、对白/旁白意图、声音与连续性；5. 核心转折、阶段结果和尾钩；6. 目标时长与每个节拍映射到的真实 shotId。

重点检查当前视频可能出现的缺点：人物身份与符号漂移、空间方位或越轴、手部与道具接触错误、动作中间态未定义、首尾帧不能证明过程、台词时长与镜头时长不匹配、声音和转场缺少叙事依据、静帧或单镜候选中被误写成完整成片。精确 scene、motion、dialogue、soundDesign、continuityPlan、videoPlan 和 assetIds 仍写镜头；continuityPlan 必须给出入场、出场、复杂动作中间锚点和声音接续，剧本只提供上游依据；不得修改正式镜头、媒体或把未生成内容写成已完成。提交候选后向用户说明剧本解决的具体制作风险。`
}

/** 保留一位小数，避免浮点时长展示噪声。 */
function roundSeconds(value: number): number {
  return Math.round(value * 10) / 10
}

/** 将共享制作门禁状态映射为脚本页流程状态。 */
function readinessStage(status: 'ready' | 'warning' | 'blocked'): 'ready' | 'warning' | 'missing' {
  if (status === 'ready') return 'ready'
  if (status === 'blocked') return 'missing'
  return 'warning'
}

/** 导出函数仅用于组件回填空剧本时的最小结构。 */
export function emptyVisualEpisodeScript(): VisualEpisodeScript {
  return {
    logline: '', audiencePromise: '', hook: '', turningPoint: '', payoff: '',
    targetDurationSeconds: 0, productionNotes: '', beats: [],
  }
}
