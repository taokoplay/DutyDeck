import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as safeFile from '../../safe-file'
import * as validationCatalog from '../plugin-validation-catalog'
import * as packageAnalysis from './npm-package-analysis'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PluginCatalogService } from './catalog-service'
const roots: string[] = []
function root(): string { const value = mkdtempSync(join(tmpdir(), 'catalog-test-')); roots.push(value); return value }
const bytes = () => Buffer.from(JSON.stringify({ format: 1, plugins: [1, 2, 3].map(n => ({ name: `demo-${n}`, title: `插件${n}`, versions: [{ version: '1.0.0', source: { type: 'npm' } }] })) }))
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('Given 按来源隔离的只读目录缓存', () => {
  test('When 未主动刷新只读list Then 不联网；刷新后重建服务可搜索分页', async () => {
    const path = root(); let calls = 0
    const service = new PluginCatalogService({ root: path, download: async () => { calls++; return bytes() } })
    expect(service.list()).toMatchObject({ total: 0, fetchedAt: null, error: null })
    expect(calls).toBe(0)
    const result = await service.refresh()
    expect(result.total).toBe(3)
    const reload = new PluginCatalogService({ root: path, download: async () => { throw new Error('不可联网') } })
    expect(reload.list({ limit: 1 })).toMatchObject({ total: 3, nextOffset: 1 })
    expect(reload.list({ query: '插件2' }).entries[0]?.name).toBe('demo-2')
    expect(reload.list({ offset: 2, limit: 1 }).nextOffset).toBeNull()
    expect(calls).toBe(1)
    expect(() => reload.list({ limit: 1000 })).toThrow('PLUGIN_CATALOG_QUERY_INVALID')
    expect(() => reload.list({ offset: -1 })).toThrow('PLUGIN_CATALOG_QUERY_INVALID')
  })
  test('When 刷新断网/畸形 Then 保留旧哈希与列表并显示稳定错误，不泄漏服务端正文', async () => {
    let fail = false
    const service = new PluginCatalogService({ root: root(), download: async () => { if (fail) throw new Error('带秘密的远端错误'); return bytes() } })
    const first = await service.refresh(); fail = true
    const failed = await service.refresh()
    expect(failed).toMatchObject({ total: 3, snapshotHash: first.snapshotHash, stale: true, error: 'PLUGIN_CATALOG_REFRESH_FAILED' })
    expect(service.list().error).toBe('PLUGIN_CATALOG_REFRESH_FAILED')
  })
  test('When 目录包含UTF-8 BOM Then 原始字节哈希与重启缓存一致', async () => {
    const path = root()
    const service = new PluginCatalogService({ root: path, download: async () => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes()]) })
    const first = await service.refresh()
    expect(first.error).toBeNull()
    const reload = new PluginCatalogService({ root: path })
    expect(reload.list()).toMatchObject({ total: 3, error: null, snapshotHash: first.snapshotHash })
  })
  test('When 新目录格式畸形 Then 不覆盖最后成功的持久缓存', async () => {
    const path = root(); let invalid = false
    const service = new PluginCatalogService({ root: path, download: async () => invalid ? Buffer.from('{"format":2,"plugins":[]}') : bytes() })
    const first = await service.refresh(); invalid = true
    expect(await service.refresh()).toMatchObject({ total: 3, snapshotHash: first.snapshotHash, error: 'PLUGIN_CATALOG_INVALID' })
    expect(new PluginCatalogService({ root: path }).list()).toMatchObject({ total: 3, snapshotHash: first.snapshotHash })
  })
  test('When 不同源同名包 Then 单独保存不会覆盖；旧快照详情拒绝', async () => {
    const service = new PluginCatalogService({ root: root(), download: async url => url.includes('other') ? Buffer.from(bytes().toString().replaceAll('1.0.0', '2.0.0')) : bytes() })
    const first = await service.refresh()
    const other = await service.refresh('https://other.example/index.json')
    expect(service.list().entries[0]?.versions[0]?.version).toBe('1.0.0')
    expect(other.entries[0]?.versions[0]?.version).toBe('2.0.0')
    const detail = service.detail({ name: 'demo-1', snapshotHash: first.snapshotHash! })
    expect(detail).toMatchObject({ status: 'unassessed', packageHash: null, license: null, dependencies: null })
    expect(() => service.detail({ name: 'demo-1', snapshotHash: other.snapshotHash! })).toThrow('PLUGIN_CATALOG_SNAPSHOT_CHANGED')
  })
  test('When rename提交后durability失败 Then 显示已提交快照与明确警告且重启内容一致', async () => {
    const path = root(); let version = '1.0.0'
    const service = new PluginCatalogService({ root: path, download: async () => Buffer.from(bytes().toString().replaceAll('1.0.0', version)) })
    const before = await service.refresh()
    const write = safeFile.writeJsonFileAtomicSecure
    const mock = spyOn(safeFile, 'writeJsonFileAtomicSecure').mockImplementation((file, data, options) => write(file, data, {
      ...options, syncDirectory: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) },
    }))
    try {
      version = '2.0.0'
      const after = await service.refresh()
      expect(after.entries[0]?.versions[0]?.version).toBe('2.0.0')
      expect(after.snapshotHash).not.toBe(before.snapshotHash)
      expect(after.error).toBe('PLUGIN_CATALOG_COMMITTED_DURABILITY_UNCERTAIN')
      expect(new PluginCatalogService({ root: path }).list().snapshotHash).toBe(after.snapshotHash)
    } finally { mock.mockRestore() }
  })
  test('When 分析不存在版本、非npm来源或旧目录身份 Then 下载前拒绝', async () => {
    let calls = 0
    const service = new PluginCatalogService({ root: root(), download: async () => bytes(), downloadPackage: async () => { calls++; throw new Error('network') } })
    const page = await service.refresh()
    await expect(service.analyze({ name: 'demo-1', version: '9.0.0', snapshotHash: page.snapshotHash! })).rejects.toThrow('PLUGIN_PACKAGE_SOURCE_UNSUPPORTED')
    await expect(service.analyze({ name: 'demo-1', version: '1.0.0', snapshotHash: '0'.repeat(64) })).rejects.toThrow('PLUGIN_CATALOG_SNAPSHOT_CHANGED')
    expect(calls).toBe(0)
    await expect(service.analyze({ name: 'demo-1', version: '1.0.0', snapshotHash: page.snapshotHash! })).rejects.toThrow('PLUGIN_PACKAGE_ANALYSIS_FAILED')
    expect(calls).toBe(1)
  })
  test('When 相同分析连点或不同包并发 Then 合并相同请求并限制并发', async () => {
    let release: () => void = () => undefined; let calls = 0
    const service = new PluginCatalogService({ root: root(), download: async () => bytes(), downloadPackage: async () => { calls++; await new Promise<void>(resolve => { release = resolve }); throw new Error('network') } })
    const page = await service.refresh()
    const query = { name: 'demo-1', version: '1.0.0', snapshotHash: page.snapshotHash! }
    const first = service.analyze(query); const second = service.analyze(query)
    expect(first).toBe(second)
    await expect(service.analyze({ ...query, name: 'demo-2' })).rejects.toThrow('PLUGIN_PACKAGE_ANALYSIS_BUSY')
    expect(calls).toBe(1)
    release(); await expect(first).rejects.toThrow('PLUGIN_PACKAGE_ANALYSIS_FAILED')
  })
  test('When 等待宿主材料检查时目录刷新 Then 不返回旧目录分析结果', async () => {
    let version = '1.0.0'; let release: () => void = () => undefined; let entered: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const check = spyOn(validationCatalog, 'readPluginValidationEnvironment').mockImplementation(async () => { entered(); await gate; return validationCatalog.getPluginValidationEnvironment() })
    const analyze = spyOn(packageAnalysis, 'analyzeNpmPackage').mockResolvedValue({
      name: 'demo-1', version: '1.0.0', registryUrl: 'https://registry.npmjs.org/demo-1/1.0.0', tarballUrl: 'https://registry.npmjs.org/demo-1/-/demo-1-1.0.0.tgz',
      analyzedAt: new Date().toISOString(), packageHash: 'a'.repeat(64), integrity: { status: 'missing', algorithm: null, source: null }, license: 'MIT', licenseFiles: [],
      dependencies: {}, dependencyDeclarations: {}, dependencyClosure: 'none', fileCount: 1, unpackedBytes: 10, contentCandidates: [], blockers: [], status: 'unassessed', reasons: [],
    })
    try {
      const service = new PluginCatalogService({ root: root(), download: async () => Buffer.from(bytes().toString().replaceAll('1.0.0', version)) })
      const page = await service.refresh()
      const pending = service.analyze({ name: 'demo-1', version: '1.0.0', snapshotHash: page.snapshotHash! })
      await started; version = '2.0.0'; await service.refresh(); release()
      await expect(pending).rejects.toThrow('PLUGIN_CATALOG_SNAPSHOT_CHANGED')
    } finally { release(); check.mockRestore(); analyze.mockRestore() }
  })
  test('When 连点刷新 Then 共用同一下载而不是并发请求', async () => {
    let release: (bytes: Buffer) => void = () => undefined; let calls = 0
    const service = new PluginCatalogService({ root: root(), download: async () => { calls++; return new Promise(resolve => { release = resolve }) } })
    const first = service.refresh(); const second = service.refresh(); release(bytes())
    expect((await first).snapshotHash).toBe((await second).snapshotHash)
    expect(calls).toBe(1)
  })
})
