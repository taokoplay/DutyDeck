import { describe, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { createPluginPackage, inspectPluginPackage } from './package'
import { createModuleRuntimePluginFiles, createStandardPluginFiles } from './scaffold'
import { createPluginArchive, readPluginArchive } from './archive'

describe('标准脚手架与可交付插件包', () => {
  test('Given 标准脚手架 When 生成与打包 Then 包含自己的模块和真实资源', () => {
    /** 包含中文名称的普通作者插件。 */
    const files = createStandardPluginFiles('acme.demo', '需求助手')
    const packed = createPluginPackage(files)
    const inspected = inspectPluginPackage(packed)
    expect(inspected.manifest.id).toBe('acme.demo')
    expect(inspected.manifest.displayName).toBe('需求助手')
    expect(inspected.signatureVerified).toBe(false)
    expect(inspected.resources.resources.some(resource => resource.kind === 'skill' && resource.content.includes('适用任务'))).toBe(true)
    expect(inspected.files.has('package.json')).toBe(false)
    expect(createPluginPackage(files)).toEqual(packed)
  })

  test('Given 作者密钥 When 签名打包 Then 校验签名并返回指纹而不自证信任', () => {
    /** 测试密钥仅驻留进程，不进入用户密钥目录。 */
    const { privateKey } = generateKeyPairSync('ed25519')
    const inspection = inspectPluginPackage(createPluginPackage(createStandardPluginFiles('acme.demo', '助手'), privateKey))
    expect(inspection.signatureVerified).toBe(true)
    expect(inspection.signer?.keyId).toMatch(/^[a-f0-9]{64}$/)
    expect(inspection.resources.trust).toBe('unverified')
  })

  test('Given ZIP可读但载荷或完整性被改 When 校验 Then 不接受旧签名或额外文件', () => {
    const { privateKey } = generateKeyPairSync('ed25519')
    const files = readPluginArchive(createPluginPackage(createStandardPluginFiles('acme.demo', '助手'), privateKey))
    files.set('prompts/workflow.md', new TextEncoder().encode('tampered'))
    expect(() => inspectPluginPackage(createPluginArchive(files))).toThrow()
    const extraFiles = readPluginArchive(createPluginPackage(createStandardPluginFiles('acme.demo', '助手'), privateKey))
    extraFiles.set('assets/extra.txt', new TextEncoder().encode('extra'))
    expect(() => inspectPluginPackage(createPluginArchive(extraFiles))).toThrow('PLUGIN_UNLISTED_FILE')
  })

  test('Given 不支持的运行代码或缺资源 When 打包 Then 给出定位错误', () => {
    const files = createStandardPluginFiles('acme.demo', '助手')
    files.delete('skills/assist/SKILL.md')
    expect(() => createPluginPackage(files)).toThrow()
  })

  test('Given V3 runtime 工程 When 打包 Then 收录 runtime 与 Surface 且排除源工程', () => {
    const files = createModuleRuntimePluginFiles('acme.echo', '回显')
    files.set('runtime/main.mjs', new TextEncoder().encode('export {}'))
    files.set('surfaces/workspace/index.html', new TextEncoder().encode('<!doctype html><html></html>'))
    files.set('surfaces/workspace/main.js', new TextEncoder().encode('console.log("surface")'))
    files.set('src/runtime.ts', new TextEncoder().encode('export default {}'))
    const inspected = inspectPluginPackage(createPluginPackage(files))
    expect(inspected.manifest.formatVersion).toBe(3)
    expect(inspected.files.has('runtime/main.mjs')).toBe(true)
    expect(inspected.files.has('surfaces/workspace/index.html')).toBe(true)
    expect(inspected.files.has('surfaces/workspace/main.js')).toBe(true)
    expect(inspected.files.has('src/runtime.ts')).toBe(false)
  })

  test('Given V3 缺 runtime 入口 When 打包 Then 在写入包前拒绝', () => {
    const files = createModuleRuntimePluginFiles('acme.echo', '回显')
    files.set('surfaces/workspace/index.html', new TextEncoder().encode('<!doctype html><html></html>'))
    expect(() => createPluginPackage(files)).toThrow('PLUGIN_RUNTIME_ENTRY_MISSING')
  })

  test('Given V3 作者元数据版本不一致 When 打包 Then 拒绝发布固定版本之外的包', () => {
    const files = createModuleRuntimePluginFiles('acme.echo', '回显')
    files.set('runtime/main.mjs', new TextEncoder().encode('export default { activate() {} }'))
    files.set('surfaces/workspace/index.html', new TextEncoder().encode('<!doctype html><html></html>'))
    const packageJson = JSON.parse(new TextDecoder().decode(files.get('package.json'))) as Record<string, unknown>
    packageJson.version = '1.0.1'
    files.set('package.json', new TextEncoder().encode(`${JSON.stringify(packageJson)}\n`))
    expect(() => createPluginPackage(files)).toThrow('PLUGIN_AUTHOR_VERSION_MISMATCH')
  })

  test('Given V3 Surface 模板 When 创建工程 Then 默认消费宿主主题令牌', () => {
    const files = createModuleRuntimePluginFiles('acme.echo', '回显')
    const main = new TextDecoder().decode(files.get('src/surfaces/workspace/main.ts'))
    const html = new TextDecoder().decode(files.get('src/surfaces/workspace/index.html'))
    const style = new TextDecoder().decode(files.get('src/surfaces/workspace/style.css'))
    expect(main).toContain('applyPluginSurfaceTheme')
    expect(main).toContain('isPluginSurfaceThemeMessage')
    expect(main).toContain('installPluginSurfaceComponentStyles')
    expect(main).toContain('event.source === window.parent')
    expect(main).toContain('PLUGIN_SURFACE_READY_MESSAGE')
    expect(html).toContain('class="dd-dialog"')
    expect(html).toContain('class="dd-input"')
    expect(html).toContain('data-variant="primary"')
    expect(style).toContain('--dutydeck-background')
    expect(style).toContain('--dutydeck-card')
    expect(style).toContain('--dutydeck-radius-xl')
    expect(style).toContain('--dutydeck-shadow-sm')
    expect(style).not.toContain('prefers-color-scheme')
  })

  test('Given V3 Changelog 缺少当前固定版本 When 打包 Then 拒绝无发布记录的版本', () => {
    const files = createModuleRuntimePluginFiles('acme.echo', '回显')
    files.set('runtime/main.mjs', new TextEncoder().encode('export default { activate() {} }'))
    files.set('surfaces/workspace/index.html', new TextEncoder().encode('<!doctype html><html></html>'))
    files.set('CHANGELOG.md', new TextEncoder().encode('# 版本记录\n\n## 0.9.0\n\n旧版本。\n'))
    expect(() => createPluginPackage(files)).toThrow('PLUGIN_CHANGELOG_VERSION_MISSING')
  })
})
