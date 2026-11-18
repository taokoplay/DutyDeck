import { describe, expect, mock, test } from 'bun:test'
import type { ResourceLoader } from '@earendil-works/pi-coding-agent'
import { preparePromptWithPromaSkills } from './pi-agent-adapter'

describe('首个 prompt 的已校验 Skill 快照', () => {
  test('Given 初始化已加载 When 首个普通 prompt 展开 Then 不重复 reload', async () => {
    /** 模拟已通过受管根过滤的空快照，普通输入也不应重复扫描。 */
    const snapshot = { skills: [], diagnostics: [] }
    /** 计数真实 prepare 路径触发的刷新。 */
    const reload = mock(async () => undefined)
    const loader = { reload, getSkills: () => snapshot } as unknown as ResourceLoader
    expect(await preparePromptWithPromaSkills(loader, '普通输入', undefined, undefined, snapshot)).toEqual({ content: '普通输入', activations: [] })
    expect(reload).toHaveBeenCalledTimes(0)
  })

  test('Given 相同 loader When 后续输入未携带首轮快照 Then 每次重新加载以观察路径变化', async () => {
    /** 后续 queue/steer 保留默认刷新契约。 */
    const reload = mock(async () => undefined)
    const loader = { reload, getSkills: () => ({ skills: [], diagnostics: [] }) } as unknown as ResourceLoader
    await preparePromptWithPromaSkills(loader, '后续一')
    await preparePromptWithPromaSkills(loader, '后续二')
    expect(reload).toHaveBeenCalledTimes(2)
  })

  test('Given 初始化后资源已替换 When 传入旧快照 Then 不复用过期列表', async () => {
    /** 身份不同的数组代表初始化后资源变化。 */
    const snapshot = { skills: [], diagnostics: [] }
    const reload = mock(async () => undefined)
    const loader = { reload, getSkills: () => ({ skills: [], diagnostics: [] }) } as unknown as ResourceLoader
    await preparePromptWithPromaSkills(loader, '输入', undefined, undefined, snapshot)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
