import { createHash } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { join, resolve } from 'node:path'

/** 明确的构建输出合同；新增生产入口必须更新这里，不能把未知 bundle 静默遗漏。 */
export const HOST_BUNDLE_FILES = [
  'main.cjs', 'agent-runtime.cjs', 'terminal-runtime.cjs', 'server-ops-runtime.cjs',
  'api-workbench-runtime.cjs', 'plugin-runtime.cjs', 'preload.cjs',
  'path-management-preload.cjs', 'default-root-migration-preload.cjs',
] as const
export interface HostBuildRuntime {
  hostVersion: string
  electron: string
  node: string
  modules: string
  platform: string
  arch: string
}
export interface HostBuildFile { path: string; kind: 'file' | 'directory'; bytes: number; executable: boolean; sha256?: string }
export interface HostBuildMaterial {
  contract: 'dutydeck-bundle-set-v1' | 'dutydeck-packaged-resources-v1'
  target: 'build-output' | 'packaged-main'
  runtime?: HostBuildRuntime
  files: HostBuildFile[]
  sha256: string
}
export interface HostBuildScanOptions {
  /** Electron 调用方必须传 original-fs，以读取 app.asar 原始字节而非虚拟目录。 */
  fs?: typeof nodeFs
  maxFiles?: number
  maxBytes?: number
}
export interface HostBuildStatus {
  status: 'available' | 'unavailable' | 'changed'
  hostBuildSha256?: string
  reason?: string
}

/** 有界、逐块读取，不跟随链接。它是材料摘要，不是对恶意并发写入的原子快照或签名认证。 */
function* scan(root: string, paths: readonly string[] | undefined, required: readonly string[], options: HostBuildScanOptions): Generator<void, HostBuildFile[]> {
  const fs = options.fs ?? nodeFs
  const directory = resolve(root)
  const rootStat = fs.lstatSync(directory)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('HOST_BUILD_ROOT_INVALID')
  const files: HostBuildFile[] = []
  const observations: Array<{ path: string; stat: nodeFs.Stats; children?: string[] }> = []
  const rootChildren = fs.readdirSync(directory).sort()
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  const same = (a: nodeFs.Stats, b: nodeFs.Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mode === b.mode && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.isFile() === b.isFile() && a.isDirectory() === b.isDirectory()
  const maxFiles = options.maxFiles ?? 150_000
  const maxBytes = options.maxBytes ?? 8 * 1024 ** 3
  let total = 0
  function* visit(path: string, depth: number): Generator<void> {
    if (depth > 64 || files.length >= maxFiles) throw new Error('HOST_BUILD_BUDGET_EXCEEDED')
    const full = join(directory, path)
    const stat = fs.lstatSync(full)
    if (stat.isSymbolicLink()) throw new Error('HOST_BUILD_LINK_UNSUPPORTED')
    if (stat.isDirectory()) {
      files.push({ path, kind: 'directory', bytes: 0, executable: false })
      const children = fs.readdirSync(full).sort()
      observations.push({ path: full, stat, children })
      yield
      for (const child of children) yield* visit(`${path}/${child}`, depth + 1)
      const current = fs.lstatSync(full)
      if (!current.isDirectory() || current.ino !== stat.ino || current.dev !== stat.dev
        || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs
        || JSON.stringify(fs.readdirSync(full).sort()) !== JSON.stringify(children)) throw new Error('HOST_BUILD_SCAN_CHANGED')
    } else if (stat.isFile()) {
      total += stat.size
      if (!Number.isSafeInteger(total) || total > maxBytes) throw new Error('HOST_BUILD_BUDGET_EXCEEDED')
      const fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
      try {
        const before = fs.fstatSync(fd)
        if (!before.isFile() || before.ino !== stat.ino || before.dev !== stat.dev || before.size !== stat.size) throw new Error('HOST_BUILD_SCAN_CHANGED')
        const hash = createHash('sha256')
        let bytes = 0
        for (;;) {
          const count = fs.readSync(fd, buffer, 0, buffer.length, null)
          if (!count) break
          bytes += count
          if (bytes > stat.size) throw new Error('HOST_BUILD_SCAN_CHANGED')
          hash.update(buffer.subarray(0, count))
          yield
        }
        const after = fs.fstatSync(fd); const current = fs.lstatSync(full)
        if (bytes !== stat.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
          || current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev || current.size !== before.size) throw new Error('HOST_BUILD_SCAN_CHANGED')
        observations.push({ path: full, stat: before })
        files.push({ path, kind: 'file', bytes, executable: (stat.mode & 0o111) !== 0, sha256: hash.digest('hex') })
      } finally { fs.closeSync(fd) }
    } else throw new Error('HOST_BUILD_SPECIAL_FILE')
  }
  for (const path of required) {
    let stat: nodeFs.Stats
    try { stat = fs.lstatSync(join(directory, path)) } catch { throw new Error('HOST_BUILD_REQUIRED_FILE') }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error('HOST_BUILD_REQUIRED_FILE')
  }
  for (const path of [...(paths ?? rootChildren)].sort()) yield* visit(path, 0)
  // 全树读取结束后重新检查已经读过的文件，捕获后段扫描时的普通原地修改。
  // 元信息仅用于检测扫描期变化，不能替代内容hash，也不宣称是抗恶意并发写入的快照。
  for (const observed of observations) {
    const current = fs.lstatSync(observed.path)
    if (!same(observed.stat, current) || observed.children && JSON.stringify(fs.readdirSync(observed.path).sort()) !== JSON.stringify(observed.children)) throw new Error('HOST_BUILD_SCAN_CHANGED')
  }
  if (!same(rootStat, fs.lstatSync(directory)) || JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(rootChildren)) throw new Error('HOST_BUILD_SCAN_CHANGED')
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

function finish(scan: Generator<void, HostBuildFile[]>): HostBuildFile[] {
  for (;;) { const next = scan.next(); if (next.done) return next.value }
}

async function finishAsync(scan: Generator<void, HostBuildFile[]>): Promise<HostBuildFile[]> {
  for (;;) {
    const next = scan.next(); if (next.done) return next.value
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

function material(contract: HostBuildMaterial['contract'], target: HostBuildMaterial['target'], files: HostBuildFile[], runtime?: HostBuildRuntime): HostBuildMaterial {
  // 不采纳调用方的键顺序、额外字段、绝对路径、mtime 或生成时间。
  const environment = runtime ? { hostVersion: runtime.hostVersion, electron: runtime.electron, node: runtime.node, modules: runtime.modules, platform: runtime.platform, arch: runtime.arch } : undefined
  const body = { contract, target, ...(environment ? { runtime: environment } : {}), files }
  return { ...body, sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') }
}

/** 开发/构建目录仅提供 bundle-set 诊断；不覆盖 external、Vite HMR 或 extraResources，绝不提升为 hostBuildSha256。 */
export function captureBundleSet(distRoot: string, options: HostBuildScanOptions = {}): HostBuildMaterial {
  const fs = options.fs ?? nodeFs
  const known = new Set<string>(HOST_BUNDLE_FILES)
  for (const entry of fs.readdirSync(distRoot)) {
    if (/\.(?:cjs|mjs|js)$/.test(entry) && !known.has(entry) && !entry.endsWith('-smoke.cjs')) throw new Error('HOST_BUILD_UNKNOWN_BUNDLE')
  }
  return material('dutydeck-bundle-set-v1', 'build-output', finish(scan(distRoot, [...HOST_BUNDLE_FILES, 'renderer'], [...HOST_BUNDLE_FILES, 'renderer/index.html'], options)))
}

/**
 * 最终 packaged resources 负载：原始 app.asar（含实际 external 布局）、全部 unpacked 和 extraResources。
 * 不排除 evidence/sidecar，不从源码/lockfile推断，不认证 Electron framework、OS、用户配置或安装目录外的动态加载。
 * 缺失 ASAR、链接或不支持布局直接失败。调用者必须证明此根对应当前 packaged main。
 */
export function capturePackagedPayload(resourcesRoot: string, runtime: HostBuildRuntime, options: HostBuildScanOptions = {}): HostBuildMaterial {
  if (Object.values(runtime).some(value => typeof value !== 'string' || !value || value === 'unknown')) throw new Error('HOST_BUILD_RUNTIME_UNKNOWN')
  return material('dutydeck-packaged-resources-v1', 'packaged-main', finish(scan(resourcesRoot, undefined, ['app.asar'], options)), runtime)
}

/** 同一摘要合同的分段版本：至多读取1 MiB后让出事件循环；仍含同步IO和最终元信息复核，不承诺硬实时响应。 */
export async function capturePackagedPayloadAsync(resourcesRoot: string, runtime: HostBuildRuntime, options: HostBuildScanOptions = {}): Promise<HostBuildMaterial> {
  if (Object.values(runtime).some(value => typeof value !== 'string' || !value || value === 'unknown')) throw new Error('HOST_BUILD_RUNTIME_UNKNOWN')
  return material('dutydeck-packaged-resources-v1', 'packaged-main', await finishAsync(scan(resourcesRoot, undefined, ['app.asar'], options)), runtime)
}

/** 启动时固定基线；每次取有效身份重读内容，变化/失败后永久撤销，不能把新磁盘赋给旧进程。 */
export class HostBuildIdentitySession {
  private baseline?: string
  private invalid?: HostBuildStatus
  private readonly ready: Promise<void>
  private pending?: Promise<HostBuildStatus>
  constructor(private readonly capture: () => HostBuildMaterial | Promise<HostBuildMaterial>) {
    this.ready = this.initialize()
  }
  private async initialize(): Promise<void> {
    try {
      const first = await this.capture(); const second = await this.capture()
      if (first.contract !== 'dutydeck-packaged-resources-v1' || first.target !== 'packaged-main' || first.sha256 !== second.sha256) throw new Error('HOST_BUILD_BASELINE_UNVERIFIED')
      this.baseline = first.sha256
    } catch { this.invalid = { status: 'unavailable', reason: 'HOST_BUILD_BASELINE_UNVERIFIED' } }
  }
  async current(): Promise<HostBuildStatus> {
    await this.ready
    if (this.invalid) return { ...this.invalid }
    // 仅合并重叠请求，不缓存成功结果；后续请求仍检查全部内容。
    this.pending ??= this.verify().finally(() => { this.pending = undefined })
    return { ...await this.pending }
  }
  private async verify(): Promise<HostBuildStatus> {
    try {
      if ((await this.capture()).sha256 === this.baseline) return { status: 'available', hostBuildSha256: this.baseline }
    } catch { /* 损坏、缺失或权限变化同样撤销，不回退到缓存 hash。 */ }
    this.invalid = { status: 'changed', reason: 'HOST_BUILD_CHANGED_RESTART_REQUIRED' }
    return { ...this.invalid }
  }
}
