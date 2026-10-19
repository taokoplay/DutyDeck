import { describe, expect, test } from 'bun:test'
import { diagnoseLegacyPluginEntry } from './plugin-migration'

describe('旧插件入口只读诊断', () => {
  test('Given 旧可执行入口 When 检查 Then 返回拒绝诊断且不改写原始 manifest', () => {
    // 冻结的旧清单证明诊断不会偷偷修改入口或插件身份。
    const legacy = Object.freeze({ id: 'old.plugin', entry: Object.freeze({ kind: 'native' }) })
    expect(diagnoseLegacyPluginEntry(legacy)).toMatchObject({
      pluginId: 'old.plugin', status: 'rejected', errorCode: 'AGENT_PLUGIN_LEGACY_EXECUTABLE_ENTRY_UNSUPPORTED',
    })
    expect(legacy.entry.kind).toBe('native')
  })

  test('Given 声明清单或缺失入口 When 检查 Then 不猜测旧数据格式', () => {
    expect(diagnoseLegacyPluginEntry({ id: 'safe.plugin', entry: { kind: 'manifest-only' } })).toBeNull()
    expect(diagnoseLegacyPluginEntry({ id: 'old.plugin' })).toMatchObject({
      errorCode: 'AGENT_PLUGIN_LEGACY_ENTRY_MISSING',
    })
    expect(diagnoseLegacyPluginEntry(null)).toBeNull()
  })
})
