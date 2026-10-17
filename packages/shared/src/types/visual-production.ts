import type { VisualProductionMediaConfiguration, VisualProductionMediaEntry, VisualProductionMediaOption, VisualProductionMediaExecution, VisualProductionMediaSource, VisualProductionMediaKind } from './visual-production-media'
import type { MediaAssetRef } from './media'
import type { VisualEditingDocument, VisualEditingExportJob, VisualEditingExportSettings, VisualEditingOperation, VisualEditingTimelineCandidate, VisualEditingTimelineSnapshot } from './visual-editing'

/** 独立影像业务通道，不复用画布或交互设计存储。 */
export const VISUAL_PRODUCTION_CHANNELS = { INVOKE: 'visual-production:invoke', CHANGED: 'visual-production:changed' } as const
/** 作品用途决定浏览与预演方式。 */
export type VisualProductionKind = 'comic' | 'film' | 'promo' | 'image'
/** 项目内有序集数。 */
export interface VisualEpisode {
  /** 稳定集数身份。 */
  id: string
  /** 集数名称。 */
  title: string
}
/** 可复用制作资产，媒体内容独立保存。 */
export interface VisualAsset {
  /** 稳定资产身份。 */
  id: string
  /** 用户可读名称。 */
  name: string
  /** 业务类型：角色、场景、产品、道具、风格、品牌、声音。 */
  type: string
  /** 外观、一致性或使用约束。 */
  description: string
  /** 锁定后 Agent 候选不能改动此资产。 */
  locked: boolean
  /** 独立影像媒体身份；尚无素材时为空。 */
  mediaId: string | null
}
/** 数组位置表示同集镜头顺序；图片作品也使用此创作单元。 */
export interface VisualShot {
  /** 稳定镜头身份。 */
  id: string
  /** 所属集数身份。 */
  episodeId: string
  /** 镜头名称。 */
  title: string
  /** 预演秒数，图片作品允许零。 */
  duration: number
  /** 画面描述和场景。 */
  scene: string
  /** 镜头运动与主体动作。 */
  motion: string
  /** 对白、旁白或字幕要求。 */
  dialogue: string
  /** 当前绑定的项目资产。 */
  assetIds: string[]
  /** 正式采用的媒体身份。 */
  mediaId: string | null
}
/** 人工和 Agent 共用的完整创作内容；不含运行态及系统版本。 */
export interface VisualProductionDraft {
  /** 作品名称。 */
  title: string
  /** 作品用途。 */
  kind: VisualProductionKind
  /** 作品目标与受众。 */
  brief: string
  /** 输出宽高比例。 */
  ratio: string
  /** 目标帧率。 */
  fps: number
  /** 配音要求。 */
  voice: string
  /** 音乐要求。 */
  music: string
  /** 集数目录。 */
  episodes: VisualEpisode[]
  /** 全项目共用资产。 */
  assets: VisualAsset[]
  /** 镜头和图片创作单元。 */
  shots: VisualShot[]
}
/** 主进程分配正式身份与单调版本。 */
export interface VisualProductionDocument extends VisualProductionDraft {
  /** 持久化格式版本。 */
  schemaVersion: 1
  /** 影像作品身份，与 Agent 项目身份不同。 */
  id: string
  /** 正式内容版本。 */
  revision: number
  /** 创建时间，毫秒。 */
  createdAt: number
  /** 保存时间，毫秒。 */
  updatedAt: number
}
/** 项目列表不携带草稿或媒体字节。 */
export interface VisualProductionSummary {
  /** 作品身份。 */
  id: string
  /** 作品名称。 */
  title: string
  /** 作品类型。 */
  kind: VisualProductionKind
  /** 正式版本。 */
  revision: number
  /** 集数数量。 */
  episodeCount: number
  /** 资产数量。 */
  assetCount: number
  /** 镜头数量。 */
  shotCount: number
  /** 最近保存时间。 */
  updatedAt: number
}
/** 内容寻址媒体元数据；永不携带任意远程 URL 或本机路径。 */
export interface VisualMedia {
  /** 媒体稳定身份。 */
  id: string
  /** 原始可读名称。 */
  name: string
  /** 内容 SHA-256。 */
  hash: string
  /** 验证后的 MIME。 */
  mime: string
  /** 媒体种类。 */
  kind: 'image' | 'video' | 'audio'
  /** 实际字节大小。 */
  byteSize: number
  /** 导入时间。 */
  createdAt: number
}
/** 由主进程计算的镜头一致性，不接受调用方自行声明。 */
export interface VisualShotState {
  /** 镜头设定版本。 */
  revision: number
  /** 正式输出更换次数。 */
  outputVersion: number
  /** 设定或关联资产变化后输出需要更新。 */
  needsUpdate: boolean
}
/** 候选预览与正式采用分离，绑定冻结输入版本。 */
export interface VisualCandidate {
  /** 采用后分配的正式版本，仅用于追溯。 */
  adoptedRevision?: number
  /** 候选身份。 */
  id: string
  /** 生成使用的正式版本。 */
  baseRevision: number
  /** 候选完整创作内容。 */
  draft: VisualProductionDraft
  /** 变更说明。 */
  summary: string
  /** 采纳资格。 */
  status: 'ready' | 'stale' | 'adopted' | 'discarded'
  /** 所属生成任务。 */
  jobId: string
  /** 创建时间。 */
  createdAt: number
}
/** 持久化生成任务，禁止自动重放未知消费。 */
export interface VisualJob {
  /** 发起时冻结的制作范围；缺省兼容旧作品。 */
  mediaConfiguration?: VisualProductionMediaConfiguration
  /** 可信宿主读取的实际执行记录。 */
  mediaExecutions?: VisualProductionMediaExecution[]
  /** 任务身份。 */
  id: string
  /** 发起普通会话。 */
  sessionId: string
  /** 固定输入版本。 */
  baseRevision: number
  /** 可选的单镜头边界。 */
  shotId?: string
  /** 本次生成要求。 */
  instruction: string
  /** 任务执行状态。 */
  status: 'running' | 'candidate' | 'failed' | 'cancelled' | 'interrupted'
  /** 可选制作阶段，旧任务未记录时保持兼容。 */
  stage?: 'preparing' | 'generating' | 'reviewing'
  /** 创建时间。 */
  createdAt: number
  /** 失败或取消说明。 */
  message?: string
}
/** 一次有界读取，包含制作关系与候选，不携带媒体二进制。 */
export interface VisualProductionSnapshot {
  /** 当前作品制作方案，独立版本。 */
  mediaConfiguration?: VisualProductionMediaConfiguration
  /** 正式作品。 */
  document: VisualProductionDocument
  /** 登记的独立媒体元数据。 */
  media: VisualMedia[]
  /** 资产一致性版本。 */
  assetVersions: Record<string, number>
  /** 镜头版本与更新状态。 */
  shotStates: Record<string, VisualShotState>
  /** 有界候选集合。 */
  candidates: VisualCandidate[]
  /** 有界任务集合。 */
  jobs: VisualJob[]
}
/** 所有来源路径均由主进程据 sessionId 绑定项目根。 */
export interface VisualProductionInputs {
  resolveMediaWorkflow: { sessionId: string; productionId: string; source: Extract<VisualProductionMediaSource, { type: 'workflow' }>; kind: VisualProductionMediaKind }
  mediaCatalog: { sessionId: string; productionId: string }
  saveMediaConfiguration: { sessionId: string; productionId: string; expectedRevision: number; entries: VisualProductionMediaEntry[]; defaults: VisualProductionMediaConfiguration['defaults'] }
  recordMediaExecution: { sessionId: string; productionId: string; baseRevision: number; jobId: string; runId: string; engine: 'model' | 'workflow' }
  list: { sessionId: string }
  create: { sessionId: string; title: string; kind: VisualProductionKind }
  load: { sessionId: string; productionId: string }
  save: { sessionId: string; productionId: string; baseRevision: number; draft: VisualProductionDraft }
  importFile: { sessionId: string; productionId: string; relativePath: string }
  importMedia: { sessionId: string; productionId: string; reference: MediaAssetRef }
  mediaContent: { sessionId: string; productionId: string; mediaId: string }
  beginJob: { sessionId: string; productionId: string; baseRevision: number; instruction: string; shotId?: string }
  referenceMedia: { sessionId: string; productionId: string; baseRevision: number; jobId: string; mediaId: string }
  proposeShot: { sessionId: string; productionId: string; baseRevision: number; jobId: string; shotId: string; mediaId: string; summary: string }
  updateJob: { sessionId: string; productionId: string; baseRevision: number; jobId: string; stage: 'preparing' | 'generating' | 'reviewing' }
  propose: { sessionId: string; productionId: string; baseRevision: number; jobId: string; draft: VisualProductionDraft; summary: string }
  adopt: { sessionId: string; productionId: string; baseRevision: number; candidateId: string }
  discardCandidate: { sessionId: string; productionId: string; candidateId: string }
  cancelJob: { sessionId: string; productionId: string; jobId: string }
  failJob: { sessionId: string; productionId: string; jobId: string; message: string }
  exportManifest: { sessionId: string; productionId: string }
  /** 读取指定集的剪辑时间线和候选，不携带媒体二进制。 */
  loadTimeline: { sessionId: string; productionId: string; episodeId: string }
  /** 按当前分镜和采用媒体建立指定集的初始时间线。 */
  createRoughCut: { sessionId: string; productionId: string; episodeId: string; baseProductionRevision: number }
  /** 保存时间线正式版本，时间线 revision 必须比 expectedRevision 大一。 */
  saveTimeline: { sessionId: string; productionId: string; episodeId: string; expectedRevision: number; timeline: VisualEditingDocument }
  /** 登记 Agent 的时间线候选，宿主不会直接修改正式时间线。 */
  proposeTimelineEdit: { sessionId: string; productionId: string; episodeId: string; expectedRevision: number; operations: VisualEditingOperation[]; summary: string }
  /** 采用指定集的时间线候选。 */
  adoptTimelineEdit: { sessionId: string; productionId: string; episodeId: string; candidateId: string; expectedRevision: number }
  /** 丢弃指定集的时间线候选。 */
  discardTimelineEdit: { sessionId: string; productionId: string; episodeId: string; candidateId: string }
  /** 创建冻结时间线版本的成片导出任务。 */
  requestExport: { sessionId: string; productionId: string; episodeId: string; expectedTimelineRevision: number; settings: VisualEditingExportSettings }
  /** 读取指定集的导出任务。 */
  listExportJobs: { sessionId: string; productionId: string; episodeId: string }
  /** 取消仍在本机排队或准备中的导出任务。 */
  cancelExport: { sessionId: string; productionId: string; episodeId: string; exportJobId: string }
}
/** 方法到返回值的一一映射。 */
export interface VisualProductionResults {
  resolveMediaWorkflow: VisualProductionMediaOption
  mediaCatalog: VisualProductionMediaOption[]
  saveMediaConfiguration: VisualProductionSnapshot
  recordMediaExecution: VisualJob
  list: VisualProductionSummary[]
  create: VisualProductionSnapshot
  load: VisualProductionSnapshot
  save: VisualProductionSnapshot
  importFile: VisualMedia
  importMedia: VisualMedia
  mediaContent: { mediaId: string; bytes: Uint8Array; mime: string }
  beginJob: VisualJob
  referenceMedia: MediaAssetRef
  proposeShot: VisualCandidate
  updateJob: VisualJob
  propose: VisualCandidate
  adopt: VisualProductionSnapshot
  discardCandidate: VisualProductionSnapshot
  cancelJob: VisualProductionSnapshot
  failJob: VisualProductionSnapshot
  exportManifest: { fileName: string; json: string }
  loadTimeline: VisualEditingTimelineSnapshot
  createRoughCut: VisualEditingTimelineSnapshot
  saveTimeline: VisualEditingTimelineSnapshot
  proposeTimelineEdit: VisualEditingTimelineCandidate
  adoptTimelineEdit: VisualEditingTimelineSnapshot
  discardTimelineEdit: VisualEditingTimelineSnapshot
  requestExport: VisualEditingExportJob
  listExportJobs: VisualEditingExportJob[]
  cancelExport: VisualEditingExportJob
}
/** 有限 IPC 方法。 */
export type VisualProductionMethod = keyof VisualProductionInputs
/** 可判别命令信封。 */
export type VisualProductionCommand = { [M in VisualProductionMethod]: { method: M; input: VisualProductionInputs[M] } }[VisualProductionMethod]
/** 轻量刷新通知。 */
export interface VisualProductionChanged {
  /** Agent 项目身份。 */
  workspaceId: string
  /** 可选受影响的作品。 */
  productionId?: string
}
/** Renderer 的窄访问接口。 */
export interface VisualProductionApi {
  /** 执行命令；错误在当前面板呈现。 */
  invoke<M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M]): Promise<VisualProductionResults[M]>
  /** 订阅当前项目失效通知，返回注销函数。 */
  onChanged(callback: (event: VisualProductionChanged) => void): () => void
}
