import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { analyzeNpmPackage, readNpmTarball } from './npm-package-analysis'

/** 自有最小USTAR样本，不运行npm/tar或第三方代码。 */
function archive(files: Array<{ path: string; value: string; type?: string }>): Buffer {
  const blocks: Buffer[] = []
  for (const file of files) {
    const body = Buffer.from(file.value)
    const header = Buffer.alloc(512)
    header.write(file.path, 0, 100)
    header.write('0000644\0', 100)
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124)
    header.fill(32, 148, 156)
    header.write(file.type ?? '0', 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    header.write(header.reduce((total, value) => total + value, 0).toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}
const pkg = (extra: Record<string, unknown> = {}) => JSON.stringify({ name: 'dsh-example', version: '1.2.3', license: 'MIT', ...extra })
const normal = () => archive([{ path: 'package/package.json', value: pkg({ dependencies: { cordis: '^4.0.0' } }) }, { path: 'package/cordis.patch.yml', value: 'example:\n  value: !!js () => fetch("https://example.com")' }, { path: 'package/LICENSE', value: 'fixture license' }])

describe('Given 精确npm版本的只读静态分析', () => {
  test('When 获取固定元数据和完整性匹配的包 Then 记录实际哈希/许可/依赖及动态阻断，不执行', async () => {
    const bytes = normal(); const calls: string[] = []
    const report = await analyzeNpmPackage('dsh-example', '1.2.3', async (url, kind) => {
      calls.push(url)
      return kind === 'json' ? Buffer.from(JSON.stringify({ name: 'dsh-example', version: '1.2.3', dist: { tarball: 'https://registry.npmjs.org/dsh-example/-/dsh-example-1.2.3.tgz', integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } })) : bytes
    })
    expect(calls).toEqual(['https://registry.npmjs.org/dsh-example/1.2.3', 'https://registry.npmjs.org/dsh-example/-/dsh-example-1.2.3.tgz'])
    expect(report).toMatchObject({ packageHash: createHash('sha256').update(bytes).digest('hex'), license: 'MIT', integrity: { status: 'matched', algorithm: 'sha512' }, dependencies: { cordis: '^4.0.0' }, dependencyClosure: 'unresolved', status: 'unsupported' })
    expect(report.blockers).toContain('DYNAMIC_PATCH')
    expect(report.blockers).toContain('DEPENDENCY_CLOSURE_UNRESOLVED')
    expect(report.licenseFiles).toContain('LICENSE')
  })
  test('When 元数据身份/哈希不符或tarball不在公开npm源 Then 拒绝且不拉取任意URL', async () => {
    for (const patch of [
      { name: 'other' }, { version: '9.0.0' },
      { dist: { tarball: 'https://127.0.0.1/private', integrity: 'sha512-AAAA' } },
    ]) {
      let calls = 0
      await expect(analyzeNpmPackage('dsh-example', '1.2.3', async () => { calls++; return Buffer.from(JSON.stringify({ name: 'dsh-example', version: '1.2.3', ...patch })) })).rejects.toThrow()
      expect(calls).toBe(1)
    }
    await expect(analyzeNpmPackage('dsh-example', '1.2.3', async (_url, kind) => kind === 'json'
      ? Buffer.from(JSON.stringify({ name: 'dsh-example', version: '1.2.3', dist: { tarball: 'https://registry.npmjs.org/dsh-example/-/x.tgz', integrity: `sha512-${Buffer.alloc(64).toString('base64')}` } }))
      : normal())).rejects.toThrow('PLUGIN_PACKAGE_INTEGRITY_MISMATCH')
  })
  test('When 缺失完整性/许可或存在安装脚本 Then 保留未知与阻断而不提升为verified', async () => {
    const bytes = archive([{ path: 'package/package.json', value: JSON.stringify({ name: 'dsh-example', version: '1.2.3', scripts: { postinstall: 'node install.js' } }) }])
    const report = await analyzeNpmPackage('dsh-example', '1.2.3', async (_url, kind) => kind === 'json'
      ? Buffer.from(JSON.stringify({ name: 'dsh-example', version: '1.2.3', dist: { tarball: 'https://registry.npmjs.org/dsh-example/-/x.tgz' } })) : bytes)
    expect(report).toMatchObject({ license: null, integrity: { status: 'missing' }, status: 'unsupported' })
    expect(report.blockers).toContain('INSTALL_SCRIPTS')
    expect(report.blockers).toContain('LICENSE_UNKNOWN')
    expect(report.blockers).toContain('INTEGRITY_MISSING')
  })
  test('When 纯资源无依赖 Then 仍需固定配方而不是自动认定可转换', async () => {
    const bytes = archive([{ path: 'package/package.json', value: pkg() }, { path: 'package/SKILL.md', value: '自有内容' }])
    const report = await analyzeNpmPackage('dsh-example', '1.2.3', async (_url, kind) => kind === 'json'
      ? Buffer.from(JSON.stringify({ name: 'dsh-example', version: '1.2.3', dist: { tarball: 'https://registry.npmjs.org/dsh-example/-/x.tgz', integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } })) : bytes)
    expect(report).toMatchObject({ dependencyClosure: 'none', status: 'unassessed', contentCandidates: ['SKILL.md'] })
    expect(report.reasons.join(' ')).toContain('配方')
  })
  test('When bundled依赖两种别名为空、非空或畸形 Then 按声明语义诊断而不是按数组真值阻断', async () => {
    for (const key of ['bundledDependencies', 'bundleDependencies']) {
      const analyze = async (value: unknown) => {
        const bytes = archive([{ path: 'package/package.json', value: pkg({ [key]: value }) }])
        return analyzeNpmPackage('dsh-example', '1.2.3', async (_url, kind) => kind === 'tarball' ? bytes : Buffer.from(JSON.stringify({ name: 'dsh-example', version: '1.2.3', dist: { tarball: 'https://registry.npmjs.org/dsh-example/-/x.tgz', integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } })))
      }
      for (const value of [[], false]) expect(await analyze(value)).toMatchObject({ dependencyClosure: 'none', status: 'unassessed', blockers: [] })
      for (const value of [['dep'], true]) {
        const report = await analyze(value)
        expect(report.dependencyClosure).toBe('unresolved')
        expect(report.blockers).toContain('DEPENDENCY_CLOSURE_UNRESOLVED')
      }
      for (const value of ['', {}, [123], ['bad/name']]) await expect(analyze(value)).rejects.toThrow('PLUGIN_PACKAGE_METADATA_INVALID')
    }
  })
  test('When tar路径穿越、链接、重复项或扩展记录 Then 在内存解析时拒绝', () => {
    for (const path of ['package/../escape', '/etc/passwd', 'package/a\\b', 'package//x', 'other/package.json']) {
      expect(() => readNpmTarball(archive([{ path, value: 'x' }]))).toThrow()
    }
    for (const type of ['1', '2', '3', '6', 'x', 'g', 'L']) expect(() => readNpmTarball(archive([{ path: 'package/a', value: '', type }]))).toThrow()
    expect(() => readNpmTarball(archive([{ path: 'package/a', value: '1' }, { path: 'package/a', value: '2' }]))).toThrow()
  })
  test('When SHA1回退、篡改包内身份、损坏UTF8或不同依赖范围 Then 精确验证且不静默合并原始声明', async () => {
    const load = async (bytes: Buffer) => analyzeNpmPackage('dsh-example', '1.2.3', async (_url, kind) => kind === 'tarball' ? bytes : Buffer.from(JSON.stringify({ name: 'dsh-example', version: '1.2.3', dist: { tarball: 'https://registry.npmjs.org/dsh-example/-/x.tgz', shasum: createHash('sha1').update(bytes).digest('hex') } })))
    const report = await load(archive([{ path: 'package/package.json', value: pkg({ dependencies: { cordis: '^3' }, peerDependencies: { cordis: '^4' }, optionalDependencies: { optional: '1.0.0' }, devDependencies: { typescript: '^5' } }) }]))
    expect(report.integrity.algorithm).toBe('sha1')
    expect(report.dependencyDeclarations).toMatchObject({ dependencies: { cordis: '^3' }, peerDependencies: { cordis: '^4' }, optionalDependencies: { optional: '1.0.0' }, devDependencies: { typescript: '^5' } })
    await expect(load(archive([{ path: 'package/package.json', value: pkg({ version: '9.0.0' }) }]))).rejects.toThrow('PLUGIN_PACKAGE_IDENTITY_MISMATCH')
    const tar = gunzipSync(archive([{ path: 'package/package.json', value: pkg() }]))
    tar[512] = 0xff
    await expect(load(gzipSync(tar))).rejects.toThrow('PLUGIN_PACKAGE_METADATA_INVALID')
  })
  test('When 有效tar被修改校验和、截断结束块、添加尾随正文或超出文件数 Then 不接受部分归档', () => {
    const tar = gunzipSync(normal())
    const corrupt = Buffer.from(tar); corrupt[0] = 120
    expect(() => readNpmTarball(gzipSync(corrupt))).toThrow()
    expect(() => readNpmTarball(gzipSync(tar.subarray(0, tar.length - 512)))).toThrow()
    expect(() => readNpmTarball(gzipSync(Buffer.concat([tar, Buffer.alloc(512, 1)])))).toThrow()
    expect(() => readNpmTarball(archive(Array.from({ length: 2001 }, (_, i) => ({ path: `package/file-${i}`, value: '' }))))).toThrow('PLUGIN_PACKAGE_TOO_MANY_FILES')
  })
  test('When 解压炸弹、超大单文件、校验和错误或缺结束块 Then 有界拒绝', () => {
    expect(() => readNpmTarball(gzipSync(Buffer.alloc(33 * 1024 * 1024)))).toThrow()
    expect(() => readNpmTarball(archive([{ path: 'package/large', value: 'x'.repeat(5 * 1024 * 1024) }]))).toThrow()
    expect(() => readNpmTarball(gzipSync(Buffer.alloc(512, 65)))).toThrow()
  })
})
