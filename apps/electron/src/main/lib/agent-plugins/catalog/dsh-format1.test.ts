import { describe, expect, test } from 'bun:test'
import { parseDshFormat1 } from './dsh-format1'

export function indexFixture() {
  return { format: 1, plugins: [{ name: '@demo/calc', title: { zh: '计算工具', en: 'Calculator' }, description: { zh: '<script>内容不是代码</script>' }, metadata: { category: 'tools' }, repository: { url: 'https://github.com/demo/calc' }, versions: [{ version: '1.2.3', source: { type: 'npm' }, engines: { dsh: '^0.2.0' } }] }] }
}

describe('Given format 1 目录而非包代码', () => {
  test('When 读取合法工具分类 Then 保留精确版本及纯文本，兼容仍待分析', () => {
    const entries = parseDshFormat1(indexFixture())
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ name: '@demo/calc', title: '计算工具', description: '<script>内容不是代码</script>', compatibility: 'unassessed', versions: [{ version: '1.2.3', sourceType: 'npm', engines: { dsh: '^0.2.0' } }] })
  })
  test('When 格式/包名/版本列表/重复条目畸形 Then 拒绝整个新快照', () => {
    const valid = indexFixture()
    for (const input of [{ format: 2, plugins: [] }, { format: 1, plugins: [null] }, { ...valid, plugins: [...valid.plugins, ...valid.plugins] }, { format: 1, plugins: [{ ...valid.plugins[0], name: '../local' }] }, { format: 1, plugins: [{ ...valid.plugins[0], versions: [] }] }]) {
      expect(() => parseDshFormat1(input)).toThrow('PLUGIN_CATALOG_INVALID')
    }
  })
  test('When 包含私网/脚本repository和未知来源 Then 不创建可点击目标或可执行兼容结论', () => {
    const valid = indexFixture()
    valid.plugins[0]!.repository.url = 'javascript:alert(1)'
    valid.plugins[0]!.versions[0]!.source.type = 'git'
    const entry = parseDshFormat1(valid)[0]!
    expect(entry.repository).toBeNull()
    expect(entry.versions[0]!.sourceType).toBe('git')
    expect(entry.compatibility).toBe('unassessed')
  })
  test('When 条目、描述或版本数超限 Then 拒绝且不截断成合法包', () => {
    const valid = indexFixture()
    expect(() => parseDshFormat1({ format: 1, plugins: Array.from({ length: 25_001 }, () => valid.plugins[0]) })).toThrow()
    valid.plugins[0]!.description.zh = 'x'.repeat(16_385)
    expect(() => parseDshFormat1(valid)).toThrow()
  })
})
