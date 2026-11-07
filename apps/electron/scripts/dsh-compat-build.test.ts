import { describe, expect, test } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { hashPluginBytes, inspectPluginPackage } from '../../../packages/plugin-kit/src/package'
import type { DshBuildRecipe } from '../../../packages/plugin-kit/src/dsh-compat/recipe'
import type { DshBundleCompiler } from '../../../packages/plugin-kit/src/dsh-compat/build'
import { buildDshArchive } from './dsh-compat-build'

function fixture(extra: Record<string, unknown> = {}) {
  const files = new Map([
    ['package.json', JSON.stringify({ name: 'dsh-own-fixture', version: '1.0.0', license: 'MIT', ...extra })],
    ['LICENSE', '自有fixture许可文本'], ['lib/index.js', 'export function apply() {}'],
    ['lib/client.js', 'throw new Error("EXCLUDED_CLIENT_MUST_NOT_ENTER_GRAPH")'],
  ])
  const blocks: Buffer[] = []
  for (const [path, text] of files) {
    const body = Buffer.from(text); const header = Buffer.alloc(512)
    header.write(`package/${path}`, 0, 100); header.write('0000644\0', 100)
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124)
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263)
    header.write(header.reduce((total, value) => total + value, 0).toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512))
  }
  const archive = gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
  const adapter = Buffer.from('export function createDshRegistrationScope() {}')
  const recipe: DshBuildRecipe = {
    formatVersion: 1, recipeId: 'fixture-tool-only', recipeVersion: '0.1.0',
    source: { name: 'dsh-own-fixture', version: '1.0.0', archiveSha256: hashPluginBytes(archive), url: 'https://registry.npmjs.org/dsh-own-fixture/-/dsh-own-fixture-1.0.0.tgz', license: 'MIT', files: Object.fromEntries([...files].filter(([path]) => path !== 'lib/client.js').map(([path, text]) => [path, hashPluginBytes(Buffer.from(text))])) },
    entry: 'lib/index.js', imports: { 'lib/index.js': {} },
    adapter: { version: '0.1.0', sha256: hashPluginBytes(adapter), license: 'AGPL-3.0-only' },
    plugin: { id: 'fixture.tool-only', version: '0.1.0', title: '工具限定fixture', description: '自有归档验收' },
    tool: { upstreamName: 'calc', inputSchema: { type: 'object', properties: {} } }, dependencyDispositions: [], limitations: ['自有fixture'],
  }
  return { recipe, archive, adapter }
}
const compiler: DshBundleCompiler = async graph => {
  expect([...graph.modules.keys()]).not.toContain('lib/client.js')
  return { code: Buffer.from('export default { activate() {} }'), inputs: [...graph.modules.keys()], imports: [] }
}
describe('Given 开发侧真实归档到限定工具包准入', () => {
  test('When hash/逐文件/依赖均匹配 Then 只从同一内存快照构建，排除客户端且默认未签名', async () => {
    const value = fixture({ peerDependencies: { '@deepseek-ai/dsh-tools': '0.1.0-rc.6' } })
    value.recipe.dependencyDispositions = [{ group: 'peerDependencies', name: '@deepseek-ai/dsh-tools', specifier: '0.1.0-rc.6', treatment: 'limited-tool-adapter', reason: '自有fixture只使用登记合同' }]
    const result = await buildDshArchive(value.recipe, value.archive, value.adapter, compiler)
    expect(inspectPluginPackage(result.bytes).signatureVerified).toBe(false)
  })
  test('When 未处置依赖/安装脚本 Then 在调用编译器前拒绝，不把notice当验证', async () => {
    let calls = 0
    for (const [extra, expected] of [
      [{ peerDependencies: { unknown: '*' } }, 'DSH_CLOSURE_UNRESOLVED'],
      [{ optionalDependencies: { unknown: '*' } }, 'DSH_CLOSURE_UNRESOLVED'],
      [{ scripts: { postinstall: 'not-executed' } }, 'DSH_CLOSURE_UNSUPPORTED'],
    ] as const) {
      const value = fixture(extra)
      await expect(buildDshArchive(value.recipe, value.archive, value.adapter, async graph => { calls++; return compiler(graph) })).rejects.toThrow(expected)
    }
    expect(calls).toBe(0)
  })
  test('When 归档或逐文件身份变化 Then 不接受调用方自报hash或再次读路径', async () => {
    const value = fixture(); let calls = 0
    const counting: DshBundleCompiler = async graph => { calls++; return compiler(graph) }
    const changed = Buffer.from(value.archive); changed[0] = 0
    await expect(buildDshArchive(value.recipe, changed, value.adapter, counting)).rejects.toThrow('DSH_BUILD_SOURCE_CHANGED')
    value.recipe.source.files['lib/index.js'] = 'b'.repeat(64)
    await expect(buildDshArchive(value.recipe, value.archive, value.adapter, counting)).rejects.toThrow('DSH_CLOSURE_SOURCE_CHANGED')
    expect(calls).toBe(0)
  })
})
