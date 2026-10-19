import { afterEach, describe, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPluginPackage, createStandardPluginFiles, inspectPluginPackage } from '@dutydeck/plugin-kit'
import { ContentPluginService } from './content-plugin-service'
import { projectContentPluginModules } from './content-module-runtime'
import { resolveActiveModuleContext } from '../agent-modules/module-skill-resolver'
import { normalizeAgentSessionModulePolicy } from '@dutydeck/shared'
import { ContentPluginManager } from './content-plugin-manager'
import { AgentPluginRegistry } from '../agent-modules/plugin-registry'
import { AgentPluginManagementService } from '../agent-modules/plugin-management-service'
import { listBuiltinAgentModules } from '../agent-modules/module-registry'
import { writeJsonFileAtomic } from '../safe-file'
import { setAgentModuleRuntimeCatalog, setPackageModuleResolver } from '../agent-modules/module-skill-resolver'

/** 测试仅写隔离目录，结束后回收所有夹具。 */
const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); setPackageModuleResolver(undefined); setAgentModuleRuntimeCatalog(null) })
/** 使用真实发布者签名安装标准脚手架，确保测试贯穿资源和包合同。 */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dd-plugin-runtime-')))
  roots.push(root)
  const key = generateKeyPairSync('ed25519').privateKey
  const bytes = createPluginPackage(createStandardPluginFiles('acme.notes', '笔记助手'), key)
  const source = join(root, 'notes.ddplugin')
  writeFileSync(source, bytes)
  const service = new ContentPluginService(join(root, 'host'))
  const registry = new AgentPluginRegistry()
  registry.registerBuiltinModules(listBuiltinAgentModules())
  const manager = new ContentPluginManager(service, registry)
  manager.initialize()
  const preview = manager.preview(source)
  manager.install(preview.token, inspectPluginPackage(bytes).signer!.keyId)
  const input = { sessionId: 'session', policy: normalizeAgentSessionModulePolicy({}), explicitModuleIds: ['acme.notes.assistant'] }
  const dependencies = { listModules: () => projectContentPluginModules(service.snapshot()), resolvePackageModules: (ids: readonly string[]) => service.resolveModules(ids), getSkills: () => { throw new Error('包资源不能扫描工作区 Skills') } }
  return { service, input, dependencies, manager, registry, root, key }
}

describe('内容插件到 Agent 的显式接入', () => {
  test('Given 真正安装的签名包 When 选择模块 Then 读取自己的 Skill/提示并保留来源，不生成工作区 mention', () => {
    const { input, dependencies } = fixture()
    const result = resolveActiveModuleContext(input, dependencies)
    expect(result.unavailable).toEqual([])
    expect(result.skillMentions).toEqual([])
    expect(result.allowedToolNames).toEqual([])
    expect(result.promptFragments.join('\n')).toContain('适用任务')
    expect(result.modules[0]).toMatchObject({ pluginId: 'acme.notes', moduleVersion: '1.0.0', packageResources: [{ kind: 'skill' }, { kind: 'prompt' }] })
    expect(result.modules[0]?.packageHash).toHaveLength(64)
  })
  test('Given 包已安装 When 未选择或 Skills 受限 Then 不读取任何包正文', () => {
    const { input, dependencies } = fixture()
    const guarded = { ...dependencies, resolvePackageModules: () => { throw new Error('禁止读包') } }
    expect(resolveActiveModuleContext({ ...input, explicitModuleIds: [] }, guarded).promptFragments).toEqual([])
    expect(resolveActiveModuleContext({ ...input, skillsEnabled: false }, guarded).unavailable[0]?.reason).toBe('AGENT_MODULE_SKILLS_DISABLED')
  })
  test('Given 已关闭或卸载 When 再选旧模块 Then 阻止进入模型', () => {
    const { service, input, dependencies } = fixture()
    const disabled = service.setEnabled('acme.notes', false, service.snapshot().revision)
    expect(projectContentPluginModules(disabled)).toEqual([])
    expect(resolveActiveModuleContext(input, dependencies).unavailable[0]?.reason).toBe('AGENT_MODULE_NOT_FOUND')
    service.uninstall('acme.notes', disabled.revision)
    expect(resolveActiveModuleContext(input, dependencies).promptFragments).toEqual([])
  })
  test('Given 目录包身份过期或包解析失败 When 加载 Then 返回可审计失败而不降级', () => {
    const { input, dependencies } = fixture()
    const modules = dependencies.listModules().map(module => ({ ...module, packageHash: '0'.repeat(64) }))
    expect(resolveActiveModuleContext(input, { ...dependencies, listModules: () => modules }).unavailable[0]?.reason).toBe('AGENT_MODULE_PACKAGE_UNAVAILABLE')
    expect(resolveActiveModuleContext(input, { ...dependencies, resolvePackageModules: () => { throw new Error('坏包') } }).promptFragments).toEqual([])
  })
  test('Given 已关闭的包 When 旧版清单申请相同插件或模块身份 Then 写入前拒绝并可再次启用原包', () => {
    const { service, manager, registry, root } = fixture()
    manager.setEnabled('acme.notes', false, service.snapshot().revision)
    const legacy = new AgentPluginManagementService(registry, join(root, 'legacy'))
    for (const [pluginId, moduleId] of [['acme.notes', 'legacy-module'], ['legacy.notes', 'acme.notes.assistant']]) {
      const path = join(root, 'legacy.json')
      writeJsonFileAtomic(path, { id: pluginId, version: '1.0.0', apiVersion: 1, displayName: '旧插件', description: '身份冲突', entry: { kind: 'manifest-only' },
        modules: [{ ...listBuiltinAgentModules()[0], id: moduleId, skillRefs: [], promptRefs: [] }],
      })
      expect(() => legacy.preview(path)).toThrow('AGENT_PLUGIN_ID_CONFLICT')
    }
    manager.setEnabled('acme.notes', true, service.snapshot().revision)
    expect(registry.getModule('acme.notes.assistant')?.resourceSource).toBe('package')
  })
  test('Given 重启后同一包 When 从磁盘初始化宿主 Then 选择目录与运行来源一致，旧版刷新不丢内容包', () => {
    const { service, registry, root, input } = fixture()
    const restarted = new ContentPluginManager(new ContentPluginService(service.root), registry)
    restarted.initialize()
    const legacy = new AgentPluginManagementService(registry, join(root, 'legacy'))
    expect(legacy.refresh().modules.some(module => module.id === 'acme.notes.assistant')).toBe(true)
    expect(resolveActiveModuleContext(input).modules[0]?.packageHash).toBe(service.snapshot().plugins[0]?.packageHash)
    restarted.uninstall('acme.notes', service.snapshot().revision)
    expect(registry.getModule('acme.notes.assistant')).toBeUndefined()
    expect(resolveActiveModuleContext(input).unavailable[0]?.reason).toBe('AGENT_MODULE_NOT_FOUND')
  })
  test('Given 关闭包更新新增已占用模块 When 预览 Then 提交前拒绝而原版本仍可启用', () => {
    const { service, manager, registry, root, key } = fixture()
    manager.setEnabled('acme.notes', false, service.snapshot().revision)
    const legacy = new AgentPluginManagementService(registry, join(root, 'legacy'))
    const path = join(root, 'other.json')
    writeJsonFileAtomic(path, { id: 'other.vendor', version: '1.0.0', apiVersion: 1, displayName: '旧插件', description: '已有模块', entry: { kind: 'manifest-only' },
      modules: [{ ...listBuiltinAgentModules()[0], id: 'acme.notes.future', skillRefs: [], promptRefs: [] }],
    })
    legacy.install(legacy.preview(path).token)
    const files = createStandardPluginFiles('acme.notes', '升级插件')
    const manifest = JSON.parse(new TextDecoder().decode(files.get('plugin.json'))) as import('@dutydeck/plugin-sdk').PluginPackageManifest
    manifest.version = '2.0.0'; manifest.modules[0]!.id = 'future'; manifest.skills[0]!.ownerModuleId = 'future'
    files.set('plugin.json', Buffer.from(JSON.stringify(manifest)))
    const update = join(root, 'update.ddplugin')
    writeFileSync(update, createPluginPackage(files, key))
    expect(() => manager.preview(update)).toThrow('插件模块 ID 已被占用')
    expect(service.snapshot().plugins[0]?.manifest.version).toBe('1.0.0')
    manager.setEnabled('acme.notes', true, service.snapshot().revision)
  })
})
