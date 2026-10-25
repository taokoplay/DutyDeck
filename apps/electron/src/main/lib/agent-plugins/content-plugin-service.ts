import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync, linkSync, unlinkSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { getModuleId, getSkillId, parsePluginManifest, RESOURCE_LIMITS } from '@dutydeck/plugin-sdk';
import type { PluginPackageManifest, ValidatedPluginResource } from '@dutydeck/plugin-sdk';
import { inspectPluginPackage } from '@dutydeck/plugin-kit/package';
import { readAtomicFileState, writeJsonFileAtomicSecure } from '../safe-file';

/** 序列化管理合同统一由 shared 提供，服务不再维护另一份字段定义。 */
import type { ContentResourceSummary, InstalledContentPlugin, ContentPluginSnapshot, ContentPluginPreview } from '@dutydeck/shared';
export type { ContentResourceSummary, InstalledContentPlugin, ContentPluginSnapshot, ContentPluginPreview } from '@dutydeck/shared';
/** 仅显式选中模块返回完整资源。 */
export interface ResolvedContentModule { pluginId: string; version: string; packageHash: string; moduleId: string; resources: ValidatedPluginResource[] }
/** 开发模式必须主动选择，并使用隔离目录。 */
export interface ContentPluginServiceOptions { development?: boolean }
/** 持久化格式与业务修订号独立。 */
interface Registry extends ContentPluginSnapshot { formatVersion: 2 }
/** 预览只保留原始字节，不缓存解压后的资源正文。 */
interface PendingPreview { preview: ContentPluginPreview; bytes: Uint8Array; expiresAt: number }
/** 包大小和缓存总量边界，避免恶意源消耗无限内存。 */
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
/** 注册表只存摘要，保持独立的小预算。 */
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;

/** 读取明确路径的普通文件；有限读取、不跟随链接、绑定 inode。 */
function readBounded(path: string, maximum: number): Uint8Array {
  const before = lstatSync(path);
  if (!before.isFile()) throw new Error('插件路径必须是普通文件，不能为链接');
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size > maximum) throw new Error('插件文件身份变化或超过预算');
    const chunks: Buffer[] = [];
    let length = 0;
    while (length <= maximum) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, maximum + 1 - length));
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (!count) break;
      chunks.push(chunk.subarray(0, count)); length += count;
    }
    if (length > maximum) throw new Error('插件文件超过预算');
    return Buffer.concat(chunks, length);
  } finally { closeSync(descriptor); }
}
/** 逐级验证目录，拒绝任何祖先符号链接；仅按需创建缺失目录。 */
function secureDirectory(path: string, create = false): void {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if (parent !== absolute) secureDirectory(parent, create);
  try { if (!lstatSync(absolute).isDirectory()) throw new Error('插件目录不能为链接或文件'); }
  catch (error) {
    if (!missing(error) || !create) throw error;
    mkdirSync(absolute, { mode: 0o700 });
  }
}
/** 仅 ENOENT 是新安装，不吞掉权限和 IO 错误。 */
function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
/** 判断注册表普通 JSON 对象。 */
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
/** SHA-256 绑定不可变包，不信任磁盘文件名。 */
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
/** 将校验后资源转换为无正文的 UI 摘要。 */
function summarize(resources: ValidatedPluginResource[]): ContentResourceSummary[] { return resources.map(({ content: _content, ...summary }) => summary); }
/** 严格核对摘要与清单声明，禁止未知资源、重复资源、跨模块归属和伪造字节预算。 */
function validSummaries(manifest: PluginPackageManifest, summaries: unknown[]): boolean {
  /** 按 SDK 相同顺序推导身份，避免将注册表中的资源路径直接作为权威。 */
  const expected = [
    ...manifest.skills.map(entry => ({ entry, kind: 'skill' as const })),
    ...manifest.prompts.map(entry => ({ entry, kind: 'prompt' as const })),
    ...(manifest.styles ?? []).map(entry => ({ entry, kind: 'style' as const })),
  ];
  if (summaries.length !== expected.length) return false;
  /** 汇总提示资源；设计资源按 SDK 单文件预算分别验证。 */
  let promptBytes = 0;
  for (let index = 0; index < expected.length; index++) {
    const { entry, kind } = expected[index]!;
    const summary = summaries[index];
    const id = kind === 'skill' ? getSkillId(manifest.id, entry.id) : `${manifest.id}/${kind}s/${entry.id}`;
    const owners = manifest.modules.filter(module => kind === 'skill' ? module.skills.includes(entry.id) : kind === 'prompt' ? module.prompts.includes(entry.id) : module.styles?.includes(entry.id)).map(module => getModuleId(manifest.id, module.id));
    const maximum = kind === 'skill' ? RESOURCE_LIMITS.skillBytes : kind === 'prompt' ? RESOURCE_LIMITS.promptBytes : 32768;
    if (!record(summary) || Object.keys(summary).sort().join() !== 'byteLength,id,kind,ownerModuleIds,path,version'
      || summary.id !== id || summary.kind !== kind || summary.path !== entry.path || summary.version !== entry.version
      || JSON.stringify(summary.ownerModuleIds) !== JSON.stringify(owners) || !Number.isSafeInteger(summary.byteLength)
      || (summary.byteLength as number) < 0 || (summary.byteLength as number) > maximum) return false;
    if (kind === 'prompt') promptBytes += summary.byteLength as number;
  }
  return promptBytes <= RESOURCE_LIMITS.totalPromptBytes;
}
/** 按 SDK 单轮约束核算已去重资源；设计约束与其它提示共用非 Skill 预算。 */
function assertTurnBudget(resources: ContentResourceSummary[]): void {
  /** Skill 与提示分别计量，避免一方占用另一方的预算。 */
  let skillBytes = 0;
  let promptBytes = 0;
  for (const resource of resources) {
    if (resource.kind === 'skill') skillBytes += resource.byteLength;
    else promptBytes += resource.byteLength;
  }
  if (skillBytes > RESOURCE_LIMITS.turnSkillBytes || promptBytes > RESOURCE_LIMITS.turnPromptBytes) throw new Error('插件模块资源超过本轮预算');
}
/** SemVer 排序含预发布语义，build 元数据不构成升级。 */
function compareVersion(left: string, right: string): number {
  const [leftCore, leftPre] = left.split('+')[0]!.split(/-(.*)/s);
  const [rightCore, rightPre] = right.split('+')[0]!.split(/-(.*)/s);
  const a = leftCore!.split('.').map(BigInt); const b = rightCore!.split('.').map(BigInt);
  for (let index = 0; index < 3; index++) { if (a[index]! !== b[index]!) return a[index]! > b[index]! ? 1 : -1; }
  if (leftPre === undefined || rightPre === undefined) return leftPre === rightPre ? 0 : leftPre === undefined ? 1 : -1;
  const x = leftPre.split('.'); const y = rightPre.split('.');
  for (let index = 0; index < Math.max(x.length, y.length); index++) {
    const first = x[index]; const second = y[index];
    if (first === second) continue;
    if (first === undefined || second === undefined) return first === undefined ? -1 : 1;
    const numericFirst = /^\d+$/.test(first); const numericSecond = /^\d+$/.test(second);
    if (numericFirst && numericSecond) return BigInt(first) > BigInt(second) ? 1 : -1;
    if (numericFirst !== numericSecond) return numericFirst ? -1 : 1;
    return first > second ? 1 : -1;
  }
  return 0;
}

/** 本地纯内容插件宿主；不解压、不执行代码、不修改工作区 Skills。 */
export class ContentPluginService {
  /** 生产与开发注册表根严格分离。 */
  readonly root: string;
  /** 已批准选择的源快照，安装时不重读源文件。 */
  private readonly previews = new Map<string, PendingPreview>();
  /** 创建服务不写文件，便于只读查询和坏状态拒绝。 */
  constructor(root: string, private readonly isBusy: () => boolean = () => false, private readonly options: ContentPluginServiceOptions = {}) {
    this.root = resolve(root, options.development ? 'development' : '.');
  }
  /** 返回纯 metadata，不读取任何未选中模块正文。 */
  snapshot(): ContentPluginSnapshot { const state = this.readRegistry(); return { revision: state.revision, plugins: structuredClone(state.plugins) }; }
  /** 从原生 picker 授权路径冻结字节并校验，返回一次性信任确认 token。 */
  preview(path: string): ContentPluginPreview {
    return this.previewBytes(readBounded(path, MAX_PACKAGE_BYTES));
  }
  /** 对拖放或选择器提供的精确字节做校验，不依赖可变的源路径。 */
  previewBytes(bytes: Uint8Array): ContentPluginPreview {
    if (bytes.byteLength > MAX_PACKAGE_BYTES) throw new Error('插件包超过大小限制');
    const state = this.readRegistry();
    for (const [token, pending] of this.previews) if (pending.expiresAt < Date.now()) this.previews.delete(token);
    if (this.previews.size >= 8) throw new Error('插件预览数量超过预算');
    const frozenBytes = Uint8Array.from(bytes);
    if ([...this.previews.values()].reduce((total, entry) => total + entry.bytes.byteLength, bytes.byteLength) > MAX_PACKAGE_BYTES) throw new Error('插件预览缓存超过预算');
    const inspected = inspectPluginPackage(frozenBytes);
    if (inspected.manifest.formatVersion !== 2) throw new Error('PLUGIN_CONTENT_REQUIRED');
    this.checkCompatibility(inspected.manifest);
    if (!inspected.signatureVerified && !this.options.development) throw new Error('生产环境只允许已签名插件');
    const previous = state.plugins.find(entry => entry.manifest.id === inspected.manifest.id);
    const preview: ContentPluginPreview = { token: randomUUID(), revision: state.revision, operation: previous ? 'update' : 'install', ...(previous ? { previousVersion: previous.manifest.version } : {}), manifest: inspected.manifest, packageHash: inspected.packageHash, signatureVerified: inspected.signatureVerified, ...(inspected.signer ? { signer: inspected.signer } : {}), resources: summarize(inspected.resources.resources) };
    this.previews.set(preview.token, { preview: structuredClone(preview), bytes: frozenBytes, expiresAt: Date.now() + 10 * 60 * 1000 });
    return preview;
  }
  /** 安装精确预览版本；首次签名信任必须由 UI 明确传入匹配 keyId。 */
  install(token: string, trustedKeyId?: string): ContentPluginSnapshot {
    const pending = this.previews.get(token);
    if (!pending || pending.expiresAt < Date.now()) throw new Error('插件预览已失效，请重新选择');
    const result = this.mutate(pending.preview.revision, state => {
      const inspected = inspectPluginPackage(pending.bytes);
      if (inspected.packageHash !== pending.preview.packageHash || hash(pending.bytes) !== inspected.packageHash) throw new Error('插件预览字节已变化');
      if (inspected.manifest.formatVersion !== 2) throw new Error('PLUGIN_CONTENT_REQUIRED');
      this.checkCompatibility(inspected.manifest);
      const keyId = inspected.signer?.keyId;
      const previous = state.plugins.find(entry => entry.manifest.id === inspected.manifest.id);
      if (inspected.signatureVerified) {
        if (!keyId || (previous ? previous.keyId !== keyId : trustedKeyId !== keyId)) throw new Error('发布者密钥未明确受信任或发生替换');
      } else if (!this.options.development || previous?.keyId) throw new Error('不允许未签名插件或身份替换');
      if (previous && compareVersion(inspected.manifest.version, previous.manifest.version) <= 0) throw new Error('插件更新必须使用更高版本，禁止同版本替换或降级');
      const installed: InstalledContentPlugin = { manifest: inspected.manifest, packageHash: inspected.packageHash, ...(keyId ? { keyId } : {}), enabled: previous?.enabled ?? true, installedAt: new Date().toISOString(), resources: summarize(inspected.resources.resources) };
      this.persistPackage(installed, pending.bytes);
      state.plugins = [...state.plugins.filter(entry => entry.manifest.id !== installed.manifest.id), installed];
    });
    this.previews.delete(token); return result;
  }
  /** 修改准入开关；忙碌或旧修订号时拒绝。 */
  setEnabled(pluginId: string, enabled: boolean, expectedRevision: number): ContentPluginSnapshot {
    if (typeof enabled !== 'boolean') throw new Error('插件开关无效');
    return this.mutate(expectedRevision, state => { const plugin = state.plugins.find(entry => entry.manifest.id === pluginId); if (!plugin) throw new Error('插件未安装'); plugin.enabled = enabled; });
  }
  /** 卸载只撤销注册表准入，保留历史包及一切外部用户数据。 */
  uninstall(pluginId: string, expectedRevision: number): ContentPluginSnapshot {
    return this.mutate(expectedRevision, state => { if (!state.plugins.some(entry => entry.manifest.id === pluginId)) throw new Error('插件未安装'); state.plugins = state.plugins.filter(entry => entry.manifest.id !== pluginId); });
  }
  /** 显式模块接入时重新验证包摘要、签名身份与资源绑定。 */
  resolveModule(moduleId: string): ResolvedContentModule {
    return this.resolveModules([moduleId])[0]!;
  }
  /** 一轮内按包去重读取和验证；无选择不读注册表，不保留跨轮正文缓存。 */
  resolveModules(moduleIds: readonly string[]): ResolvedContentModule[] {
    if (!moduleIds.length) return [];
    /** 冻结本轮准入与显式选择，读取包之前检查所有声明预算。 */
    const plugins = this.readRegistry().plugins;
    const selected = [...new Set(moduleIds)].map(moduleId => {
      const plugin = plugins.find(entry => entry.enabled && entry.manifest.modules.some(module => getModuleId(entry.manifest.id, module.id) === moduleId));
      if (!plugin) throw new Error('模块未安装或已关闭');
      return { plugin, moduleId };
    });
    /** 全限定资源 ID 去重，多个模块共享提示只计算一次。 */
    const summaries = new Map<string, ContentResourceSummary>();
    for (const { plugin, moduleId } of selected) for (const resource of plugin.resources) {
      if (resource.ownerModuleIds.includes(moduleId)) summaries.set(resource.id, resource);
    }
    assertTurnBudget([...summaries.values()]);
    /** 仅缓存本轮选中资源，不能持有解压 files 或按不同身份共用 hash 缓存。 */
    const verified = new Map<string, ValidatedPluginResource[]>();
    /** 即使内容正文很小，包内附带资源的累计读取也必须有界。 */
    let packageBytes = 0;
    for (const { plugin } of selected) {
      if (verified.has(plugin.manifest.id)) continue;
      secureDirectory(dirname(this.packagePath(plugin)));
      const bytes = readBounded(this.packagePath(plugin), MAX_PACKAGE_BYTES - packageBytes);
      packageBytes += bytes.byteLength;
      const inspected = inspectPluginPackage(bytes);
      if (inspected.manifest.formatVersion !== 2) throw new Error('PLUGIN_CONTENT_REQUIRED');
      if (hash(bytes) !== plugin.packageHash || inspected.packageHash !== plugin.packageHash || JSON.stringify(inspected.manifest) !== JSON.stringify(plugin.manifest) || inspected.signer?.keyId !== plugin.keyId || (!inspected.signatureVerified && !this.options.development)) throw new Error('插件包身份或签名校验失败');
      this.checkCompatibility(inspected.manifest);
      /** 正文必须与持久化摘要完全一致，防止人为缩小摘要绕过预检。 */
      if (JSON.stringify(summarize(inspected.resources.resources)) !== JSON.stringify(plugin.resources)) throw new Error('插件资源摘要与包内容不一致');
      const owners = new Set(selected.filter(entry => entry.plugin.manifest.id === plugin.manifest.id).map(entry => entry.moduleId));
      const resources = inspected.resources.resources.filter(resource => resource.ownerModuleIds.some(owner => owners.has(owner)));
      verified.set(plugin.manifest.id, resources);
    }
    return selected.map(({ plugin, moduleId }) => ({ pluginId: plugin.manifest.id, version: plugin.manifest.version, packageHash: plugin.packageHash, moduleId, resources: verified.get(plugin.manifest.id)!.filter(resource => resource.ownerModuleIds.includes(moduleId)) }));
  }

  /** 平台兼容性必须在接入前验证，不把包内声明当建议。 */
  private checkCompatibility(manifest: PluginPackageManifest): void {
    if (!manifest.compatibility.platforms.some(platform => platform === process.platform) || !manifest.compatibility.architectures.some(architecture => architecture === process.arch)) throw new Error('插件不支持当前平台或架构');
  }
  /** 路径完全由严格校验的 ID、SemVer 与 SHA-256 推导。 */
  private packagePath(plugin: InstalledContentPlugin): string { return join(this.root, 'packages', plugin.manifest.id, plugin.manifest.version, `${plugin.packageHash}.ddplugin`); }
  /** 注册表无备份降级，损坏时 fail closed。 */
  private readRegistry(): Registry {
    try { secureDirectory(this.root); } catch (error) { if (missing(error)) return { formatVersion: 2, revision: 0, plugins: [] }; throw error; }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readBounded(join(this.root, 'registry.v2.json'), MAX_REGISTRY_BYTES))); }
    catch (error) { if (missing(error)) return { formatVersion: 2, revision: 0, plugins: [] }; throw error; }
    if (!record(value) || value.formatVersion !== 2 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !Array.isArray(value.plugins) || Object.keys(value).some(key => !['formatVersion', 'revision', 'plugins'].includes(key))) throw new Error('插件注册表损坏');
    const identities = new Set<string>();
    for (const plugin of value.plugins) {
      if (!record(plugin) || Object.keys(plugin).some(key => !['manifest', 'packageHash', 'keyId', 'enabled', 'installedAt', 'resources'].includes(key))) throw new Error('插件注册表条目损坏');
      const manifest = parsePluginManifest(plugin.manifest);
      if (!manifest.ok || identities.has(manifest.value.id) || typeof plugin.packageHash !== 'string' || !/^[a-f0-9]{64}$/.test(plugin.packageHash) || typeof plugin.enabled !== 'boolean' || typeof plugin.installedAt !== 'string' || !Number.isFinite(Date.parse(plugin.installedAt)) || (plugin.keyId !== undefined && (typeof plugin.keyId !== 'string' || !/^[a-f0-9]{64}$/.test(plugin.keyId))) || (!this.options.development && !plugin.keyId) || !Array.isArray(plugin.resources)) throw new Error('插件注册表条目损坏');
      identities.add(manifest.value.id);
      if (!validSummaries(manifest.value, plugin.resources)) throw new Error('插件资源摘要损坏');
    }
    return value as unknown as Registry;
  }
  /** 跨实例独占锁配合原子 CAS；崩溃遗留锁明确阻止写入，不按超时删除。 */
  private mutate(expectedRevision: number, change: (state: Registry) => void): ContentPluginSnapshot {
    if (this.isBusy()) throw new Error('宿主忙碌，插件变更被拒绝');
    secureDirectory(this.root, true);
    const lockPath = join(this.root, '.mutation.lock');
    try { mkdirSync(lockPath, { mode: 0o700 }); } catch { throw new Error('插件写入锁被占用，需要先处理正在运行或异常退出的实例'); }
    /** 仅释放本事务创建的锁，避免移除被替换的目录。 */
    const ownedLock = lstatSync(lockPath);
    try {
      const statePath = join(this.root, 'registry.v2.json');
      const rootIdentity = lstatSync(this.root);
      const lockIdentity = lstatSync(lockPath);
      const expected = readAtomicFileState(statePath);
      const state = this.readRegistry();
      if (!Number.isSafeInteger(expectedRevision) || state.revision !== expectedRevision) throw new Error('插件注册表修订号过期');
      change(state);
      if (this.isBusy()) throw new Error('宿主忙碌，插件变更被拒绝');
      secureDirectory(this.root);
      const currentRoot = lstatSync(this.root);
      const currentLock = lstatSync(lockPath);
      if (currentRoot.ino !== rootIdentity.ino || currentRoot.dev !== rootIdentity.dev || currentLock.ino !== lockIdentity.ino || currentLock.dev !== lockIdentity.dev) throw new Error('插件事务目录身份已变化');
      if (state.revision >= Number.MAX_SAFE_INTEGER) throw new Error('插件修订号已达到上限');
      state.revision++;
      /** 与安全原子写封装使用完全一致的缩进编码，防止写出下一次无法读取的状态。 */
      if (Buffer.byteLength(JSON.stringify(state, null, 2), 'utf8') > MAX_REGISTRY_BYTES) throw new Error('插件注册表超过预算');
      writeJsonFileAtomicSecure(statePath, state, { expectedDestination: expected ? { kind: 'state', state: expected } : { kind: 'missing' } });
      return { revision: state.revision, plugins: structuredClone(state.plugins) };
    } finally {
      try {
        const current = lstatSync(lockPath);
        if (current.isDirectory() && current.ino === ownedLock.ino && current.dev === ownedLock.dev) rmdirSync(lockPath);
      } catch (error) { if (!missing(error)) throw error; }
    }
  }
  /** 先落盘临时包再以 hard link 原子发布，永不覆盖已存在路径。 */
  private persistPackage(plugin: InstalledContentPlugin, bytes: Uint8Array): void {
    const destination = this.packagePath(plugin);
    secureDirectory(dirname(destination), true);
    try { const existing = readBounded(destination, MAX_PACKAGE_BYTES); if (hash(existing) !== plugin.packageHash) throw new Error('已有插件包损坏'); return; } catch (error) { if (!missing(error)) throw error; }
    const temporary = join(dirname(destination), `.${randomUUID()}.tmp`);
    const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
      secureDirectory(dirname(destination));
      linkSync(temporary, destination);
    } finally { unlinkSync(temporary); }
    if (process.platform !== 'win32') { const directory = openSync(dirname(destination), constants.O_RDONLY); try { fsyncSync(directory); } finally { closeSync(directory); } }
  }
}
