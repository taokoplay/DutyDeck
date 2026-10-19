import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, symlinkSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AgentPluginManagementService } from './plugin-management-service'
import { AgentPluginRegistry } from './plugin-registry'
import { listBuiltinAgentModules } from './module-registry'
import { resolveActiveModuleContext, setAgentModuleRuntimeCatalog } from './module-skill-resolver'
import { writeJsonFileAtomic } from '../safe-file'

/** 每例使用真实无符号链接临时目录，避免污染用户插件。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); setAgentModuleRuntimeCatalog(null) })
/** 创建无外部依赖的纯文本插件测试清单。 */
function manifest(id = 'example') {
  return { id, version: '1.0.0', apiVersion: 1, displayName: '测试插件', description: '纯文本测试', entry: { kind: 'manifest-only' }, prompts: { [`${id}.system`]: '旧提示' }, modules: [{ ...listBuiltinAgentModules()[4]!, id: `${id}-module`, promptRefs: [`${id}.system`] }] }
}
/** 返回独立服务、受管目录和候选清单路径。 */
function setup(isBusy: () => boolean = () => false) {
  const base = mkdtempSync('/private/tmp/dutydeck-plugin-management-'); roots.push(base)
  const root = join(base, 'agent-plugins'); mkdirSync(root)
  const source = join(base, 'candidate.json'); writeJsonFileAtomic(source, manifest())
  const registry = new AgentPluginRegistry(); registry.registerBuiltinModules(listBuiltinAgentModules())
  const service = new AgentPluginManagementService(registry, root, isBusy)
  return { base, root, source, registry, service }
}

describe('manifest-only 插件安装管理', () => {
  test('Given 预览已确认 When 源文件随后改变 Then 安装确切预览内容且一次令牌不能重复消费', () => {
    const { source, root, service } = setup()
    const preview = service.preview(source)
    writeJsonFileAtomic(source, manifest('changed'))
    const snapshot = service.install(preview.token)
    expect(snapshot.modules.some((module) => module.id === 'example-module')).toBe(true)
    expect(JSON.parse(readFileSync(join(root, 'example/plugin.json'), 'utf8')).id).toBe('example')
    expect(() => service.install(preview.token)).toThrow('AGENT_PLUGIN_PREVIEW_EXPIRED')
    expect(() => service.preview(join(root, 'example/plugin.json'))).toThrow('AGENT_PLUGIN_DESTINATION_EXISTS')
  })
  test('Given 内置冲突、路径逃逸、超限或符号链接 When 预览 Then 拒绝且不写受管目录', () => {
    const { source, base, root, service } = setup()
    writeJsonFileAtomic(source, { ...manifest(), modules: [listBuiltinAgentModules()[0]] })
    expect(() => service.preview(source)).toThrow('AGENT_PLUGIN_MODULE_ID_CONFLICT')
    writeJsonFileAtomic(source, manifest('../escape'))
    expect(() => service.preview(source)).toThrow('AGENT_PLUGIN_ID_INVALID')
    writeFileSync(source, ' '.repeat(1024 * 1024 + 1))
    expect(() => service.preview(source)).toThrow()
    const link = join(base, 'link.json'); symlinkSync(source, link)
    expect(() => service.preview(link)).toThrow()
    expect(existsSync(join(root, 'example'))).toBe(false)
  })
  test('Given 运行中 When 安装刷新卸载 Then 拒绝变更而已生成上下文保持原提示', () => {
    let busy = false
    const { service, source, root } = setup(() => busy)
    service.install(service.preview(source).token)
    const input = { sessionId: 'session', workspaceSlug: 'test', policy: { revision: 1, mode: 'available' as const, enabledModuleIds: ['example-module'], pinnedModuleIds: [], disabledModuleIds: [], updatedAt: 1 } }
    const context = resolveActiveModuleContext(input)
    busy = true
    writeJsonFileAtomic(join(root, 'example/plugin.json'), { ...manifest(), prompts: { 'example.system': '新提示' } })
    expect(() => service.refresh()).toThrow('Agent 正在运行')
    expect(() => service.uninstall('example')).toThrow('Agent 正在运行')
    expect(() => service.install('unknown')).toThrow('Agent 正在运行')
    expect(context.promptFragments).toContain('旧提示')
    busy = false; service.refresh()
    expect(resolveActiveModuleContext(input).promptFragments).toContain('新提示')
    expect(context.promptFragments).toContain('旧提示')
  })
  test('Given 已安装插件带用户 Skill When 确认卸载 Then 仅清单消失且用户文件保留', () => {
    const { service, source, root } = setup()
    service.install(service.preview(source).token)
    const skill = join(root, 'example/SKILL.md'); writeFileSync(skill, '用户内容')
    const snapshot = service.uninstall('example')
    expect(readFileSync(skill, 'utf8')).toBe('用户内容')
    expect(existsSync(join(root, 'example/plugin.json'))).toBe(false)
    expect(snapshot.modules.some((module) => module.id === 'example-module')).toBe(false)
    expect(() => service.uninstall('../example')).toThrow('AGENT_PLUGIN_ID_INVALID')
  })
  test('Given 已安装清单提示被外部修改 When 卸载 Then 必须先刷新核对而不删除', () => {
    const { service, source, root } = setup()
    service.install(service.preview(source).token)
    writeJsonFileAtomic(join(root, 'example/plugin.json'), { ...manifest(), prompts: { 'example.system': '变更' } })
    expect(() => service.uninstall('example')).toThrow('AGENT_PLUGIN_MANIFEST_CHANGED_REFRESH_REQUIRED')
    expect(existsSync(join(root, 'example/plugin.json'))).toBe(true)
  })
  test('Given 已存在损坏目录或受管根符号链接 When 安装 Then 拒绝覆盖且原始内容保持', () => {
    const { service, source, root, base } = setup()
    const preview = service.preview(source)
    mkdirSync(join(root, 'example'))
    writeFileSync(join(root, 'example/plugin.json'), 'invalid original')
    expect(() => service.install(preview.token)).toThrow('AGENT_PLUGIN_DESTINATION_EXISTS')
    expect(readFileSync(join(root, 'example/plugin.json'), 'utf8')).toBe('invalid original')
    const linkedRoot = join(base, 'linked-root'); symlinkSync(root, linkedRoot)
    const linked = new AgentPluginManagementService(new AgentPluginRegistry(), linkedRoot)
    expect(() => linked.preview(source)).toThrow('AGENT_PLUGIN_UNSAFE_DIRECTORY')
  })
  test('Given 合法清单累计提示达到全局预算 When 预览下一插件 Then 拒绝超预算候选', () => {
    const { service, source, root } = setup()
    for (let index = 0; index < 8; index += 1) {
      const id = `plugin-${index}`
      const candidate = manifest(id)
      candidate.prompts = Object.fromEntries(Array.from({ length: 4 }, (_, item) => [`${id}.text-${item}`, 'x'.repeat(16 * 1024)]))
      candidate.modules[0]!.promptRefs = Object.keys(candidate.prompts)
      mkdirSync(join(root, id)); writeJsonFileAtomic(join(root, id, 'plugin.json'), candidate)
    }
    service.refresh()
    expect(() => service.preview(source)).toThrow('AGENT_PLUGIN_CATALOG_LIMIT_EXCEEDED')
  })
  test('Given 插件声明缺失 Skill When 显式调用 Then 返回依赖诊断且不注入提示', () => {
    const { service, source } = setup()
    const candidate = manifest(); candidate.modules[0]!.skillRefs = ['not-installed']
    writeJsonFileAtomic(source, candidate)
    const preview = service.preview(source)
    expect(preview.warnings.join(' ')).toContain('缺失或禁用时阻断调用')
    service.install(preview.token)
    const context = resolveActiveModuleContext({ sessionId: 's', workspaceSlug: 'w', explicitModuleIds: ['example-module'], policy: { mode: 'auto', enabledModuleIds: [], pinnedModuleIds: [], disabledModuleIds: [], revision: 0, updatedAt: 0 } }, { getSkills: () => [] })
    expect(context.unavailable).toEqual([{ moduleId: 'example-module', reason: 'AGENT_MODULE_SKILL_UNAVAILABLE' }])
    expect(context.promptFragments).toEqual([])
  })

  test('Given compact 清单可读取但 pretty JSON 超出1MiB When 预览 Then 写入前拒绝且不创建插件目录', () => {
    const { service, source, root } = setup()
    const candidate = manifest()
    const compactBudget = 1024 * 1024 - Buffer.byteLength(JSON.stringify(candidate)) - 50
    candidate.description += 'x'.repeat(compactBudget)
    expect(Buffer.byteLength(JSON.stringify(candidate))).toBeLessThan(1024 * 1024)
    expect(Buffer.byteLength(JSON.stringify(candidate, null, 2))).toBeGreaterThan(1024 * 1024)
    writeFileSync(source, JSON.stringify(candidate))
    expect(() => service.preview(source)).toThrow('AGENT_PLUGIN_SERIALIZED_MANIFEST_TOO_LARGE')
    expect(existsSync(join(root, 'example'))).toBe(false)
  })
  test('Given 70000短工具引用的紧凑清单 When 预览 Then 拒绝不再写出膨胀清单', () => {
    const { service, source, root } = setup()
    const candidate = manifest()
    candidate.modules[0]!.toolRefs = Array.from({ length: 70000 }, (_, index) => `t${index}`)
    expect(Buffer.byteLength(JSON.stringify(candidate))).toBeLessThan(1024 * 1024)
    expect(Buffer.byteLength(JSON.stringify(candidate, null, 2))).toBeGreaterThan(1024 * 1024)
    writeFileSync(source, JSON.stringify(candidate))
    expect(() => service.preview(source)).toThrow('AGENT_MODULE_MANIFEST_TOOLREFS_TOO_LARGE')
    expect(existsSync(join(root, 'example'))).toBe(false)
  })

  test('Given 写入后目录拒绝新插件 When 安装返回 Then 报告拒绝原因而不误报成功', () => {
    const { source, root } = setup()
    /** 模拟外部进程在提交后、加载前修改清单；只能报告失败，不能冒称安装成功。 */
    class ChangedManifestRegistry extends AgentPluginRegistry {
      override loadInstalledPlugins(pluginRoot?: string) {
        if (pluginRoot && existsSync(join(pluginRoot, 'example/plugin.json'))) writeFileSync(join(pluginRoot, 'example/plugin.json'), 'corrupted externally')
        return super.loadInstalledPlugins(pluginRoot)
      }
    }
    const registry = new ChangedManifestRegistry()
    registry.registerBuiltinModules(listBuiltinAgentModules())
    const service = new AgentPluginManagementService(registry, root)
    expect(() => service.install(service.preview(source).token)).toThrow('AGENT_PLUGIN_MANIFEST_UNREADABLE')
    expect(service.snapshot().modules.some((module) => module.id === 'example-module')).toBe(false)
    expect(readFileSync(join(root, 'example/plugin.json'), 'utf8')).toBe('corrupted externally')
  })

})
