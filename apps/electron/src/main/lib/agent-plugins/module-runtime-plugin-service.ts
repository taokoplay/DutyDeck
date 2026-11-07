import type { PluginRuntimeManagementView, ModuleRuntimePluginChanges } from '@dutydeck/shared'
import { pluginVersionChanges } from './plugin-version-changes'
import { assessPluginValidation } from './plugin-validation'
import { getHostPluginValidationRecords, getPluginValidationEnvironment, readPluginValidationEnvironment } from './plugin-validation-catalog'
import { PluginDataDirectory } from './plugin-data-directory'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  PLUGIN_V3_API_VERSION,
  assertPluginRuntimeCompatibility,
  getPluginRuntimeExecutionBlock,
  isPluginHostApiCompatible,
  type PluginV3Manifest,
  type PluginCapabilityId,
} from '@dutydeck/plugin-sdk'
import { readBoundedFile, writeNewFile } from '@dutydeck/plugin-kit/filesystem'
import { inspectPluginPackage } from '@dutydeck/plugin-kit/package'
import { acquireMediaFileLock } from '../media/media-file-lock'
import { readJsonFileStrict, writeJsonFileAtomicSecure } from '../safe-file'
import type { ModuleRuntimeManager, ManagedRuntimePlugin } from './module-runtime-manager'
import { materializeRuntimePluginPackage } from './runtime-package-materializer'
import { PluginGrantStore, type PluginGrantRecord } from './plugin-grant-store'
import { PluginSettingsStore, type PluginSettingsSnapshot } from './plugin-settings-store'

/** 已安装 V3 插件的可展示记录，不包含 runtime 文件正文。 */
export interface InstalledRuntimePlugin {
  manifest: PluginV3Manifest
  packageHash: string
  keyId?: string
  enabled: boolean
  /** 由当前宿主重新计算，不是持久授权状态。 */
  executionBlock?: 'PLUGIN_RUNTIME_CONTRACT_MIGRATION_REQUIRED'
  installedAt: string
  management?: PluginRuntimeManagementView
  packageRoot: string
  /** 展示时按独立授权文件计算，不从注册表恢复授权。 */
  grant?: PluginGrantRecord | null
  settings?: PluginSettingsSnapshot
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
  changes: ModuleRuntimePluginChanges
  validation: PluginRuntimeManagementView['validation']
}

/** 可供显式回滚的历史包摘要，不暴露文件系统路径。 */
export interface ArchivedRuntimePluginVersion {
  version: string
  packageHash: string
  signatureVerified: boolean
  keyId?: string
  changes: ModuleRuntimePluginChanges
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

/** 插件 ID 只允许稳定的小写命名空间片段。 */
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/

/** 校验插件声明的平台、架构和 Host API 范围是否适用于当前宿主。 */
function assertHostCompatibility(manifest: PluginV3Manifest): void {
  assertPluginRuntimeCompatibility(manifest)
  if (!manifest.compatibility.platforms.includes(process.platform as PluginV3Manifest['compatibility']['platforms'][number])) {
    throw new Error('PLUGIN_PLATFORM_UNSUPPORTED')
  }
  if (!manifest.compatibility.architectures.includes(process.arch as PluginV3Manifest['compatibility']['architectures'][number])) {
    throw new Error('PLUGIN_ARCHITECTURE_UNSUPPORTED')
  }
  if (!isPluginHostApiCompatible(manifest.compatibility.hostApi, PLUGIN_V3_API_VERSION)) {
    throw new Error('PLUGIN_HOST_API_UNSUPPORTED')
  }
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
  private readonly directory: PluginDataDirectory
  private readonly root: string
  private readonly manager: ModuleRuntimeManager
  private readonly development: boolean
  private readonly isBusy: () => boolean
  readonly grants: PluginGrantStore
  readonly settings: PluginSettingsStore
  private readonly previews = new Map<string, RuntimePreviewState>()
  private registry: RuntimeRegistry = { formatVersion: 1, revision: 0, plugins: [] }
  /** 多入口并发调用共享同一次目录初始化。 */
  private initialization: Promise<ModuleRuntimePluginSnapshot> | undefined

  constructor(options: ModuleRuntimePluginServiceOptions) {
    this.directory = new PluginDataDirectory(resolve(options.root))
    this.root = this.directory.path
    this.manager = options.manager
    this.development = options.development === true
    this.isBusy = options.isBusy ?? (() => false)
    this.grants = new PluginGrantStore(join(this.root, 'grants'))
    this.settings = new PluginSettingsStore(join(this.root, 'settings'))
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
    return this.withLock(async () => {
      const stored = readJsonFileStrict(join(this.root, 'registry.json'), {
        description: '插件注册表',
      validate: isRuntimeRegistry,
        maxBytes: 8 * 1024 * 1024,
        secureRecovery: true,
      })
      const registry: RuntimeRegistry = stored ? structuredClone(stored) : { formatVersion: 1, revision: 0, plugins: [] }
      let migrated = false
      for (const plugin of registry.plugins.filter(entry => entry.enabled)) {
        // 降级必须落盘；之后只授权/配置不能使旧 enabled 位在重启时复活。
        if (getPluginRuntimeExecutionBlock(plugin.manifest) || !this.hasGrant(plugin)) { plugin.enabled = false; migrated = true }
      }
      if (migrated) {
        registry.revision += 1
        this.persist(registry)
      }
      this.registry = registry
      const registered: string[] = []
      try {
        for (const plugin of registry.plugins.filter(entry => entry.enabled)) {
          const verified = this.verifyInstalledEntry(plugin)
          this.register({ manifest: verified.manifest, packageHash: plugin.packageHash, packageRoot: verified.packageRoot, prompts: verified.prompts })
          registered.push(plugin.manifest.id)
        }
      } catch (error) {
        await Promise.all(registered.map(id => this.manager.unregister(id)))
        throw error
      }
      return this.snapshot()
    })
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
    assertHostCompatibility(inspected.manifest)
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
      changes: pluginVersionChanges(previous, inspected.manifest),
      validation: assessPluginValidation({ pluginId: inspected.manifest.id, pluginVersion: inspected.manifest.version, packageHash: inspected.packageHash }, getPluginValidationEnvironment(), getHostPluginValidationRecords()),
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
      assertHostCompatibility(inspected.manifest)
      const previous = this.registry.plugins.find(plugin => plugin.manifest.id === inspected.manifest.id)
      if ((previous?.packageHash ?? null) !== pending.preview.changes.previousPackageHash) throw new Error('PLUGIN_PREVIEW_BASELINE_CHANGED')
      const changes = pluginVersionChanges(previous, inspected.manifest)
      if (changes.blockers.length) throw new Error(changes.blockers[0])
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
        enabled: false,
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
          this.register({
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
          this.register({
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
      if (enabled) {
        assertHostCompatibility(previous.manifest)
        this.grants.assertGranted(this.identity(previous))
        this.settings.assertReady(previous.manifest, previous.packageHash)
      }
      if (previous.enabled === enabled) return this.snapshot()
      if (enabled) {
        const verified = this.verifyInstalledEntry(previous)
        this.register({
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
          this.register({
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
          this.register({
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

  /** 单独确认精确包的能力和工作区；保存授权不自动启用。 */
  async authorize(pluginId: string, capabilities: PluginCapabilityId[], workspaceIds: string[], expectedRevision: number, expectedGrantRevision: number): Promise<ModuleRuntimePluginSnapshot> {
    this.assertIdle()
    return this.withLock(async () => {
      this.assertRevision(expectedRevision)
      const plugin = this.registry.plugins.find(entry => entry.manifest.id === pluginId)
      if (!plugin) throw new Error('PLUGIN_NOT_INSTALLED')
      if (plugin.enabled) throw new Error('PLUGIN_DISABLE_BEFORE_CONFIGURE')
      if (capabilities.some(capability => !plugin.manifest.capabilities.includes(capability))) throw new Error('PLUGIN_CAPABILITY_NOT_DECLARED')
      this.grants.set(this.identity(plugin), capabilities, workspaceIds, expectedGrantRevision)
      return this.snapshot()
    })
  }

  /** 设置更改要求先停用，确保 restart-runtime 和 next-run 都不会混用旧实例。 */
  async configureSettings(pluginId: string, values: Record<string, unknown>, expectedRevision: number, expectedSettingsRevision: number): Promise<ModuleRuntimePluginSnapshot> {
    this.assertIdle()
    return this.withLock(async () => {
      this.assertRevision(expectedRevision)
      const plugin = this.registry.plugins.find(entry => entry.manifest.id === pluginId)
      if (!plugin) throw new Error('PLUGIN_NOT_INSTALLED')
      if (plugin.enabled) throw new Error('PLUGIN_DISABLE_BEFORE_CONFIGURE')
      this.settings.save(plugin.manifest, plugin.packageHash, values, expectedSettingsRevision)
      return this.snapshot()
    })
  }

  /** 撤权不等待 Agent 空闲；先撤销租约依据，再终止本插件全部调用。 */
  async revoke(pluginId: string, expectedGrantRevision: number): Promise<ModuleRuntimePluginSnapshot> {
    return this.withLock(async () => {
      const plugin = this.registry.plugins.find(entry => entry.manifest.id === pluginId)
      if (!plugin) throw new Error('PLUGIN_NOT_INSTALLED')
      this.grants.revoke(pluginId, expectedGrantRevision)
      await this.manager.unregister(pluginId)
      const next: RuntimeRegistry = {
        ...this.registry, revision: this.registry.revision + 1,
        plugins: this.registry.plugins.map(entry => entry === plugin ? { ...entry, enabled: false } : entry),
      }
      this.persist(next)
      this.registry = next
      return this.snapshot()
    })
  }

  /** 只读GET在写锁外核验一次构建；mutation保持轻量保守快照，诊断不能延迟撤权。 */
  async validatedSnapshot(): Promise<ModuleRuntimePluginSnapshot> {
    const environment = await readPluginValidationEnvironment()
    const records = getHostPluginValidationRecords()
    const snapshot = this.snapshot()
    for (const plugin of snapshot.plugins) {
      if (plugin.management) plugin.management.validation = assessPluginValidation(this.identity(plugin), environment, records)
    }
    return snapshot
  }

  /** 同步诊断没有异步材料复核，保守返回构建未验证。 */
  snapshot(): ModuleRuntimePluginSnapshot {
    // 同步调用不读取完整负载；不将旧构建缓存成功值赋给新的管理快照。
    const environment = getPluginValidationEnvironment()
    const records = getHostPluginValidationRecords()
    return {
      revision: this.registry.revision,
      plugins: this.registry.plugins.map(plugin => {
        const grant = this.grants.get(plugin.manifest.id)
        let authorization: PluginRuntimeManagementView['authorization'] = grant?.revoked ? 'revoked' : 'required'
        try { this.grants.assertGranted(this.identity(plugin)); authorization = 'granted' } catch { /* 不从旧包或旧备份继承授权。 */ }
        const rawHealth = this.manager.getHealth(plugin.manifest.id)
        const management: PluginRuntimeManagementView = {
          authorization,
          validation: assessPluginValidation(this.identity(plugin), environment, records),
          health: { state: rawHealth.state, epoch: rawHealth.epoch,
            ...(rawHealth.errorCode ? { errorCode: /^PLUGIN_[A-Z_]{1,80}$/.test(rawHealth.errorCode) ? rawHealth.errorCode : 'PLUGIN_RUNTIME_FAILED' } : {}) },
        }
        return { ...structuredClone(plugin), executionBlock: getPluginRuntimeExecutionBlock(plugin.manifest), grant, management, settings: this.settings.read(plugin.manifest, plugin.packageHash) }
      }),
    }
  }

  /** 列出指定插件的不可变历史包，按版本从高到低返回。 */
  listVersions(pluginId: string): ArchivedRuntimePluginVersion[] {
    if (!PLUGIN_ID_PATTERN.test(pluginId)) throw new Error('PLUGIN_ID_INVALID')
    const directory = join(this.root, 'archives', pluginId)
    if (!existsSync(directory)) return []
    const state = lstatSync(directory)
    if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('PLUGIN_ARCHIVE_DIRECTORY_UNSAFE')
    const versions = readdirSync(directory)
      .filter(name => /^[a-f0-9]{64}\.ddplugin$/.test(name))
      .map((name): ArchivedRuntimePluginVersion => {
        const packageHash = name.slice(0, -'.ddplugin'.length)
        const inspected = inspectPluginPackage(readBoundedFile(join(directory, name), 50 * 1024 * 1024))
        if (inspected.manifest.formatVersion !== 3
          || inspected.manifest.id !== pluginId
          || inspected.packageHash !== packageHash) {
          throw new Error('PLUGIN_ARCHIVE_IDENTITY_CHANGED')
        }
        return {
          version: inspected.manifest.version,
          packageHash,
          signatureVerified: inspected.signatureVerified,
          changes: pluginVersionChanges(this.registry.plugins.find(plugin => plugin.manifest.id === pluginId), inspected.manifest),
          ...(inspected.signer ? { keyId: inspected.signer.keyId } : {}),
        }
      })
    return versions.sort((left, right) => {
      if (left.version === right.version) return left.packageHash.localeCompare(right.packageHash)
      return isHigherVersion(left.version, right.version) ? -1 : 1
    })
  }

  /** 将当前注册显式切换到一个已归档的不可变历史版本。 */
  async rollback(pluginId: string, packageHash: string, expectedRevision: number): Promise<ModuleRuntimePluginSnapshot> {
    this.assertIdle()
    return this.withLock(async () => {
      this.assertRevision(expectedRevision)
      if (!PLUGIN_ID_PATTERN.test(pluginId)) throw new Error('PLUGIN_ID_INVALID')
      if (!/^[a-f0-9]{64}$/.test(packageHash)) throw new Error('PLUGIN_PACKAGE_HASH_INVALID')
      const previous = this.registry.plugins.find(plugin => plugin.manifest.id === pluginId)
      if (!previous) throw new Error('PLUGIN_NOT_INSTALLED')
      if (previous.packageHash === packageHash) throw new Error('PLUGIN_ROLLBACK_TARGET_CURRENT')
      const archivePath = this.archivePath(pluginId, packageHash)
      if (!existsSync(archivePath)) throw new Error('PLUGIN_ROLLBACK_TARGET_NOT_FOUND')
      const inspected = inspectPluginPackage(readBoundedFile(archivePath, 50 * 1024 * 1024))
      if (inspected.manifest.formatVersion !== 3
        || inspected.manifest.id !== pluginId
        || inspected.packageHash !== packageHash) {
        throw new Error('PLUGIN_ARCHIVE_IDENTITY_CHANGED')
      }
      assertHostCompatibility(inspected.manifest)
      if (!this.development) {
        if (!inspected.signatureVerified || !previous.keyId || inspected.signer?.keyId !== previous.keyId) {
          throw new Error('PLUGIN_PUBLISHER_UNTRUSTED')
        }
      }
      const changes = pluginVersionChanges(previous, inspected.manifest)
      if (changes.blockers.length) throw new Error(changes.blockers[0])
      const materialized = materializeRuntimePluginPackage({
        root: this.root,
        manifest: inspected.manifest,
        packageHash: inspected.packageHash,
        files: inspected.files,
      })
      if (previous.enabled) await this.manager.unregister(pluginId)
      const entry: InstalledRuntimePlugin = {
        manifest: inspected.manifest,
        packageHash: inspected.packageHash,
        ...(inspected.signer ? { keyId: inspected.signer.keyId } : {}),
        enabled: false,
        installedAt: new Date().toISOString(),
        packageRoot: materialized.packageRoot,
      }
      const next: RuntimeRegistry = {
        formatVersion: 1,
        revision: this.registry.revision + 1,
        plugins: [...this.registry.plugins.filter(plugin => plugin.manifest.id !== pluginId), entry],
      }
      try {
        if (entry.enabled) {
          this.register({
            manifest: entry.manifest,
            packageHash: entry.packageHash,
            packageRoot: entry.packageRoot,
            prompts: materialized.prompts,
          })
        }
        this.persist(next)
      } catch (error) {
        if (entry.enabled) await this.manager.unregister(pluginId)
        if (previous.enabled) {
          const previousVerified = this.verifyInstalledEntry(previous)
          this.register({
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
    assertHostCompatibility(inspected.manifest)
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

  /** 每次注册都从当前包的已校验设置创建新实例快照。 */
  private register(plugin: ManagedRuntimePlugin): void {
    assertHostCompatibility(plugin.manifest)
    const settings = this.settings.assertReady(plugin.manifest, plugin.packageHash)
    const identity = structuredClone(plugin)
    this.manager.register({ ...plugin, settingsRevision: settings.revision, settings: settings.values }, () => {
      const current = this.registry.plugins.find(entry => entry.manifest.id === identity.manifest.id)
      if (!current?.enabled || current.packageHash !== identity.packageHash
        || current.packageRoot !== identity.packageRoot
        || JSON.stringify(current.manifest) !== JSON.stringify(identity.manifest)) throw new Error('PLUGIN_INSTALLED_IDENTITY_CHANGED')
      this.directory.assertCurrent()
      this.verifyInstalledEntry(current)
    })
  }

  private identity(plugin: InstalledRuntimePlugin) {
    return { pluginId: plugin.manifest.id, pluginVersion: plugin.manifest.version, packageHash: plugin.packageHash }
  }

  private hasGrant(plugin: InstalledRuntimePlugin): boolean {
    try {
      this.grants.assertGranted(this.identity(plugin))
      this.settings.assertReady(plugin.manifest, plugin.packageHash)
      return true
    } catch { return false }
  }

  /** 归档只由插件 ID 与包摘要推导，注册表不提供路径。 */
  private archivePath(pluginId: string, packageHash: string): string {
    return join(this.root, 'archives', pluginId, `${packageHash}.ddplugin`)
  }

  /** 单进程锁保护注册表读改写，避免同窗并发覆盖。 */
  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    this.directory.assertCurrent()
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
    this.directory.assertCurrent()
    writeJsonFileAtomicSecure(join(this.root, 'registry.json'), registry, { beforeRename: this.directory.assertCurrent })
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
