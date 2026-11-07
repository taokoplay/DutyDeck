import { describe, expect, test } from 'bun:test'
import { hashPluginBytes, inspectPluginPackage } from '../package'
import { buildDshToolPackage, type DshBundleCompiler } from './build'
import type { DshBuildRecipe } from './recipe'

function fixture() {
  const files = new Map<string, Uint8Array>([
    ['package.json', Buffer.from('{"name":"dsh-own-fixture","version":"1.0.0","license":"MIT"}')],
    ['LICENSE', Buffer.from('自有fixture许可文本')], ['lib/index.js', Buffer.from('export function apply() {}')],
  ])
  const adapter = Buffer.from('export function createDshRegistrationScope() { throw new Error("fixture") }')
  const recipe: DshBuildRecipe = {
    formatVersion: 1, recipeId: 'fixture-tool-only', recipeVersion: '0.1.0',
    source: { name: 'dsh-own-fixture', version: '1.0.0', archiveSha256: 'a'.repeat(64), url: 'https://registry.npmjs.org/dsh-own-fixture/-/dsh-own-fixture-1.0.0.tgz', license: 'MIT', files: Object.fromEntries([...files].map(([key, bytes]) => [key, hashPluginBytes(bytes)])) },
    entry: 'lib/index.js', imports: { 'lib/index.js': {} },
    adapter: { version: '0.1.0', sha256: hashPluginBytes(adapter), license: 'AGPL-3.0-only' },
    plugin: { id: 'fixture.tool-only', version: '0.1.0', title: '工具限定fixture', description: '自有构建验收' },
    tool: { upstreamName: 'calc', inputSchema: { type: 'object', properties: {} } },
    dependencyDispositions: [],
    limitations: ['不等于原包兼容'],
  }
  return { recipe, files, adapter }
}
const compiler: DshBundleCompiler = async graph => ({ code: Buffer.from('export default { activate() {} }'), inputs: [...graph.modules.keys()], imports: [] })
describe('Given 开发侧固定DSH工具限定配方', () => {
  test('When 纯字节构建 Then 产物仍走V3白名单且记录来源/许可/适配器，默认不签名不信任', async () => {
    const value = fixture()
    const result = await buildDshToolPackage(value.recipe, value.recipe.source.archiveSha256, value.files, value.adapter, compiler)
    const inspected = inspectPluginPackage(result.bytes)
    expect(inspected.manifest.formatVersion).toBe(3)
    expect(inspected.signatureVerified).toBe(false)
    expect(inspected.files.has('runtime/main.mjs')).toBe(true)
    expect(inspected.files.has('package.json')).toBe(false)
    expect(inspected.files.has('lib/index.js')).toBe(false)
    expect(Buffer.from(inspected.files.get('THIRD_PARTY_NOTICES.md')!).toString()).toContain(value.recipe.source.archiveSha256)
    expect(Buffer.from(inspected.files.get('LICENSE')!).toString()).toContain('AGPL-3.0-only')
    expect(result.recipeHash).toMatch(/^[a-f0-9]{64}$/)
  })
  test('When 来源或适配器字节变化 Then 构建器尚未调用就拒绝', async () => {
    const value = fixture(); let calls = 0
    const counting: DshBundleCompiler = async graph => { calls++; return compiler(graph) }
    await expect(buildDshToolPackage(value.recipe, 'b'.repeat(64), value.files, value.adapter, counting)).rejects.toThrow('DSH_BUILD_SOURCE_CHANGED')
    await expect(buildDshToolPackage(value.recipe, value.recipe.source.archiveSha256, value.files, Buffer.from('changed'), counting)).rejects.toThrow('DSH_BUILD_ADAPTER_CHANGED')
    value.files.set('lib/index.js', Buffer.from('changed'))
    await expect(buildDshToolPackage(value.recipe, value.recipe.source.archiveSha256, value.files, value.adapter, counting)).rejects.toThrow('DSH_BUILD_SOURCE_CHANGED')
    expect(calls).toBe(0)
  })
  test('When 声明未知依赖映射或构建残留external Then 明确拒绝，不放开Node默认解析', async () => {
    const value = fixture()
    value.recipe.imports['lib/index.js'] = { 'node:fs': 'outside.js' }
    await expect(buildDshToolPackage(value.recipe, value.recipe.source.archiveSha256, value.files, value.adapter, compiler)).rejects.toThrow('DSH_BUILD_RECIPE_INVALID')
    value.recipe.imports['lib/index.js'] = {}
    await expect(buildDshToolPackage(value.recipe, value.recipe.source.archiveSha256, value.files, value.adapter, async graph => ({ code: Buffer.from('export {}'), inputs: [...graph.modules.keys()], imports: ['node:fs'] }))).rejects.toThrow('DSH_BUILD_NOT_SELF_CONTAINED')
  })
})
