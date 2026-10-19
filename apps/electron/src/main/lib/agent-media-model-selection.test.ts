import { describe, expect, test } from 'bun:test'
import { getReferencedMediaModelRefs } from './agent-media-model-selection'
import { createAgentModuleToolPolicy } from './agent-modules/module-tool-policy'

describe('媒体模型显式选择的共享校验', () => {
  test('Given 混合合法重复和畸形引用 When 解析 Then 保留原模型与顺序且不修改输入', () => {
    /** 模拟媒体选择及损坏的历史检查点，涵盖三类共享媒体能力。 */
    const refs = ['media:image:http:profile:gpt-image-2', 'media:video:http:video:video-1',
      'media:audio:http:audio:speech', 'gpt-image-2', '', null, 1, {}, 'media:image:http:profile:gpt-image-2']
    /** 原输入副本用于确认归一化不会改写消息或历史记录。 */
    const original = structuredClone(refs)
    expect(getReferencedMediaModelRefs(refs)).toEqual([
      'media:image:http:profile:gpt-image-2', 'media:video:http:video:video-1', 'media:audio:http:audio:speech',
    ])
    expect(refs).toEqual(original)
  })

  test('Given 缺失或畸形字段 When 解析 Then 不能由普通文字或对象推断媒体授权', () => {
    for (const value of [undefined, null, '', 'media:image:http:profile:gpt-image-2', {}, 1,
      ['media:image:http:__proto__:model'], ['media:image:http:profile:constructor'], ['media:image:http:profile:model\n']]) {
      expect(getReferencedMediaModelRefs(value)).toEqual([])
    }
  })

  test('Given 仅由宿主装配共享媒体工具 When 通过模块门禁 Then 精确工具可用且专业模块仍关闭', () => {
    /** 与 service 扩展到 Orchestrator 的实际准入方式一致，不把模型引用当作模块 ID。 */
    const mediaTools = ['media_list_models', 'media_prepare_generation', 'media_execute_generation']
    const policy = createAgentModuleToolPolicy({ activeModuleIds: [], toolMode: 'standard', trustedToolNames: mediaTools })
    for (const name of mediaTools) expect(policy.denyTool(name)).toBeUndefined()
    for (const moduleId of ['canvas', 'visual-production', 'interaction-design']) expect(policy.hasModule(moduleId)).toBe(false)
    for (const name of ['canvas_create_artifact', 'visual_production_begin_job', 'prototype_propose', 'media_unregistered']) {
      expect(policy.denyTool(name)?.behavior).toBe('deny')
    }
  })
})
