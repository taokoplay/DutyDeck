import { describe, expect, test } from 'bun:test'
import { createContentPluginMutationGuard, type ContentPluginMutationLeases } from './content-plugin-mutation-guard'
describe('Given 原内容IPC与固定配方共享的变更门禁', () => {
  test('When 存在其他实例、busy或操作失败 Then 不绕过准入并始终释放lease', async () => {
    let other = false; let busy = false; let released = 0; let writes = 0
    const leases = { acquireMigrationGuard: async () => ({ release: () => { released++ } }), hasOtherActiveLease: async () => other } as ContentPluginMutationLeases
    const mutate = createContentPluginMutationGuard(() => busy, leases)
    expect(await mutate(() => ++writes)).toBe(1)
    other = true
    await expect(mutate(() => ++writes)).rejects.toThrow('其他 DutyDeck 窗口')
    other = false; busy = true
    await expect(mutate(() => ++writes)).rejects.toThrow('Agent 正在运行或排队')
    busy = false
    await expect(mutate(() => { throw new Error('fixture commit failed') })).rejects.toThrow('fixture commit failed')
    expect(writes).toBe(1); expect(released).toBe(4)
  })
})
