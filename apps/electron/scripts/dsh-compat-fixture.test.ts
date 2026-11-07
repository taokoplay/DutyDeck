import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildDshToolPackage } from '../../../packages/plugin-kit/src/dsh-compat/build'
import type { DshBuildRecipe } from '../../../packages/plugin-kit/src/dsh-compat/recipe'
import { hashPluginBytes, inspectPluginPackage } from '../../../packages/plugin-kit/src/package'
import { compileDshGraph } from './dsh-compat-compiler'

const temporaryRoots: string[] = []
afterAll(() => { for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true }) })
interface FixtureCall { signal: AbortSignal; deadline: number }
interface FixtureHost { plugin: { id: string }; tools: { handle(id: string, handler: (input: unknown, call: FixtureCall) => Promise<unknown>): void } }
interface FixtureRuntime { activate(host: FixtureHost): Promise<void>; deactivate(): void }
const definition = `{ name: 'calc', description: '自有fixture', parameters: {}, output: { schema: { type: 'number' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }, execute: async () => 1 }`
async function createFixture(body: string) {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/main/lib/agent-plugins/dsh-compat/supported-contract.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false, metafile: true, logLevel: 'silent' })
  expect(Object.values(bundle.metafile.outputs).flatMap(output => output.imports)).toEqual([])
  const adapter = bundle.outputFiles[0]!.contents
  const files = new Map<string, Uint8Array>([
    ['package.json', Buffer.from('{"name":"dsh-own-fixture","version":"1.0.0","license":"MIT"}')],
    ['LICENSE', Buffer.from('自有fixture许可文本')],
    ['lib/index.js', Buffer.from(`import { defineTool } from '@deepseek-ai/dsh-tools'; export const inject = ['tools']; export async function apply(ctx) { ${body} }`)],
  ])
  const recipe: DshBuildRecipe = {
    formatVersion: 1, recipeId: 'fixture-tool-only', recipeVersion: '0.1.0',
    source: { name: 'dsh-own-fixture', version: '1.0.0', archiveSha256: 'a'.repeat(64), url: 'https://registry.npmjs.org/dsh-own-fixture/-/dsh-own-fixture-1.0.0.tgz', license: 'MIT', files: Object.fromEntries([...files].map(([key, bytes]) => [key, hashPluginBytes(bytes)])) },
    entry: 'lib/index.js', imports: { 'lib/index.js': { '@deepseek-ai/dsh-tools': '@dsh/define-tool' } },
    adapter: { version: '0.1.0', sha256: hashPluginBytes(adapter), license: 'AGPL-3.0-only' },
    plugin: { id: 'fixture.tool-only', version: '0.1.0', title: '工具限定fixture', description: '自有构建验收' },
    tool: { upstreamName: 'calc', inputSchema: { type: 'object', properties: {} } }, dependencyDispositions: [], limitations: ['自有fixture'],
  }
  const result = await buildDshToolPackage(recipe, recipe.source.archiveSha256, files, adapter, compileDshGraph)
  const inspected = inspectPluginPackage(result.bytes)
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-dsh-own-fixture-')); temporaryRoots.push(root)
  const entry = join(root, 'main.mjs'); writeFileSync(entry, inspected.files.get('runtime/main.mjs')!)
  const runtime = await import(pathToFileURL(entry).href) as { default: FixtureRuntime }
  const handlers = new Map<string, (input: unknown, call: FixtureCall) => Promise<unknown>>()
  const host: FixtureHost = { plugin: { id: recipe.plugin.id }, tools: { handle(id, handler) { handlers.set(id, handler) } } }
  return { runtime: runtime.default, host, handlers }
}
describe('Given 自有fixture通过真实内存构建与V3包装器', () => {
  test('When 激活/调用/停用/再激活 Then 注册受限工具，旧handler失效，新实例不重复', async () => {
    const fixture = await createFixture(`ctx.tools.register(defineTool(${definition}));`)
    await fixture.runtime.activate(fixture.host)
    expect([...fixture.handlers.keys()]).toEqual(['calc'])
    const handler = fixture.handlers.get('calc')!
    const call = { signal: new AbortController().signal, deadline: Date.now() + 1000 }
    expect(await handler({}, call)).toEqual({ canonical: 1, content: [{ type: 'text', text: '1' }] })
    fixture.runtime.deactivate()
    await expect(handler({}, call)).rejects.toThrow('DSH_TOOL_DISPOSED')
    await fixture.runtime.activate(fixture.host)
    expect(fixture.handlers.size).toBe(1)
    expect(await fixture.handlers.get('calc')!({}, call)).toEqual({ canonical: 1, content: [{ type: 'text', text: '1' }] })
    fixture.runtime.deactivate()
  })
  test('When apply抛错/工具名或schema不符 Then 不留下宿主handler，失败后可再次激活验证', async () => {
    for (const body of [
      `ctx.tools.register(defineTool(${definition})); throw new Error('OWN_SECRET');`,
      `ctx.tools.register(defineTool(${definition.replace("name: 'calc'", "name: 'other'")}));`,
      `ctx.tools.register(defineTool(${definition.replace('parameters: {}', "parameters: { unexpected: { type: 'string' } }")}));`,
    ]) {
      const fixture = await createFixture(body)
      await expect(fixture.runtime.activate(fixture.host)).rejects.toThrow('DSH_ACTIVATION_FAILED')
      expect(fixture.handlers.size).toBe(0)
      await expect(fixture.runtime.activate(fixture.host)).rejects.toThrow('DSH_ACTIVATION_FAILED')
      fixture.runtime.deactivate()
    }
  })
  test('When apply等待期间deactivate Then 迟到激活拒绝且不污染新scope', async () => {
    const fixture = await createFixture(`ctx.tools.register(defineTool(${definition})); await new Promise(resolve => setTimeout(resolve, 10));`)
    const pending = fixture.runtime.activate(fixture.host)
    fixture.runtime.deactivate()
    await expect(pending).rejects.toThrow('DSH_ACTIVATION_FAILED')
    expect(fixture.handlers.size).toBe(0)
    await fixture.runtime.activate(fixture.host)
    expect(fixture.handlers.size).toBe(1)
    fixture.runtime.deactivate()
  })
  test('When 多次登记即使先释放 Then 激活失败且不对宿主留下工具', async () => {
    const fixture = await createFixture(`const release = ctx.tools.register(defineTool(${definition})); release(); ctx.tools.register(defineTool(${definition}));`)
    await expect(fixture.runtime.activate(fixture.host)).rejects.toThrow('DSH_ACTIVATION_FAILED')
    expect(fixture.handlers.size).toBe(0)
  })
})
