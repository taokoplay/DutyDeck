import type { MediaAssetRef } from './media'

/** 制作能力对应的输出媒体类别。 */
export type VisualProductionMediaKind = 'image' | 'video' | 'audio'
/** 仅保存公共来源身份，凭据由全局媒体服务解析。 */
export type VisualProductionMediaSource = { type: 'connection'; connectionId: string } | { type: 'model'; modelRef: string } | { type: 'workflow'; connectionId: string; workflowId: string; workflowRevision: number }
/** 执行事实必须记录精确模型或工作流，服务本身不能冒充执行来源。 */
export type VisualProductionMediaExecutionSource = Exclude<VisualProductionMediaSource, { type: 'connection' }>
/**
 * 判断配置是否授权给定来源；服务可授权其工作流，反向不得扩大范围。
 * @param configured 作品保存的来源。
 * @param actual 待选择或实际执行的来源。
 * @returns 来源身份相同或工作流属于已授权服务。
 */
export function visualProductionMediaSourceAllows(configured: VisualProductionMediaSource, actual: VisualProductionMediaSource): boolean {
  if (configured.type === 'model') return actual.type === 'model' && configured.modelRef === actual.modelRef
  if (configured.type === 'connection') return (actual.type === 'connection' || actual.type === 'workflow') && configured.connectionId === actual.connectionId
  return actual.type === 'workflow' && configured.connectionId === actual.connectionId && configured.workflowId === actual.workflowId && configured.workflowRevision === actual.workflowRevision
}
/** 适配器实际接受的简单参数。 */
export type VisualProductionMediaParameterValue = string | number | boolean
/** 当前作品启用的制作方案。 */
export interface VisualProductionMediaEntry {
  /** 作品内稳定身份。 */
  id: string
  /** 用户可读名称。 */
  name: string
  /** 输出类别。 */
  kind: VisualProductionMediaKind
  /** 全局来源引用。 */
  source: VisualProductionMediaSource
  /** 默认参数，不存凭据。 */
  parameters: Record<string, VisualProductionMediaParameterValue>
}
/** 可编辑参数描述来自真实适配器或工作流绑定。 */
export interface VisualProductionMediaParameter {
  /** 输入键。 */
  key: string
  /** 显示名。 */
  label: string
  /** 值类型。 */
  type: 'string' | 'number' | 'boolean'
  /** 可选默认值。 */
  defaultValue?: VisualProductionMediaParameterValue
  /** 有限枚举。 */
  options?: VisualProductionMediaParameterValue[]
  /** 数值下界。 */
  min?: number
  /** 数值上界。 */
  max?: number
}
/** 公开目录；available 只表示配置可执行，不代表远端在线。 */
export interface VisualProductionMediaOption extends VisualProductionMediaEntry {
  /** 已配置且当前适配器支持；不表示在线探测结果。 */
  available: boolean
  /** 不可执行时的具体原因。 */
  unavailableReason?: string
  /** 适配器接收输入的真实约束。 */
  constraints: { maxImageReferences?: number; parameters?: VisualProductionMediaParameter[] }
}
/** 独立版本不改变创作内容或已有候选；缺省表示兼容继承全局目录。 */
export interface VisualProductionMediaConfiguration {
  /** 仅制作配置的单调版本。 */
  revision: number
  /** 作品允许使用的来源范围。 */
  entries: VisualProductionMediaEntry[]
  /** 各输出类别的首选方案身份。 */
  defaults: Partial<Record<VisualProductionMediaKind, string>>
}
/** 宿主从真实运行记录生成的制作凭据，调用方不能自行填写。 */
export interface VisualProductionMediaExecution {
  /** 宿主从运行结果读取的真实输出数；多图结果不得自动替用户选择。 */
  outputCount?: number
  /** 真实媒体运行身份。 */
  runId: string
  /** 运行引擎类别。 */
  engine: 'model' | 'workflow'
  /** 匹配到的冻结方案身份。 */
  entryId?: string
  /** 实际运行的公开显示名称。 */
  name: string
  /** 实际输出类别。 */
  kind: VisualProductionMediaKind
  /** 实际使用的全局来源及版本。 */
  source: VisualProductionMediaExecutionSource
  /** 实际执行参数。 */
  parameters: Record<string, VisualProductionMediaParameterValue>
  /** 实际参考素材的不可变身份。 */
  referenceAssets: MediaAssetRef[]
  /** 当前媒体运行阶段。 */
  phase: string
  /** 运行创建时间，毫秒。 */
  createdAt: number
  /** 实际生成提示词，不含认证信息。 */
  prompt?: string
}
