import { resolveVisualShotOutputs } from '@dutydeck/shared'
import type { VisualCandidate, VisualJob, VisualMedia, VisualProductionSnapshot, VisualShot } from '@dutydeck/shared'

/** 分镜三类输出的稳定顺序与用户名称。 */
export const SHOT_MEDIA_KINDS = ['image', 'video', 'audio'] as const
/** 同一名称供预览、选择器和候选比较使用。 */
export const SHOT_MEDIA_LABELS = { image: '画面', video: '影片', audio: '音频' }
/** 工作台将宿主真实阶段翻译成用户可理解的制作状态。 */
const JOB_STAGE_LABELS: Record<NonNullable<VisualJob['stage']>, string> = {
  preparing: '准备参考素材',
  generating: '生成媒体中',
  reviewing: '检查生成结果',
}
/** 媒体运行阶段优先于任务粗粒度阶段，未知阶段保留原值以便诊断。 */
const MEDIA_PHASE_LABELS: Record<string, string> = {
  prepared: '准备完成',
  uploading: '上传素材',
  submitting: '提交任务',
  queued: '排队中',
  running: '生成中',
  collecting: '整理结果',
  succeeded: '生成完成',
  failed: '生成失败',
  cancelled: '已取消',
}

/** 独立素材位区分正式输出和待采用预览，预览不改变绑定。 */
export interface ShotMediaSlot {
  /** 素材位只接受对应种类。 */
  kind: VisualMedia['kind']
  /** 当前正式采用的媒体；尚未采用时为空。 */
  adopted?: VisualMedia
  /** 优先正式输出，否则展示最新可采用候选。 */
  preview?: VisualMedia
  /** 仅包含当前镜头、当前版本且实际改变该槽的候选。 */
  candidates: VisualCandidate[]
}

/** 视频生成计划中可展示的首帧或尾帧。 */
export interface ShotFrameSlot {
  role: 'first' | 'last'
  label: '首帧' | '尾帧'
  sourceLabel: string
  state: 'ready' | 'missing'
  media?: VisualMedia
}

/**
 * 查找镜头最新仍在运行的任务。
 * @param snapshot 当前作品快照。
 * @param shotId 目标镜头身份。
 * @returns 最新运行任务；没有活动任务时为空。
 */
export function findRunningShotJob(snapshot: VisualProductionSnapshot, shotId: string): VisualJob | undefined {
  return snapshot.jobs
    .filter(job => job.shotId === shotId && job.status === 'running')
    .sort((left, right) => right.createdAt - left.createdAt)[0]
}

/**
 * 将任务与最近一次媒体运行转换成单一用户可读阶段。
 * @param job 当前运行任务。
 * @returns 媒体运行阶段；没有运行回执时退回任务阶段。
 */
export function visualJobActivityLabel(job: VisualJob): string {
  const execution = [...(job.mediaExecutions ?? [])].sort((left, right) => right.createdAt - left.createdAt)[0]
  if (execution?.phase) return MEDIA_PHASE_LABELS[execution.phase] ?? execution.phase
  return job.stage ? JOB_STAGE_LABELS[job.stage] : '处理中'
}

/**
 * 将镜头视频计划中的首尾帧解析为可展示素材。
 * @param snapshot 当前作品快照。
 * @param shot 目标镜头。
 * @returns 按首帧、尾帧排序的素材位；文生视频或未设置时为空。
 */
export function buildShotFrameSlots(snapshot: VisualProductionSnapshot, shot: VisualShot): ShotFrameSlot[] {
  const plan = shot.videoPlan
  if (!plan || plan.mode === 'text-to-video') return []
  /** 一次索引同时服务输出类型解析和图片帧查找，避免逐帧扫描媒体库。 */
  const allMedia = new Map(snapshot.media.map(item => [item.id, item]))
  const outputs = resolveVisualShotOutputs(shot, allMedia)
  const resolveAsset = (assetId: string | null): { sourceLabel: string; media?: VisualMedia } => {
    if (!assetId) {
      const current = outputs.image && allMedia.get(outputs.image)?.kind === 'image' ? allMedia.get(outputs.image) : undefined
      return { sourceLabel: '当前已采用画面', ...(current ? { media: current } : {}) }
    }
    const asset = snapshot.document.assets.find(item => item.id === assetId)
    const candidate = asset?.mediaId ? allMedia.get(asset.mediaId) : undefined
    const resolved = candidate?.kind === 'image' ? candidate : undefined
    return { sourceLabel: asset?.name ?? '帧资产不可用', ...(resolved ? { media: resolved } : {}) }
  }
  const first = resolveAsset(plan.firstFrameAssetId)
  const slots: ShotFrameSlot[] = [{
    role: 'first',
    label: '首帧',
    sourceLabel: first.sourceLabel,
    state: first.media ? 'ready' : 'missing',
    ...(first.media ? { media: first.media } : {}),
  }]
  if (plan.mode === 'first-last-frame') {
    const last = resolveAsset(plan.lastFrameAssetId)
    slots.push({
      role: 'last',
      label: '尾帧',
      sourceLabel: last.sourceLabel,
      state: last.media ? 'ready' : 'missing',
      ...(last.media ? { media: last.media } : {}),
    })
  }
  return slots
}

/** 从最新快照构造分镜素材位；旧候选仅声明其 mediaId 所属种类。 */
export function buildShotMediaSlots(snapshot: VisualProductionSnapshot, shot: VisualShot): ShotMediaSlot[] {
  /** 索引元数据，避免每个候选重复扫描媒体库。 */
  const media = new Map(snapshot.media.map(item => [item.id, item]))
  /** 旧分镜按真实媒体类型解析，不把视频当作图片。 */
  const outputs = resolveVisualShotOutputs(shot, media)
  /** 冻结同一镜头可采用的候选差异，其他镜头与过期内容不能混入。 */
  const pending = snapshot.candidates.filter(item => item.status === 'ready' && item.baseRevision === snapshot.document.revision)
    .map(item => ({ candidate: item, shot: item.draft.shots.find(value => value.id === shot.id) }))
    .filter(item => item.shot !== undefined).sort((left, right) => right.candidate.createdAt - left.candidate.createdAt)
  return SHOT_MEDIA_KINDS.map(kind => {
    /** 显式三槽候选比较对应槽，旧候选只影响 mediaId 的实际种类。 */
    const candidates = pending.filter(item => {
      const proposed = resolveVisualShotOutputs(item.shot!, media)[kind]
      return !!proposed && proposed !== outputs[kind] && media.get(proposed)?.kind === kind
    }).map(item => item.candidate)
    /** 空槽可预览候选，但不得在数据与状态上称为已采用。 */
    const adopted = outputs[kind] ? media.get(outputs[kind]!) : undefined
    const first = candidates[0]?.draft.shots.find(item => item.id === shot.id)
    const previewId = first ? resolveVisualShotOutputs(first, media)[kind] : null
    return { kind, adopted, preview: adopted ?? (previewId ? media.get(previewId) : undefined), candidates }
  })
}

/**
 * 为分镜列表生成稳定状态文案，运行任务优先于静态素材是否就绪。
 * @param snapshot 当前作品快照。
 * @param shot 目标镜头。
 * @returns 已采用、候选、真实制作阶段或空状态文案。
 */
export function visualShotStatusLabel(snapshot: VisualProductionSnapshot, shot: VisualShot): string {
  const slots = buildShotMediaSlots(snapshot, shot)
  const video = slots.find(slot => slot.kind === 'video')
  const image = slots.find(slot => slot.kind === 'image')
  if (video?.adopted) return snapshot.shotStates[shot.id]?.needsUpdate ? '影片已采用 · 待更新' : '影片已采用'
  if (video?.candidates.length) return `${video.candidates.length} 个影片候选`
  const running = findRunningShotJob(snapshot, shot.id)
  if (running) return visualJobActivityLabel(running)
  return image?.preview ? '画面就绪 · 待制作影片' : '未生成'
}
