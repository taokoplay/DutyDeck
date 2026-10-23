import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { PluginV3Manifest } from '@dutydeck/plugin-sdk'
import { readBoundedFile, writeNewFile } from '@dutydeck/plugin-kit/filesystem'
import { inspectPluginPackage } from '@dutydeck/plugin-kit/package'
import { acquireMediaFileLock } from '../media/media-file-lock'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'
import type { ModuleRuntimeManager } from './module-runtime-manager'
import { materializeRuntimePluginPackage } from './runtime-package-materializer'

/** 已安装 V3 插件的可展示记录，不包含 runtime 文件正文。 */
export interface InstalledRuntimePlugin {
  manifest: PluginV3Manifest
  packageHash: string
  keyId?: string
  enabled: boolean
  installedAt: string
  packageRoot: string
}

/** V3 插件目录快照。 */
export interface ModuleRuntimePluginSnapshot {
  revision: number
  plugins: InstalledRuntimePlugin[]
}

/** 原生文件选择后的候选。 */
export interface ModuleRuntimePluginPreview {
  token: string
  manifest: PluginV3Manifest
  packageHash: string
  signatureVerified: boolean
  signer?: { keyId: string; publicKey: string }
  operation: 'install' | 'update'
  previousVersion?: string
}

/** service 依赖与隔离模式。 */
export interface ModuleRuntimePluginServiceOptions {
  root: string
  manager: ModuleRuntimeManager
  development?: boolean
  isBusy?: () => boolean
}

/** 注册表格式只接受当前精确版本。 */
interface RuntimeRegistry {
  formatVersion: 1
  revision: number
  plugins: InstalledRuntimePlugin[]
}

/** 预览的精确包字节，不重新读取可变源路径。 */
interface RuntimePreviewState {
  preview: ModuleRuntimePluginPreview
  bytes: Uint8Array
  expiresAt: number
}

/** 判断磁盘注册表结构，损坏时 fail closed。 */
function isRuntimeRegistry(value: unknown): value is RuntimeRegistry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.formatVersion === 1
    && Number.isSafeInteger(record.revision)
    && Array.isArray(record.plugins)
    && record.plugins.every(plugin => {
      if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) return false
      const entry = plugin as Record<string, unknown>
      return typeof entry.packageHash === 'string'
        && /^[a-f0-9]{64}$/.test(entry.packageHash)
        && typeof entry.enabled === 'boolean'
        && typeof entry.installedAt === 'string'
        && typeof entry.packageRoot === 'string'
        && Boolean(entry.manifest)
    })
}

/** 管理 V3 包导入、展开、启停与持久目录。 */
export class ModuleRuntimePluginService {
  private readonly root: string
  private readonly manager: ModuleRuntimeManager
  private readonly development: boolean
  private readonly isBusy: () => boolean
  private readonly previews = new Map<string, RuntimePreviewState>()
  private registry: RuntimeRegistry = { formatVersion: 1, revision: 0, plugins: [] }
  /** 多入口并发调用共享同一次目录初始化。 */
  private initialization: Promise<ModuleRuntimePluginSnapshot> | undefined

  constructor(options: ModuleRuntimePluginServiceOptions) {
    this.root = resolve(options.root)
    this.manager = options.manager
    this.development = options.development === true
    this.isBusy = options.isBusy ?? (() => false)
  }

  /** 创建目录并加载已启用插件；注册表损坏时不静默重置。 */
  async initialize(): Promise<ModuleRuntimePluginSnapshot> {
    if (!this.initialization) {
      this.initialization = this.initializeOnce().catch((error: unknown) => {
        this.initialization = undefined
        throw error
      })
    }
    return this.initialization
  }

  /** 首次初始化只执行一次，失败后保留原错误。 */
  private async initializeOnce(): Promise<ModuleRuntimePluginSnapshot> {
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const stat = lstatSync(this.root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('PLUGIN_RUNTIME_ROOT_UNSAFE')
    const stored = readJsonFileSafe(join(this.root, 'registry.json'), {
      validate: isRuntimeRegistry,
      maxBytes: 8 * 1024 * 1024,
      secureRecovery: true,
    })
    this.registry = stored ? structuredClone(stored) : { formatVersion: 1, revision: 0, plugins: [] }
    for (const plugin of this.registry.plugins.filter(entry => entry.enabled)) {
      const verified = this.verifyInstalledEntry(plugin)
      this.manager.register({
        manifest: verified.manifest,
        packageHash: plugin.packageHash,
        packageRoot: verified.packageRoot,
        prompts: verified.prompts,
      })
    }
    return this.snapshot()
  }

  /** 从原生选择路径读取有界包字节并生成预览。 */
  preview(path: string): ModuleRuntimePluginPreview {
    return this.previewBytes(readBoundedFile(path, 50 * 1024 * 1024))
  }

  /** 对调用方已读取的包字节做完整校验并缓存候选。 */
  previewBytes(bytes: Uint8Array): ModuleRuntimePluginPreview {
    if (bytes.byteLength > 50 * 1024 * 1024) throw new Error('PLUGIN_PACKAGE_SIZE_LIMIT')
    const inspected = inspectPluginPackage(bytes)
    if (inspected.manifest.formatVersion !== 3 || inspected.manifest.profile !== 'module-runtime') {
      throw new Error('PLUGIN_MODULE_RUNTIME_REQUIRED')
    }
    if (!this.development && !inspected.signatureVerified) throw new Error('PLUGIN_SIGNATURE_REQUIRED')
    const previous = this.registry.plugins.find(plugin => plugin.manifest.id === inspected.manifest.id)
    const token = randomUUID()
    const preview: ModuleRuntimePluginPreview = {
      token,
      manifest: inspected.manifest,
      packageHash: inspected.packageHash,
      signatureVerified: inspected.signatureVerified,
      ...(inspected.signer ? { signer: inspected.signer } : {}),
      operation: previous ? 'update' : 'install',
      ...(previous ? { previousVersion: previous.manifest.version } : {}),
    }
    if (this.previews.size >= 8) this.previews.clear()
    this.previews.set(token, { preview, bytes: Uint8Array.from(bytes), expiresAt: Date.now() + 10 * 60_000 })
    return structuredClone(preview)
  }

  /** 安装已确认的精确预览字节。 */
  async install(token: string, trustedKeyId?: string): Promise<ModuleRuntimePluginSnapshot> {
    this.assertIdle()
    return this.withLock(async () => {
      const pending = this.previews.get(token)
      if (!pending || pending.expiresAt < Date.now()) throw new Error('PLUGIN_PREVIEW_EXPIRED')
      const inspected = inspectPluginPackage(pending.bytes)
      if (inspected.manifest.formatVersion !== 3 || inspected.packageHash !== pending.preview.packageHash) {
        throw new Error('PLUGIN_PREVIEW_CHANGED')
      }
      const previous = this.registry.plugins.find(plugin => plugin.manifest.id === inspected.manifest.id)
      const keyId = inspected.signer?.keyId
      if (!this.development) {
        if (!keyId) throw new Error('PLUGIN_SIGNATURE_REQUIRED')
        if (previous?.keyId ? previous.keyId !== keyId : trustedKeyId !== keyId) throw new Error('PLUGIN_PUBLISHER_UNTRUSTED')
        if (previous && !isHigherVersion(inspected.manifest.version, previous.manifest.version)) throw new Error('PLUGIN_VERSION_NOT_NEWER')
      }
      const materialized = materializeRuntimePluginPackage({
        root: this.root,
        manifest: inspected.manifest,
        packageHash: inspected.packageHash,
        files: inspected.files,
      })
      const archivePath = join(this.root, 'archives', inspected.manifest.id, `${inspected.packageHash}.ddplugin`)
      if (!existsSync(archivePath)) {
        mkdirSync(join(this.root, 'archives', inspected.manifest.id), { recursive: true, mode: 0o700 })
        writeNewFile(archivePath, pending.bytes)
      }
      if (previous?.enabled) await this.manager.unregister(previous.manifest.id)
      const entry: InstalledRuntimePlugin = {
        manifest: inspected.manifest,
        packageHash: inspected.packageHash,
        ...(keyId ? { keyId } : {}),
        enabled: previous?.enabled ?? true,
        installedAt: previous?.installedAt ?? new Date().toISOString(),
        packageRoot: materialized.packageRoot,
      }
      const next: RuntimeRegistry = {
        formatVersion: 1,
        revision: this.registry.revision + 1,
        plugins: [...this.registry.plugins.filter(plugin => plugin.manifest.id !== entry.manifest.id), entry],
      }
      try {
        if (entry.enabled) {
          this.manager.register({
            manifest: entry.manifest,
            packageHash: entry.packageHash,
            packageRoot: entry.packageRoot,
            prompts: materialized.prompts,
          })
        }
        this.persist(next)
      } catch (error) {
        if (entry.enabled) await this.manager.unregister(entry.manifest.id)
        if (previous?.enabled) {
          const previousVerified = this.verifyInstalledEntry(previous)
          this.manager.register({
            manifest: previousVerified.manifest,
            packageHash: previous.packageHash,
            packageRoot: previousVerified.packageRoot,
            prompts: previousVerified.prompts,
          })
        }
        throw error
      }
      this.registry = next
      this.previews.delete(token)
      return this.snapshot()
    })
  }

  /** 修改启用状态；停用会撤销 Agent 工具和 Surface。 */
  async setEnabled(pluginId: string, enabled: boolean, expectedRevision: number): Promise<ModuleRuntimePluginSnapshot> {
    this.assertIdle()
    return this.withLock(async () => {
      this.assertRevision(expectedRevision)
      const previous = this.registry.plugins.find(plugin => plugin.manifest.id === pluginId)
      if (!previous) throw new Error('PLUGIN_NOT_INSTALLED')
      if (previous.enabled === enabled) return this.snapshot()
      if (enabled) {
        const verified = this.verifyInstalledEntry(previous)
        this.manager.register({
          manifest: verified.manifest,
          packageHash: previous.packageHash,
          packageRoot: verified.packageRoot,
          prompts: verified.prompts,
        })
      } else {
        await this.manager.unregister(pluginId)
      }
      const next: RuntimeRegistry = {
        formatVersion: 1,
        revision: this.registry.revision + 1,
        plugins: this.registry.plugins.map(plugin => plugin.manifest.id === pluginId ? { ...plugin, enabled } : plugin),
      }
      try {
        this.persist(next)
      } catch (error) {
        if (enabled) await this.manager.unregister(pluginId)
        else {
          const previousVerified = this.verifyInstalledEntry(previous)
          this.manager.register({
            manifest: previousVerified.manifest,
            packageHash: previous.packageHash,
            packageRoot: previousVerified.packageRoot,
            prompts: previousVerified.prompts,
          })
        }
        throw error
      }
      this.registry = next
      return this.snapshot()
    })
  }

  /** 卸载只撤销注册，保留不可变包、项目产物和插件私有数据。 */
  async uninstall(pluginId: string, expectedRevision: number): Promise<ModuleRuntimePluginSnapshot> {
    this.assertIdle()
    return this.withLock(async () => {
      this.assertRevision(expectedRevision)
      const previous = this.registry.plugins.find(plugin => plugin.manifest.id === pluginId)
      if (!previous) throw new Error('PLUGIN_NOT_INSTALLED')
      if (previous.enabled) await this.manager.unregister(pluginId)
      const next: RuntimeRegistry = {
        formatVersion: 1,
        revision: this.registry.revision + 1,
        plugins: this.registry.plugins.filter(plugin => plugin.manifest.id !== pluginId),
      }
      try {
        this.persist(next)
      } catch (error) {
        if (previous.enabled) {
          const previousVerified = this.verifyInstalledEntry(previous)
          this.manager.register({
            manifest: previousVerified.manifest,
            packageHash: previous.packageHash,
            packageRoot: previousVerified.packageRoot,
            prompts: previousVerified.prompts,
          })
        }
        throw error
      }
      this.registry = next
      return this.snapshot()
    })
  }

  /** 返回当前持久目录快照。 */
  snapshot(): ModuleRuntimePluginSnapshot {
    return { revision: this.registry.revision, plugins: structuredClone(this.registry.plugins) }
  }

  /** 释放 manager 持有的全部 runtime。 */
  async dispose(): Promise<void> {
    await this.initialization
    await this.manager.dispose()
  }

  /**
   * 重启时从不可变包摘要重新证明已安装记录；注册表不能指定任意 runtime 根。
   * @param plugin 注册表中的安装摘要。
   * @returns 规范包根与提示正文。
   */
  private verifyInstalledEntry(plugin: InstalledRuntimePlugin): {
    manifest: PluginV3Manifest
    packageRoot: string
    prompts: Record<string, string>
  } {
    const bytes = readBoundedFile(this.archivePath(plugin.manifest.id, plugin.packageHash), 50 * 1024 * 1024)
    const inspected = inspectPluginPackage(bytes)
    if (inspected.manifest.formatVersion !== 3
      || inspected.packageHash !== plugin.packageHash
      || inspected.manifest.id !== plugin.manifest.id
      || inspected.manifest.version !== plugin.manifest.version
      || JSON.stringify(inspected.manifest) !== JSON.stringify(plugin.manifest)) {
      throw new Error('PLUGIN_INSTALLED_IDENTITY_CHANGED')
    }
    const materialized = materializeRuntimePluginPackage({
      root: this.root,
      manifest: inspected.manifest,
      packageHash: inspected.packageHash,
      files: inspected.files,
    })
    if (materialized.packageRoot !== plugin.packageRoot) throw new Error('PLUGIN_INSTALLED_PATH_CHANGED')
    return {
      manifest: inspected.manifest,
      packageRoot: materialized.packageRoot,
      prompts: materialized.prompts,
    }
  }

  /** 归档只由插件 ID 与包摘要推导，注册表不提供路径。 */
  private archivePath(pluginId: string, packageHash: string): string {
    return join(this.root, 'archives', pluginId, `${packageHash}.ddplugin`)
  }

  /** 单进程锁保护注册表读改写，避免同窗并发覆盖。 */
  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const release = acquireMediaFileLock(join(this.root, '.runtime-plugins.lock'))
    try {
      return await operation()
    } finally {
      release()
    }
  }

  /** revision CAS 防止旧界面覆盖更新。 */
  private assertRevision(expected: number): void {
    if (!Number.isSafeInteger(expected) || expected !== this.registry.revision) {
      throw new Error('PLUGIN_REGISTRY_REVISION_CONFLICT')
    }
  }

  /** 运行或排队期间不替换可执行贡献。 */
  private assertIdle(): void {
    if (this.isBusy()) throw new Error('AGENT_BUSY')
  }

  /** 注册表写失败不能标为安装成功。 */
  private persist(registry: RuntimeRegistry): void {
    writeJsonFileAtomic(join(this.root, 'registry.json'), registry)
  }
}

/** 比较严格 SemVer 主版本以拒绝降级。 */
function isHigherVersion(candidate: string, current: string): boolean {
  const left = candidate.split(/[.+-]/).slice(0, 3).map(Number)
  const right = current.split(/[.+-]/).slice(0, 3).map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! > right[index]!
  }
  return false
}
