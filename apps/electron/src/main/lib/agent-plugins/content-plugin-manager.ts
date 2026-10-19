import type { ContentPluginSnapshot, ContentPluginPreview } from './content-plugin-service'
import { ContentPluginService } from './content-plugin-service'
import { projectContentPluginModules } from './content-module-runtime'
import type { AgentPluginRegistry } from '../agent-modules/plugin-registry'
import { setAgentModuleRuntimeCatalog, setPackageModuleResolver } from '../agent-modules/module-skill-resolver'

/** 串接不可变安装包与既有模块目录，提交前先证明可以接纳整份新目录。 */
export class ContentPluginManager {
  /** 候选只存轻量元数据，包字节由 service 的有界缓存保管。 */
  private readonly previews = new Map<string, ContentPluginPreview>()
  constructor(readonly service: ContentPluginService, private readonly registry: AgentPluginRegistry, private readonly changed: () => void = () => {}) {}

  /** 启动阶段装配读取能力；目录读取失败由主进程保留设置诊断。 */
  initialize(): void {
    setPackageModuleResolver(ids => this.service.resolveModules(ids))
    this.publish(this.service.snapshot())
  }

  /** 文件选择后的候选同时核验与既有 V1/内置目录的冲突。 */
  preview(path: string): ContentPluginPreview {
    const preview = this.service.preview(path)
    this.validateCandidate(this.service.snapshot(), preview)
    if (this.previews.size >= 8) this.previews.clear()
    this.previews.set(preview.token, preview)
    return preview
  }

  /** 安装时再次核验最新目录，不能靠先前预览绕过后续 V1 安装。 */
  install(token: string, trustedKeyId?: string): ContentPluginSnapshot {
    const preview = this.previews.get(token)
    if (!preview) throw new Error('插件预览已失效，请重新选择文件')
    this.validateCandidate(this.service.snapshot(), preview)
    const result = this.service.install(token, trustedKeyId)
    this.previews.delete(token)
    return this.publish(result)
  }

  /** 重新启用也要检查期间安装的旧版插件，避免提交后才发现身份冲突。 */
  setEnabled(id: string, enabled: boolean, revision: number): ContentPluginSnapshot {
    const candidate = this.service.snapshot()
    for (const plugin of candidate.plugins) if (plugin.manifest.id === id) plugin.enabled = enabled
    this.validate(candidate)
    return this.publish(this.service.setEnabled(id, enabled, revision))
  }

  /** 只撤准入不删除历史包，目录更新与注册表提交保持同一同步调用。 */
  uninstall(id: string, revision: number): ContentPluginSnapshot {
    return this.publish(this.service.uninstall(id, revision))
  }

  /** 以完整候选模拟更新；保留已关闭状态，不因升级自动启用。 */
  private validateCandidate(snapshot: ContentPluginSnapshot, preview: ContentPluginPreview): void {
    const previous = snapshot.plugins.find(plugin => plugin.manifest.id === preview.manifest.id)
    this.validate({ revision: snapshot.revision, plugins: [...snapshot.plugins.filter(plugin => plugin.manifest.id !== preview.manifest.id), {
      manifest: preview.manifest, packageHash: preview.packageHash, enabled: previous?.enabled ?? true,
      installedAt: previous?.installedAt ?? new Date().toISOString(), resources: preview.resources,
    }] })
  }

  /** 全目录限制阻止大量小包放大界面和每轮模块映射开销。 */
  private validate(snapshot: ContentPluginSnapshot): void {
    const legacy = this.registry.listModules().filter(module => module.resourceSource !== 'package')
    const occupied = new Set(legacy.map(module => module.id))
    const pluginIds = new Set(legacy.map(module => module.pluginId))
    if (snapshot.plugins.length > 64 || snapshot.plugins.reduce((sum, plugin) => sum + plugin.manifest.modules.length, 0) + legacy.filter(module => module.source === 'installed').length > 256) throw new Error('插件目录超过数量限制')
    for (const plugin of snapshot.plugins) {
      if (pluginIds.has(plugin.manifest.id)) throw new Error('插件 ID 已被旧版或内置插件占用')
    }
    for (const module of projectContentPluginModules({ ...snapshot, plugins: snapshot.plugins.map(plugin => ({ ...plugin, enabled: true })) })) {
      if (occupied.has(module.id)) throw new Error('插件模块 ID 已被占用')
      occupied.add(module.id)
    }
  }

  /** 每次成功提交只发布元数据；正文仍等用户当前消息选择后读取。 */
  private publish(snapshot: ContentPluginSnapshot): ContentPluginSnapshot {
    this.validate(snapshot)
    this.registry.setContentModules(projectContentPluginModules(snapshot), projectContentPluginModules({ ...snapshot, plugins: snapshot.plugins.map(plugin => ({ ...plugin, enabled: true })) }))
    setAgentModuleRuntimeCatalog(this.registry.listModules(), this.registry.getPromptCatalog())
    this.changed()
    return snapshot
  }
}
