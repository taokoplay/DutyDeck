import { describe, expect, test } from 'bun:test'
import type { SDKMessage, SDKUserMessage, SkillActivation } from '@dutydeck/shared'
import { mergeSkillActivationStore, parseSkillActivationStore, projectSkillActivations,
  skillActivationContentDigest, type SkillActivationStoreData } from './skill-activation-projection'

/** 为快照匹配创建用户消息；正文只由调用方指定。 */
function user(uuid: string, text = '原始输入'): SDKUserMessage {
  return { type: 'user', uuid, parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } }
}
/** 测试使用的规范 Skill 激活记录。 */
const additions: SkillActivation[] = [{ slug: 'review', name: '代码审查', sources: ['read'] }]

describe('Skill 快照投影的边界与索引', () => {
  test('Given JSONL 中含 null When 投影 Then 原样返回且不抛异常', () => {
    const data = mergeSkillActivationStore({ version: 1, entries: [] }, user('known'), additions)
    expect(projectSkillActivations(data, null as unknown as SDKMessage)).toBeNull()
  })
  test('Given UUID 无匹配 When 投影 Then 不读取或序列化正文', () => {
    const data = mergeSkillActivationStore({ version: 1, entries: [] }, user('known'), additions)
    const message = user('unmatched')
    Object.defineProperty(message, 'message', { get() { throw new Error('不应访问无匹配正文') } })
    expect(projectSkillActivations(data, message)).toBe(message)
  })
  test('Given 同一大快照被多次投影 When UUID 匹配 Then 条目只在建索引时扫描一次', () => {
    /** getter 计数直接证明扫描次数，不依赖机器速度或计时阈值。 */
    let uuidReads = 0
    const target = user('target')
    const digest = skillActivationContentDigest(target)
    const data: SkillActivationStoreData = { version: 1, entries: Array.from({ length: 1000 }, (_, index) => ({
      get uuid() { uuidReads += 1; return index === 999 ? 'target' : `other-${index}` },
      contentDigest: digest, additions,
    })) }
    expect((projectSkillActivations(data, target) as SDKUserMessage).skill_activations).toEqual(additions)
    const firstReads = uuidReads
    for (let index = 0; index < 10; index += 1) projectSkillActivations(data, target)
    expect(firstReads).toBe(1000)
    expect(uuidReads).toBe(firstReads)
  })
  test('Given 同 UUID 不同正文与后续快照 When 投影 Then 摘要隔离且旧索引不污染新快照', () => {
    const original = user('same')
    const changed = user('same', '另一条输入')
    const first = mergeSkillActivationStore({ version: 1, entries: [] }, original, additions)
    expect((projectSkillActivations(first, original) as SDKUserMessage).skill_activations).toEqual(additions)
    expect(projectSkillActivations(first, changed)).toBe(changed)
    const second = mergeSkillActivationStore(first, changed, [{ slug: 'write', name: '写作', sources: ['explicit'] }])
    expect((projectSkillActivations(second, changed) as SDKUserMessage).skill_activations?.[0]?.slug).toBe('write')
    expect((projectSkillActivations(second, original) as SDKUserMessage).skill_activations).toEqual(additions)
    expect(projectSkillActivations(first, changed)).toBe(changed)
    expect(mergeSkillActivationStore(second, changed, [{ slug: 'write', name: '写作', sources: ['explicit'] }])).toBe(second)
  })
  test('Given null 快照条目或激活 When 解析 Then 返回明确结构错误', () => {
    expect(() => parseSkillActivationStore(null)).toThrow('旁车结构无效')
    expect(() => parseSkillActivationStore({ version: 1, entries: [null] })).toThrow('旁车条目无效')
    expect(() => parseSkillActivationStore({ version: 1, entries: [{ uuid: 'a', contentDigest: '0'.repeat(64), additions: [null] }] })).toThrow('旁车激活列表无效')
    expect(() => mergeSkillActivationStore({ version: 1, entries: [] }, null as unknown as SDKUserMessage, additions)).toThrow('缺少用户输入 UUID')
  })
})
