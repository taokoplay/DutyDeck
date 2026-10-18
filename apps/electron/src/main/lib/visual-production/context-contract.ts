/** 宿主为单次 Agent 运行签发的可序列化影像上下文策略，不包含图片字节或访问凭据。 */
export interface VisualTaskContextPolicy {
  /** 当前运行身份，旧运行的工具事件不能重新激活任务范围。 */
  runId: string
  /** 宿主在模型开始前已建立的任务范围；子任务可直接使用该范围。 */
  initialContextId?: string
  /** 宿主明确确认属于本轮影像范围的旧媒体，仅用于精确识别历史 read 图片。 */
  legacyMedia?: Array<{
    /** 不可变媒体身份。 */
    mediaId: string
    /** 原始内容 SHA-256，不能由文件名或相似图片推断。 */
    hash: string
  }>
}

/** 影像宿主工具通过 details.visualTaskContext 返回的生命周期事件。 */
export interface VisualTaskContextEvent {
  /** 固定协议版本。 */
  version: 1
  /** 签发事件的当前运行身份。 */
  runId: string
  /** 宿主建立并验证的任务范围。 */
  contextId: string
  /** 显式范围转换或检查、观察记录动作。 */
  action: 'open' | 'inspect' | 'close' | 'observation'
  /** 当前检查对应的证据身份。 */
  evidenceId?: string
  /** 本次检查对应的不可变媒体身份。 */
  mediaId?: string
  /** 本次检查对应的原始媒体 SHA-256。 */
  mediaHash?: string
  /** inspect 必须由宿主明确签发；技术事实不能替代视觉样本，也不能由模型自行降级。 */
  inspectionKind?: 'visual' | 'technical'
}
