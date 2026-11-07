import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { verifyDshToolClosure, type DshToolClosureRecipe } from './dependency-check'
const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')
function fixture() {
  const manifest = Buffer.from(JSON.stringify({ name: 'dsh-own-fixture', version: '1.0.0', license: 'MIT', peerDependencies: { '@deepseek-ai/dsh-tools': 'fixed-range' } }))
  const source = Buffer.from('export const fixture = true')
  const files = new Map([['package.json', manifest], ['LICENSE', Buffer.from('自有许可fixture')], ['lib/index.js', source]])
  const recipe: DshToolClosureRecipe = { name: 'dsh-own-fixture', version: '1.0.0', packageHash: 'a'.repeat(64), license: 'MIT', entry: 'lib/index.js', files: Object.fromEntries([...files].map(([path, bytes]) => [path, hash(bytes)])), runtimeFiles: ['lib/index.js'], dependencies: [{ group: 'peerDependencies', name: '@deepseek-ai/dsh-tools', specifier: 'fixed-range', treatment: 'limited-tool-adapter', reason: '仅自有固定fixture' }] }
  return { recipe, files }
}
describe('Given 宿主登记且源码已独立审查的固定闭包配方', () => {
  test('When 精确包/文件/许可与所有依赖处置一致 Then 返回工具限定结果而非原包兼容', () => {
    const { recipe, files } = fixture()
    const result = verifyDshToolClosure(recipe, recipe.packageHash, files)
    expect(result.scope).toBe('tool-only-conversion')
    expect(result.originalDependencyClosure).toBe('unresolved')
    expect(result.runtimeFiles).toEqual(['lib/index.js'])
  })
  test('When 字节/hash/来源或依赖不匹配 Then 阻断未知源码，不能用同名同版本放行', () => {
    const { recipe, files } = fixture()
    expect(() => verifyDshToolClosure(recipe, 'b'.repeat(64), files)).toThrow('DSH_CLOSURE_SOURCE_CHANGED')
    files.set('lib/index.js', Buffer.from('changed'))
    expect(() => verifyDshToolClosure(recipe, recipe.packageHash, files)).toThrow('DSH_CLOSURE_SOURCE_CHANGED')
    const other = fixture()
    expect(() => verifyDshToolClosure({ ...other.recipe, dependencies: [] }, other.recipe.packageHash, other.files)).toThrow('DSH_CLOSURE_UNRESOLVED')
    expect(() => verifyDshToolClosure({ ...other.recipe, runtimeFiles: ['lib/unknown.js'] }, other.recipe.packageHash, other.files)).toThrow('DSH_CLOSURE_RECIPE_INVALID')
  })
  test('When 依赖字段显式为null Then 不冒充未声明而接受', () => {
    const { recipe, files } = fixture()
    const manifest = Buffer.from(JSON.stringify({ name: recipe.name, version: recipe.version, license: recipe.license, peerDependencies: null }))
    files.set('package.json', manifest); recipe.files['package.json'] = hash(manifest); recipe.dependencies = []
    expect(() => verifyDshToolClosure(recipe, recipe.packageHash, files)).toThrow('DSH_CLOSURE_UNRESOLVED')
  })
  test('When 安装脚本、native或bundled存在 Then 即使metadata hash固定也不可进入转换', () => {
    for (const extra of [{ scripts: { install: 'never-run' } }, { bundledDependencies: ['hidden'] }, { bundleDependencies: true }]) {
      const { recipe, files } = fixture(); const original = JSON.parse(files.get('package.json')!.toString()); const manifest = Buffer.from(JSON.stringify({ ...original, ...extra })); files.set('package.json', manifest); recipe.files['package.json'] = hash(manifest)
      expect(() => verifyDshToolClosure(recipe, recipe.packageHash, files)).toThrow('DSH_CLOSURE_UNSUPPORTED')
    }
    const { recipe, files } = fixture(); files.set('binding.gyp', Buffer.from('native'))
    expect(() => verifyDshToolClosure(recipe, recipe.packageHash, files)).toThrow('DSH_CLOSURE_UNSUPPORTED')
  })
})
