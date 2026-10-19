import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, existsSync, readdirSync, rmdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseAgentPluginManifest } from '@dutydeck/shared'
import type { AgentPluginPreview, AgentPluginCatalogSnapshot, AgentPluginManifest } from '@dutydeck/shared'
import { getConfigDir } from '../config-paths'
import { readAtomicFileState, removeFileAtomic, writeJsonFileAtomicSecure } from '../safe-file'
import { AgentPluginRegistry } from './plugin-registry'
import { AGENT_PLUGIN_MANIFEST_MAX_BYTES, readAgentPluginManifestFile } from './plugin-manifest-loader'
import { setAgentModuleRuntimeCatalog } from './module-skill-resolver'

/** 验证路径各层均为真实目录，禁止通过任何符号链接进入受管写入边界。 */
function assertDirectory(path: string): void {
  const absolute = resolve(path)
  if (dirname(absolute) !== absolute) assertDirectory(dirname(absolute))
  if (!lstatSync(absolute).isDirectory()) throw new Error('AGENT_PLUGIN_UNSAFE_DIRECTORY')
}

/** 清单管理仅在显式用户操作时访问磁盘；运行中拒绝替换已准入能力目录。 */
export class AgentPluginManagementService {
  /** 有界候选缓存，保存预览时确切内容而非重新读取可变源路径。 */
  private readonly previews = new Map<string, AgentPluginPreview>()
  /** 最近一次成功同步目录的时间。 */
  private refreshedAt = Date.now()
  constructor(
    private readonly registry: AgentPluginRegistry,
    private readonly root = join(getConfigDir(), 'agent-plugins'),
    private readonly isBusy: () => boolean = () => false,
  ) {}

  /** 返回当前已发布快照，不扫描磁盘。 */
  snapshot(): AgentPluginCatalogSnapshot {
    return { modules: this.registry.listModules(), diagnostics: this.registry.getDiagnostics(), refreshedAt: this.refreshedAt }
  }

  /** 用户选择本地 JSON 后校验并缓存，返回可审核来源、内容及依赖警告。 */
  preview(path: string): AgentPluginPreview {
    assertDirectory(dirname(path))
    const parsed = parseAgentPluginManifest(readAgentPluginManifestFile(path))
    this.validateCandidate(parsed.manifest)
    const preview: AgentPluginPreview = {
      token: randomUUID(), sourcePath: path,
      contentHash: createHash('sha256').update(JSON.stringify(parsed.manifest)).digest('hex'),
      manifest: parsed.manifest,
      warnings: [...parsed.warnings, '仅安装清单，不执行插件代码；工具与权限声明不会授予额外权限。',
        ...(parsed.manifest.modules.some((module) => module.skillRefs.length > 0) ? ['Skill 文件不会随清单安装；当前会话运行前会核验所需 Skill，缺失或禁用时阻断调用。'] : [])],
    }
    if (this.previews.size >= 8) this.previews.clear()
    this.previews.set(preview.token, structuredClone(preview))
    return preview
  }

  /** 消费一次性预览凭据，只创建新插件目录，绝不覆盖已存在文件。 */
  install(token: string): AgentPluginCatalogSnapshot {
    this.assertIdle()
    const preview = this.previews.get(token)
    if (!preview) throw new Error('AGENT_PLUGIN_PREVIEW_EXPIRED')
    this.previews.delete(token)
    this.refresh()
    this.validateCandidate(preview.manifest)
    if (!existsSync(this.root)) { assertDirectory(dirname(this.root)); mkdirSync(this.root) }
    assertDirectory(this.root)
    if (readdirSync(this.root).length >= 64) throw new Error('AGENT_PLUGIN_CATALOG_LIMIT_EXCEEDED')
    const destination = join(this.root, preview.manifest.id)
    mkdirSync(destination)
    writeJsonFileAtomicSecure(join(destination, 'plugin.json'), preview.manifest, { expectedDestination: { kind: 'missing' } })
    /** 写入成功不等于安装成功，目录必须真实接纳此插件才能对 UI 返回成功。 */
    const snapshot = this.refresh()
    const diagnostic = snapshot.diagnostics.find((entry) => entry.pluginId === preview.manifest.id)
    if (diagnostic?.status !== 'loaded') throw new Error(diagnostic?.errorCode ?? 'AGENT_PLUGIN_INSTALL_NOT_ACCEPTED')
    return snapshot
  }

  /** 仅删除已加载且内容未变化的清单，绝不递归删除插件目录或用户 Skill。 */
  uninstall(pluginId: string): AgentPluginCatalogSnapshot {
    this.assertIdle()
    if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(pluginId)) throw new Error('AGENT_PLUGIN_ID_INVALID')
    const accepted = this.registry.getDiagnostics().find((entry) => entry.pluginId === pluginId && entry.status === 'loaded')
    if (!accepted) throw new Error('AGENT_PLUGIN_NOT_INSTALLED')
    assertDirectory(join(this.root, pluginId))
    const path = join(this.root, pluginId, 'plugin.json')
    const state = readAtomicFileState(path)
    const parsed = parseAgentPluginManifest(readAgentPluginManifestFile(path)).manifest
    const current = this.registry.getPlugin(pluginId)
    if (!state || parsed.id !== pluginId || JSON.stringify(parsed) !== JSON.stringify(current)) {
      throw new Error('AGENT_PLUGIN_MANIFEST_CHANGED_REFRESH_REQUIRED')
    }
    /** 完整状态再次比对，拒绝同 inode 内容被改写。 */
    if (JSON.stringify(readAtomicFileState(path)) !== JSON.stringify(state)) throw new Error('AGENT_PLUGIN_MANIFEST_CHANGED_REFRESH_REQUIRED')
    removeFileAtomic(path, { expectedIdentity: state })
    // 只删除确实空的目录；其他用户文件由操作系统保护，不做递归删除。
    try { rmdirSync(join(this.root, pluginId)) } catch { /* 保留非空目录供用户处理。 */ }
    return this.refresh()
  }

  /** 同步发布 registry 与 resolver；调用期间无 await，不暴露半更新状态。 */
  refresh(): AgentPluginCatalogSnapshot {
    this.assertIdle()
    this.registry.loadInstalledPlugins(this.root)
    setAgentModuleRuntimeCatalog(this.registry.listModules(), this.registry.getPromptCatalog())
    this.refreshedAt = Date.now()
    return this.snapshot()
  }

  /** 忙碌会话含正在运行或排队任务；避免热更新改变已准入能力。 */
  private assertIdle(): void {
    if (this.isBusy()) throw new Error('Agent 正在运行，请等待任务结束后再安装、刷新或卸载插件。')
  }

  /** 候选整体预算和 ID 冲突在写入之前拒绝。 */
  private validateCandidate(manifest: AgentPluginManifest): void {
    // 与 safe-file 的实际 UTF-8 pretty JSON 编码一致，预览和提交均在创建目录前校验。
    if (Buffer.byteLength(JSON.stringify(manifest, null, 2), 'utf8') > AGENT_PLUGIN_MANIFEST_MAX_BYTES) {
      throw new Error('AGENT_PLUGIN_SERIALIZED_MANIFEST_TOO_LARGE')
    }
    if (existsSync(this.root)) {
      assertDirectory(this.root)
      try { lstatSync(join(this.root, manifest.id)); throw new Error('AGENT_PLUGIN_DESTINATION_EXISTS') }
      catch (cause) { if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) throw cause }
    }
    const modules = this.registry.listModules()
    if (manifest.id.startsWith('builtin.') || modules.some((module) => module.pluginId === manifest.id)) throw new Error('AGENT_PLUGIN_ID_CONFLICT')
    if (manifest.modules.some((module) => modules.some((existing) => existing.id === module.id))) throw new Error('AGENT_PLUGIN_MODULE_ID_CONFLICT')
    const installed = modules.filter((module) => module.source === 'installed')
    const prompts = this.registry.getPromptCatalog()
    if (Object.keys(manifest.prompts ?? {}).some((id) => Object.hasOwn(prompts, id))) throw new Error('AGENT_PLUGIN_PROMPT_ID_CONFLICT')
    if (installed.length + manifest.modules.length > 256 || Object.values({ ...prompts, ...manifest.prompts }).reduce((sum, text) => sum + text.length, 0) > 512 * 1024) throw new Error('AGENT_PLUGIN_CATALOG_LIMIT_EXCEEDED')
  }
}
