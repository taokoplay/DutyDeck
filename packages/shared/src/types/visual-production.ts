import type { VisualProductionMediaConfiguration, VisualProductionMediaEntry, VisualProductionMediaOption, VisualProductionMediaExecution, VisualProductionMediaSource, VisualProductionMediaKind } from './visual-production-media'
import type { MediaAssetRef } from './media'
import type { VisualEditingDocument, VisualEditingExportJob, VisualEditingExportSettings, VisualEditingOperation, VisualEditingTimelineCandidate, VisualEditingTimelineSnapshot } from './visual-editing'
import { VISUAL_PRODUCTION_IPC_CHANNEL_PREFIX } from './visual-production-plugin'

/** 独立影像业务通道，不复用画布或交互设计存储。 */
export const VISUAL_PRODUCTION_CHANNELS = { INVOKE: `${VISUAL_PRODUCTION_IPC_CHANNEL_PREFIX}invoke`, CHANGED: `${VISUAL_PRODUCTION_IPC_CHANNEL_PREFIX}changed` } as const
/** 作品用途决定浏览与预演方式。 */
export type VisualProductionKind = 'comic' | 'film' | 'promo' | 'image'
/** 剧本节拍承担的唯一叙事功能，用于检查整集是否只有事件堆砌。 */
export type VisualScriptBeatPurpose = 'hook' | 'setup' | 'inciting-incident' | 'rising-action' | 'reveal' | 'turn' | 'resolution' | 'tag'
/**
 * 集级剧本节拍，只保存叙事意图和拍摄约束。
 * 具体画面、运镜、台词和声音仍以 VisualShot 为制作事实，避免两套正文失效。
 */
export interface VisualScriptBeat {
  /** 稳定节拍身份，供镜头映射和人工编辑保持关联。 */
  id: string
  /** 编者可读的节拍名称。 */
  title: string
  /** 该节拍在整集中承担的叙事功能。 */
  purpose: VisualScriptBeatPurpose
  /** 观众此刻需要追问或期待的问题。 */
  dramaticQuestion: string
  /** 只描述事件因果和信息变化，不代替分镜动作。 */
  synopsis: string
  /** 给分镜动作与表演的视觉执行方向。 */
  visualAction: string
  /** 剧本级对白或旁白意图，精确台词仍写入镜头。 */
  dialogue: string
  /** 剧本级声音意图，精确音效与配乐仍写入镜头。 */
  sound: string
  /** 人物、道具、空间、时间或视线等跨镜连续性约束。 */
  continuity: string
  /** 映射到同集镜头；空数组表示尚未分镜，剧本计划阶段允许。 */
  shotIds: string[]
}
/** 一集的结构化剧本，补充 brief 的全片定位和镜头级制作字段。 */
export interface VisualEpisodeScript {
  /** 一句话故事，检查整集是否围绕同一因果主线。 */
  logline: string
  /** 观众看完后应理解、相信或期待的结果。 */
  audiencePromise: string
  /** 前几秒的注意力入口和信息承诺。 */
  hook: string
  /** 局势发生变化或旧判断被推翻的核心转折。 */
  turningPoint: string
  /** 本集给出的阶段结果与下一集钩子。 */
  payoff: string
  /** 本集自然时长目标，单位秒；分镜总时长单独从镜头累计。 */
  targetDurationSeconds: number
  /** 事实边界、表演、声音、连续性和成片验收等拍摄总要求。 */
  productionNotes: string
  /** 有序叙事节拍，数组顺序表示剧本顺序。 */
  beats: VisualScriptBeat[]
}
/** 项目内有序集数。 */
export interface VisualEpisode {
  /** 稳定集数身份。 */
  id: string
  /** 集数名称。 */
  title: string
  /** 可选结构化剧本；旧作品未设置时保持兼容。 */
  script?: VisualEpisodeScript
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
/** 同一镜头独立保存画面、影片和音频，空值表示未采用。 */
export interface VisualShotOutputs {
  /** 静态画面身份。 */
  image: string | null
  /** 动态影片身份。 */
  video: string | null
  /** 独立音频身份。 */
  audio: string | null
}
/** 镜头独立声音设计；对白沿用 dialogue，缺省兼容旧作品。 */
export interface VisualShotSoundDesign {
  /** 环境声及音效要求。 */
  effects: string
  /** 本镜头配乐要求，与作品级音乐设定分开保存。 */
  music: string
}

/** Agent 根据连续动作和镜头边界选择的视频生成方式。 */
export type VisualShotVideoMode = 'text-to-video' | 'image-to-video' | 'first-last-frame'
/** 镜头入场转场属于剪辑意图；不冒充视频模型的帧输入。 */
export type VisualShotTransition = 'hard-cut' | 'match-cut' | 'dissolve'
/** 复杂动作的可检查相位；简单镜头只需填写入场与出场状态。 */
export const VISUAL_SHOT_ACTION_PHASES = ['start', 'development', 'contact', 'peak', 'result', 'reaction', 'exit'] as const
/** 动作相位用于按发生顺序说明复杂动作，不是强制每镜拆成七段。 */
export type VisualShotActionPhase = typeof VISUAL_SHOT_ACTION_PHASES[number]
/** 镜头入场时的声音剪辑关系，与画面生成方式分开保存。 */
export const VISUAL_SHOT_AUDIO_TRANSITIONS = ['hard-cut', 'carry-over', 'prelap', 'dialogue-carry'] as const
/** 声音可硬切、延续、提前进入或让对白跨切点。 */
export type VisualShotAudioTransition = typeof VISUAL_SHOT_AUDIO_TRANSITIONS[number]

/**
 * 复杂动作的关键画面状态；资产仅在确有关键帧时绑定。
 * 该结构用于生成前检查动作中间态，避免只靠首尾帧猜测过程。
 */
export interface VisualShotActionAnchor {
  /** 动作在整镜中的发生相位。 */
  phase: VisualShotActionPhase
  /** 该相位必须可读的人物、道具、空间或界面状态。 */
  state: string
  /** 已加入镜头引用的关键帧资产；没有正式画面锚点时为空。 */
  assetId: string | null
}

/**
 * 相邻镜头之间的制作合同，记录可核对的入场、出场、中间态和声音接续。
 * 画面转场仍由 videoPlan.transitionIn 表达，避免同一含义存两份。
 */
export interface VisualShotContinuityPlan {
  /** 本镜开始时必须继承的状态。 */
  entryState: string
  /** 本镜结束时应稳定交给下一镜的状态。 */
  exitState: string
  /** 需要额外视觉锚点的复杂动作状态，按影片时间顺序排列。 */
  anchors: VisualShotActionAnchor[]
  /** 声音在入场切点上的剪辑关系。 */
  audioTransition: VisualShotAudioTransition
  /** 为何采用该状态链和声音接续，供生成与审片追溯。 */
  rationale: string
}

/**
 * 单镜头视频制作计划；首帧为空表示采用镜头当前正式画面。
 * 首尾帧资产必须同时加入 shot.assetIds，确保生成任务具有正式参考权限。
 */
export interface VisualShotVideoPlan {
  /** 文生视频、当前画面驱动或首尾帧驱动。 */
  mode: VisualShotVideoMode
  /** 显式首帧资产；为空时采用镜头已采用画面。 */
  firstFrameAssetId: string | null
  /** 首尾帧模式的结束状态资产；其他模式为空。 */
  lastFrameAssetId: string | null
  /** 与上一镜的入场关系，由 Agent 按叙事和空间连续性确定。 */
  transitionIn: VisualShotTransition
  /** 选择该生成方式与转场方式的制作依据。 */
  rationale: string
}

/**
 * 单镜头生成计划需要临时登记的首尾帧或动作锚点媒体。
 * 只接受本作品已导入媒体，并创建非锁定资产，避免 Agent 借计划修改现有资产。
 */
export interface VisualShotPlanReference {
  /** 计划引用的稳定资产身份；已存在时必须指向同一媒体。 */
  assetId: string
  /** 本作品媒体库中的不可变媒体身份。 */
  mediaId: string
  /** 用户在影像工作台看到的资产名称。 */
  name: string
  /** 资产业务类型，需与媒体类型一致。 */
  type: string
  /** 该画面如何约束首尾帧或动作连续性。 */
  description: string
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
  /** 可选声音设计；未设置时不生成默认内容。 */
  soundDesign?: VisualShotSoundDesign
  /** 可选分镜衔接合同；旧镜头缺省时保持可读，但视频生成前必须补齐。 */
  continuityPlan?: VisualShotContinuityPlan
  /** 可选视频制作计划；旧镜头缺省时由人去明确生成方式。 */
  videoPlan?: VisualShotVideoPlan
  /** 当前绑定的项目资产。 */
  assetIds: string[]
  /** 兼容视觉主输出，优先影片，其次画面。 */
  mediaId: string | null
  /** 独立输出；缺省时按旧媒体的实际种类解析。 */
  outputs?: VisualShotOutputs
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

/** 视频候选的分项审核状态；pending 表示尚未完成该项。 */
export type VisualReviewGateStatus = 'pending' | 'passed' | 'warning' | 'failed'
/** 审核问题必须归属到技术、动作、相邻衔接或声音门。 */
export type VisualReviewGate = 'technical' | 'motion' | 'continuity' | 'audio'
/** 审核问题的时间点；非空时用于定位视频片段。 */
export interface VisualReviewIssue {
  /** 问题所属审核门。 */
  gate: VisualReviewGate
  /** 警告允许用户判断，错误表示不可采用。 */
  severity: 'warning' | 'error'
  /** 用户可理解的问题说明。 */
  message: string
  /** 视频内的问题时间点，单位秒。 */
  atSeconds?: number
}
/** 可追溯的视频候选审核结论；用户审美确认仍由采用动作表达。 */
export interface VisualCandidateReview {
  /** 文件可解码、规格、黑帧等技术硬门。 */
  technical: VisualReviewGateStatus
  /** 主体、动作、物理和生成瑕疵。 */
  motion: VisualReviewGateStatus
  /** 与前后镜头的动作、空间、光线和声音衔接。 */
  continuity: VisualReviewGateStatus
  /** 实际听验对白、旁白、音效及混音；旧记录缺省兼容。 */
  audio?: VisualReviewGateStatus
  /** 本次审核总结。 */
  conclusion: string
  /** 明确没有覆盖的检查范围。 */
  unchecked: string[]
  /** 可定位的警告或错误。 */
  issues: VisualReviewIssue[]
  /** 审核记录所属会话。 */
  sessionId: string
  /** 审核完成时间，毫秒。 */
  reviewedAt: number
}
/** Agent 提交审核时由宿主补充会话和时间。 */
export type VisualCandidateReviewInput = Omit<VisualCandidateReview, 'sessionId' | 'reviewedAt'>

/** 候选预览与正式采用分离，绑定冻结输入版本。 */
export interface VisualCandidate {
  /** 独立画面候选合并到新版本前的原始基线，供历史追溯。 */
  sourceRevision?: number
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
  /** 新生成的影片或独立声音候选必须审核后才可采用；旧候选缺省兼容。 */
  reviewRequired?: boolean
  /** 宿主检测到独立声音输出变化时要求听验，不由 Agent 自行声明。 */
  reviewAudioRequired?: boolean
  /** 已完成的技术、动作与衔接审核。 */
  review?: VisualCandidateReview
  /** 创建时间。 */
  createdAt: number
}
/** 持久化生成任务，禁止自动重放未知消费。 */
export interface VisualJob {
  /** 仅镜头画面变化时由宿主推进的兼容版本；生成基线仍保留在 baseRevision。 */
  compatibleRevision?: number
  /** 发起时冻结的制作范围；缺省兼容旧作品。 */
  mediaConfiguration?: VisualProductionMediaConfiguration
  /** 本任务声明的目标媒体类别；旧任务缺省兼容。 */
  mediaKind?: VisualProductionMediaKind | 'mixed'
  /** ComfyUI 任务的工作流发现与精确选择状态。 */
  workflowDiscovery?: {
    status: 'required' | 'scanning' | 'candidates' | 'selected' | 'no-match' | 'blocked'
    /** 冻结目标服务身份。 */
    connectionId: string
    /** 本轮工作流输出类别。 */
    mediaKind: VisualProductionMediaKind
    /** 当前发现页的候选数量。 */
    candidateCount: number
    /** 当前发现页无法转换或读取的数量。 */
    blockedCount: number
    /** 继续扫描的下一页；null 表示当前扫描结束。 */
    nextOffset: number | null
    /** 服务器资源快照身份。 */
    snapshotId?: string
    /** 最近一次发现或选择时间。 */
    checkedAt?: number
    /** 已通过服务器工作流检查并准备使用的精确身份。 */
    selectedWorkflow?: { workflowId: string; workflowRevision: number; contentHash: string }
    /** 不可用或未匹配原因。 */
    message?: string
  }
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
  /** 打开作品时采用空镜头的唯一图片候选；这是显式写操作，load 保持只读。 */
  autoAdoptShots: { sessionId: string; productionId: string }
  save: { sessionId: string; productionId: string; baseRevision: number; draft: VisualProductionDraft }
  /** 原子保存单镜头生成计划；只处理目标镜头及其显式引用的新资产。 */
  updateShotPlan: {
    sessionId: string
    productionId: string
    baseRevision: number
    shotId: string
    videoPlan: VisualShotVideoPlan
    continuityPlan: VisualShotContinuityPlan
    references?: VisualShotPlanReference[]
  }
  importFile: { sessionId: string; productionId: string; relativePath: string }
  importMedia: { sessionId: string; productionId: string; reference: MediaAssetRef }
  mediaContent: { sessionId: string; productionId: string; mediaId: string }
  beginJob: { sessionId: string; productionId: string; baseRevision: number; instruction: string; shotId?: string; mediaKind?: VisualProductionMediaKind | 'mixed' }
  recordWorkflowDiscovery: {
    sessionId: string
    productionId: string
    baseRevision: number
    jobId: string
    discovery: NonNullable<VisualJob['workflowDiscovery']>
  }
  referenceMedia: { sessionId: string; productionId: string; baseRevision: number; jobId: string; mediaId: string }
  proposeShot: { sessionId: string; productionId: string; baseRevision: number; jobId: string; shotId: string; mediaId: string; alternativeMediaIds?: string[]; summary: string }
  /** 提交一集结构化剧本候选；正式镜头与预案不改动。 */
  proposeScript: { sessionId: string; productionId: string; baseRevision: number; jobId: string; episodeId: string; script: VisualEpisodeScript; summary: string }
  reviewCandidate: { sessionId: string; productionId: string; baseRevision: number; candidateId: string; review: VisualCandidateReviewInput }
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
  /** 本机候选审片：绑定正式双版本与有限候选，不修改正式时间线。 */
  requestPreview: { sessionId: string; productionId: string; baseRevision: number; episodeId: string; expectedTimelineRevision: number; candidateIds: string[]; range: { start: number; end: number }; settings: VisualEditingExportSettings }
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
  autoAdoptShots: VisualProductionSnapshot
  save: VisualProductionSnapshot
  updateShotPlan: VisualProductionSnapshot
  importFile: VisualMedia
  importMedia: VisualMedia
  mediaContent: { mediaId: string; bytes: Uint8Array; mime: string }
  beginJob: VisualJob
  recordWorkflowDiscovery: VisualJob
  referenceMedia: MediaAssetRef
  proposeShot: VisualCandidate
  proposeScript: VisualCandidate
  reviewCandidate: VisualCandidate
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
  requestPreview: VisualEditingExportJob
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
