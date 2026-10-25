import type { VisualProductionMediaKind } from './visual-production-media'
import type { VisualProductionSnapshot, VisualShot } from './visual-production'
import { resolveVisualShotOutputs } from '../utils/visual-shot-outputs'

/** 生产准备的稳定阻断码，UI、Agent 和宿主共用同一含义。 */
export type VisualProductionReadinessCode =
  | 'SCRIPT_MISSING'
  | 'SCRIPT_BEAT_UNMAPPED'
  | 'SHOT_UNMAPPED'
  | 'SHOT_BREAKDOWN_INCOMPLETE'
  | 'ASSET_MEDIA_MISSING'
  | 'VIDEO_PLAN_MISSING'
  | 'CONTINUITY_PLAN_MISSING'
  | 'SOUND_DESIGN_MISSING'
  | 'MODEL_ROUTE_MISSING'

/** 单个媒体生产阶段的就绪状态。 */
export interface VisualProductionMediaReadiness {
  kind: 'script' | VisualProductionMediaKind
  status: 'ready' | 'warning' | 'blocked'
  readyShotCount: number
  totalShotCount: number
  blockerCodes: VisualProductionReadinessCode[]
  blockerShotIds: string[]
}

/** 一集制作合同的结构化准备结果。 */
export interface VisualEpisodeProductionReadiness {
  episodeId: string
  script: VisualProductionMediaReadiness
  image: VisualProductionMediaReadiness
  video: VisualProductionMediaReadiness
  audio: VisualProductionMediaReadiness
}

/**
 * 从正式作品派生剧本、图片、视频和声音的生产准备度。
 * @param snapshot 当前正式作品。
 * @param episodeId 待生产集数。
 * @returns 不修改数据的阶段门禁；供脚本页和生产工具共同使用。
 */
export function assessVisualEpisodeProductionReadiness(
  snapshot: VisualProductionSnapshot,
  episodeId: string,
): VisualEpisodeProductionReadiness {
  const episode = snapshot.document.episodes.find(item => item.id === episodeId)
  const shots = snapshot.document.shots.filter(shot => shot.episodeId === episodeId)
  const totalShotCount = shots.length
  const script = episode?.script
  const mappedShotIds = new Set(script?.beats.flatMap(beat => beat.shotIds) ?? [])
  const media = new Map(snapshot.media.map(item => [item.id, item]))
  const missingAssetMedia = shots.flatMap(shot => shot.assetIds).filter(assetId => {
    const asset = snapshot.document.assets.find(item => item.id === assetId)
    return !asset?.mediaId || !media.has(asset.mediaId)
  })
  const scriptBlockers: VisualProductionReadinessCode[] = []
  if (!script) scriptBlockers.push('SCRIPT_MISSING')
  if (script?.beats.some(beat => beat.shotIds.length === 0)) scriptBlockers.push('SCRIPT_BEAT_UNMAPPED')
  if (shots.some(shot => !mappedShotIds.has(shot.id))) scriptBlockers.push('SHOT_UNMAPPED')
  if (missingAssetMedia.length) scriptBlockers.push('ASSET_MEDIA_MISSING')

  const imageBlockerShots = shots.filter(shot => !resolveVisualShotOutputs(shot, media).image).map(shot => shot.id)
  const videoBlockerShots = shots.filter(shot => !isVideoShotReady(snapshot, shot, mappedShotIds)).map(shot => shot.id)
  const audioBlockerShots = shots.filter(shot => !hasSoundDesign(shot)).map(shot => shot.id)
  const imageBlockerCodes: VisualProductionReadinessCode[] = imageBlockerShots.length ? ['ASSET_MEDIA_MISSING'] : []
  const videoBlockerCodes: VisualProductionReadinessCode[] = []
  if (shots.some(shot => !shot.videoPlan)) videoBlockerCodes.push('VIDEO_PLAN_MISSING')
  if (shots.some(shot => !isContinuityPlanReady(shot))) videoBlockerCodes.push('CONTINUITY_PLAN_MISSING')
  if (missingAssetMedia.length) videoBlockerCodes.push('ASSET_MEDIA_MISSING')
  const audioBlockerCodes: VisualProductionReadinessCode[] = audioBlockerShots.length ? ['SOUND_DESIGN_MISSING'] : []
  return {
    episodeId,
    script: readiness('script', scriptBlockers.length ? 0 : totalShotCount, totalShotCount, scriptBlockers, scriptBlockers.length ? shots.map(shot => shot.id) : []),
    image: readiness('image', totalShotCount - imageBlockerShots.length, totalShotCount, imageBlockerCodes, imageBlockerShots),
    video: readiness('video', totalShotCount - videoBlockerShots.length, totalShotCount, videoBlockerCodes, videoBlockerShots),
    audio: readiness('audio', totalShotCount - audioBlockerShots.length, totalShotCount, audioBlockerCodes, audioBlockerShots),
  }
}

/** 视频镜头必须同时具备剧本映射、完整拆镜、生成方式、衔接合同和可用资产。 */
function isVideoShotReady(snapshot: VisualProductionSnapshot, shot: VisualShot, mappedShotIds: ReadonlySet<string>): boolean {
  if (!mappedShotIds.has(shot.id) || !shot.scene.trim() || !shot.motion.trim() || !shot.videoPlan || !isContinuityPlanReady(shot)) return false
  return shot.assetIds.every(assetId => {
    const asset = snapshot.document.assets.find(item => item.id === assetId)
    return Boolean(asset?.mediaId && snapshot.media.some(item => item.id === asset.mediaId))
  })
}

/**
 * 衔接合同至少说明入场、出场事实与选择依据；空壳对象不能通过生产门。
 * @param shot 待检查镜头。
 * @returns 可实际指导生成和审片的合同是否存在。
 */
function isContinuityPlanReady(shot: VisualShot): boolean {
  const plan = shot.continuityPlan
  return Boolean(plan?.entryState.trim() && plan.exitState.trim() && plan.rationale.trim())
}

/** 对白属于镜头正文；独立声音设计仍至少要写明环境音效或配乐。 */
function hasSoundDesign(shot: VisualShot): boolean {
  return Boolean(shot.soundDesign && (shot.soundDesign.effects.trim() || shot.soundDesign.music.trim()))
}

/** 统一生成阶段状态，避免 UI 与宿主对 blocked/warning 判断不一致。 */
function readiness(
  kind: 'script' | VisualProductionMediaKind,
  readyShotCount: number,
  totalShotCount: number,
  blockerCodes: VisualProductionReadinessCode[],
  blockerShotIds: string[],
): VisualProductionMediaReadiness {
  const status = blockerCodes.length ? 'blocked' : readyShotCount === totalShotCount ? 'ready' : 'warning'
  return { kind, status, readyShotCount, totalShotCount, blockerCodes: [...new Set(blockerCodes)], blockerShotIds: [...new Set(blockerShotIds)] }
}
