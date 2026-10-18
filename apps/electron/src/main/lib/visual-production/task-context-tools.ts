import { Type } from 'typebox'
import { Value } from 'typebox/value'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { VisualTaskContextRuntime, VisualTaskContextOpenInput, VisualTaskRecordInput } from './task-context'

/** 固定会话工具装配选项；权限由主进程实时复核。 */
export interface VisualTaskContextToolOptions {
  sdk: Pick<typeof import('@earendil-works/pi-coding-agent'), 'defineTool'>
  runtime: VisualTaskContextRuntime
  assertAccess(write: boolean): void | Promise<void>
}
/** 构造独立视觉工具，打开或看图不触发生成、不修改正式作品。 */
export function buildVisualTaskContextTools(options: VisualTaskContextToolOptions): ToolDefinition[] {
  /** 稳定对象身份不允许路径或无限文本。 */
  const id = Type.String({ minLength: 1, maxLength: 128 })
  const target = Type.Union([Type.Object({ kind: Type.Literal('production') }, { additionalProperties: false }), Type.Object({ kind: Type.Literal('shot'), shotId: id }, { additionalProperties: false }), Type.Object({ kind: Type.Literal('asset'), assetId: id }, { additionalProperties: false })])
  const definitions = [
    { name: 'visual_production_open_context', action: 'open' as const, description: '为明确目标开启视觉上下文；新范围替换旧范围，不生成媒体。先读取正式版本。镜头只包含正式输出和绑定资产，连续性镜头须显式指定；candidateId仅加入同目标的候选输出。作品级不会自动加载全作品图片。已有结论仅供追溯，需重新inspect才能做新的视觉判断。', parameters: Type.Object({ productionId: id, productionRevision: Type.Integer({ minimum: 1 }), target, objective: Type.String({ minLength: 1, maxLength: 2000 }), continuityShotIds: Type.Optional(Type.Array(id, { maxItems: 4, uniqueItems: true })), candidateId: Type.Optional(id) }, { additionalProperties: false }) },
    { name: 'visual_production_inspect_media', action: 'inspect' as const, description: '查看当前范围允许的真实媒体。图片作为临时识图样本，视频返回技术检查与有限抽帧；抽帧不能代表全片验收，音频技术检查不代表听取内容。先等待携图模型响应，再record_observation。', parameters: Type.Object({ contextId: id, mediaId: id }, { additionalProperties: false }) },
    { name: 'visual_production_record_observation', action: 'record' as const, description: '保存当前范围已经查看证据的检查目标、模型结论和未检查项。必须引用inspect返回的evidenceId，不接受其他范围或历史证据；不要在同一批工具调用中看图后立即盲评。该操作需要写权限，但不改正式作品。', parameters: Type.Object({ contextId: id, evidenceIds: Type.Array(id, { minItems: 1, maxItems: 32, uniqueItems: true }), objective: Type.String({ minLength: 1, maxLength: 2000 }), conclusion: Type.String({ minLength: 1, maxLength: 8000 }), unchecked: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 32 }) }, { additionalProperties: false }) },
    { name: 'visual_production_close_context', action: 'close' as const, description: '结束本阶段视觉检查并释放后续请求中的样本；保留原始素材与已记录结论。必要时重新打开目标并重新取图。', parameters: Type.Object({ contextId: id }, { additionalProperties: false }) },
  ]
  return definitions.map(definition => options.sdk.defineTool({ name: definition.name, label: definition.name, description: definition.description, parameters: definition.parameters,
    async execute(_callId, input, signal) {
      signal?.throwIfAborted()
      await options.assertAccess(definition.action === 'record')
      signal?.throwIfAborted()
      if (!Value.Check(definition.parameters, input)) throw new Error('VISUAL_CONTEXT_INVALID_INPUT')
      if (definition.action === 'open') return options.runtime.open(input as VisualTaskContextOpenInput, signal)
      if (definition.action === 'inspect') return options.runtime.inspect(input as { contextId: string; mediaId: string }, signal)
      if (definition.action === 'record') return options.runtime.record(input as VisualTaskRecordInput, signal)
      return options.runtime.close(input as { contextId: string })
    },
  }))
}
