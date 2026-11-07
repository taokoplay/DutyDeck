import { describe, expect, test } from 'bun:test'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStandardPluginFiles, inspectPluginPackage } from '@dutydeck/plugin-kit'
import { ContentPluginService } from '../content-plugin-service'
import { convertStaticContent, type StaticContentRecipe } from './skill-importer'

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
function fixture() {
  const template = createStandardPluginFiles('convert.example', '静态转换样本')
  const manifest = JSON.parse(new TextDecoder().decode(template.get('plugin.json'))) as StaticContentRecipe['manifest']
  const files = new Map<string, Uint8Array>([
    ['package.json', Buffer.from(JSON.stringify({ name: 'dsh-static-example', version: '1.0.0', license: 'MIT' }))],
    ['LICENSE', Buffer.from('MIT License\nCopyright fixture author\n自有测试许可，不代表真实上游许可。')],
    ['docs/SKILL.md', template.get('skills/assist/SKILL.md')!],
    ['prompts/workflow.md', template.get('prompts/workflow.md')!],
    ['install.js', Buffer.from('throw new Error("不能执行")')],
    ['cordis.patch.yml', Buffer.from('example: !!js () => { throw new Error("不能求值") }')],
  ])
  const blocks: Buffer[] = []
  for (const [path, value] of files) {
    const header = Buffer.alloc(512)
    header.write(`package/${path}`); header.write(value.length.toString(8).padStart(11, '0') + '\0', 124)
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257)
    header.write(header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(header, Buffer.from(value), Buffer.alloc((512 - value.length % 512) % 512))
  }
  const archive = gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
  const recipe: StaticContentRecipe = {
    formatVersion: 1, id: 'fixture.static-content', version: '1.0.0',
    source: { name: 'dsh-static-example', version: '1.0.0', url: 'https://registry.npmjs.org/dsh-static-example/-/dsh-static-example-1.0.0.tgz', sha256: sha(archive), license: 'MIT', licensePath: 'LICENSE', licenseSha256: sha(files.get('LICENSE')!) },
    manifest, resources: [
      { sourcePath: 'docs/SKILL.md', targetPath: 'skills/assist/SKILL.md', sha256: sha(files.get('docs/SKILL.md')!) },
      { sourcePath: 'prompts/workflow.md', targetPath: 'prompts/workflow.md', sha256: sha(files.get('prompts/workflow.md')!) },
    ],
    independentResourcesReviewed: true,
  }
  return { archive, recipe, files }
}

describe('Given 固定配方的纯内容转换', () => {
  test('When 来源和资源哈希匹配 Then 只转换列明资源并保留出处与许可，仍走生产签名信任入口', () => {
    const f = fixture(); const key = generateKeyPairSync('ed25519').privateKey
    const result = convertStaticContent(f.recipe, f.archive, key)
    const inspected = inspectPluginPackage(result.bytes)
    expect(inspected.signatureVerified).toBe(true)
    expect(inspected.manifest).toMatchObject({ formatVersion: 2, id: 'convert.example', permissions: [] })
    expect([...inspected.files.keys()]).not.toContain('install.js')
    expect([...inspected.files.keys()]).not.toContain('cordis.patch.yml')
    expect(inspected.files.get('skills/assist/SKILL.md')).toEqual(f.files.get('docs/SKILL.md'))
    expect(new TextDecoder().decode(inspected.files.get('THIRD_PARTY_NOTICES.md'))).toContain(f.recipe.source.sha256)
    expect(new TextDecoder().decode(inspected.files.get('LICENSE'))).toContain('Copyright fixture author')
    expect(convertStaticContent(f.recipe, f.archive, key).bytes).toEqual(result.bytes)
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'static-content-import-')))
    try {
      const service = new ContentPluginService(root)
      const preview = service.previewBytes(result.bytes)
      expect(() => service.install(preview.token)).toThrow('发布者密钥未明确受信任')
      const installed = service.install(preview.token, preview.signer!.keyId)
      expect(installed.plugins[0]?.manifest.id).toBe('convert.example')
      expect(service.resolveModule('convert.example.assistant').resources).toHaveLength(2)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('When 配方身份/许可/内容哈希不符、路径越界或未审查独立资源 Then 拒绝转换', () => {
    const f = fixture()
    for (const change of [
      { source: { ...f.recipe.source, sha256: '0'.repeat(64) } },
      { source: { ...f.recipe.source, name: 'other' } },
      { source: { ...f.recipe.source, license: 'Apache-2.0' } },
      { source: { ...f.recipe.source, licenseSha256: '0'.repeat(64) } },
      { resources: [{ ...f.recipe.resources[0]!, sha256: '0'.repeat(64) }] },
      { resources: [{ ...f.recipe.resources[0]!, targetPath: '../escape.md' }] },
      { resources: [{ ...f.recipe.resources[0]!, targetPath: 'runtime/entry.mjs' }] },
      { independentResourcesReviewed: false },
    ]) expect(() => convertStaticContent({ ...f.recipe, ...change }, f.archive)).toThrow()
  })
  test('When 没有转换方签名 Then 只生成开发候选，不能绕过生产导入门禁', () => {
    const f = fixture(); const result = convertStaticContent(f.recipe, f.archive)
    expect(result.signatureVerified).toBe(false)
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'static-content-import-')))
    try { expect(() => new ContentPluginService(root).previewBytes(result.bytes)).toThrow('生产环境只允许已签名插件') }
    finally { rmSync(root, { recursive: true, force: true }) }
  })
})
