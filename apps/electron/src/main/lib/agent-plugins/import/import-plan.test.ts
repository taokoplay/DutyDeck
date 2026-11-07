import { describe, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { createPluginPackage, createStandardPluginFiles } from '@dutydeck/plugin-kit'
import { createStaticImportPlan, type StaticImportPlanInput } from './import-plan'
const base: StaticImportPlanInput = { recipeId: 'fixture.docs', recipeVersion: '1.0.0', source: { name: 'dsh-docs', version: '1.0.0', sha256: 'a'.repeat(64), url: 'https://registry.npmjs.org/dsh-docs/-/dsh-docs-1.0.0.tgz', license: 'MIT' }, mcp: { name: 'docs', type: 'http', url: 'https://mcp.example.com/mcp' } }
describe('Given 只读固定配方导入预览', () => {
  test('When 固定来源、签名内容及HTTP连接 Then 冻结精确产物与计划哈希，不安装或握手', () => {
    const bytes = createPluginPackage(createStandardPluginFiles('convert.docs', '文档资源'), generateKeyPairSync('ed25519').privateKey)
    const plan = createStaticImportPlan({ ...base, contentBytes: bytes })
    expect(plan.content).toMatchObject({ pluginId: 'convert.docs' })
    expect(plan.content?.keyId).toMatch(/^[a-f0-9]{64}$/)
    expect(createStaticImportPlan({ ...base, contentBytes: bytes }).hash).toBe(plan.hash)
    expect(createStaticImportPlan({ ...base, mcp: { ...base.mcp!, name: 'other' }, contentBytes: bytes }).hash).not.toBe(plan.hash)
    bytes.fill(0)
    expect(plan.content?.bytes.some(value => value !== 0)).toBe(true)
  })
  test('When 未签名内容、动态执行/秘密字段、危险URL或没有步骤 Then 拒绝方案而不是静默丢字段', () => {
    expect(() => createStaticImportPlan({ ...base, contentBytes: createPluginPackage(createStandardPluginFiles('convert.docs', '文档资源')) })).toThrow('PLUGIN_IMPORT_SIGNED_CONTENT_REQUIRED')
    for (const mcp of [
      { name: 'docs', type: 'stdio', command: 'npx' },
      { ...base.mcp, headers: { Authorization: 'secret' } },
      { ...base.mcp, env: { TOKEN: 'secret' } },
      { ...base.mcp, url: 'http://127.0.0.1:3000' },
      { ...base.mcp, url: 'https://user:pass@example.com' },
      { ...base.mcp, url: 'https://mcp.example.com/?token=secret' },
      { ...base.mcp, oauth: { clientSecret: 'secret' } },
      { ...base.mcp, oauth: { authorizationEndpoint: 'https://example.com/?token=secret' } },
    ]) expect(() => createStaticImportPlan({ ...base, mcp } as StaticImportPlanInput)).toThrow('PLUGIN_IMPORT_PLAN_INVALID')
    expect(() => createStaticImportPlan({ ...base, mcp: undefined })).toThrow('PLUGIN_IMPORT_PLAN_INVALID')
  })
})
