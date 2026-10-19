import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeAgentSessionModulePolicy } from '../packages/shared/src/index'
import { ContentPluginService } from '../apps/electron/src/main/lib/agent-plugins/content-plugin-service'
import { ContentPluginManager } from '../apps/electron/src/main/lib/agent-plugins/content-plugin-manager'
import { AgentPluginRegistry } from '../apps/electron/src/main/lib/agent-modules/plugin-registry'
import { resolveActiveModuleContext, setAgentModuleRuntimeCatalog, setPackageModuleResolver } from '../apps/electron/src/main/lib/agent-modules/module-skill-resolver'

/** 已完成检查的可持久化摘要，不保存私钥或作者敏感正文。 */
interface SmokeEvidence {
  completedAt: string
  repoRoot: string
  temporaryRoot: string
  tarballs: Array<{ name: string; sha256: string; path: string }>
  installedPackages: Array<{ name: string; realPath: string; independent: boolean }>
  publisherFingerprint: string
  versions: Array<{ version: string; packageHash: string; injectedResources: number }>
  checks: string[]
  cleaned: boolean
}
/** 测试仅依赖本仓库已构建的 SDK/CLI 发行文件；作者工程在仓库外。 */
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 使用真实路径避免 macOS /tmp 别名触发宿主目录防护。 */
const temporaryRoot = realpathSync(mkdtempSync('/private/tmp/dutydeck-plugin-author-'))
/** 包文件与外部作者目录分离，作者只依赖 tarball。 */
const artifacts = join(temporaryRoot, 'tarballs')
/** 保留通过验收的实际分发包，供用户离线安装；此目录已被 Git 忽略。 */
const deliveryDirectory = join(repository, 'dist/plugin-tools')
const author = join(temporaryRoot, 'author')
const cache = join(temporaryRoot, 'bun-cache')
/** Bun 默认发行文件名由包名和当前版本确定，避免升级工具后 smoke 失效。 */
const tarballPaths = new Map<string, string>()
const evidencePath = '/private/tmp/dutydeck-plugin-author-evidence.json'
/** 摘要逐步记录，仅全部成功后才写出通过证据。 */
const evidence: SmokeEvidence = { completedAt: '', repoRoot: repository, temporaryRoot, tarballs: [], installedPackages: [], publisherFingerprint: '', versions: [], checks: [], cleaned: false }
/** 运行独立子进程，失败时保留命令和输出；没有 shell 插值和网络模型调用。 */
function execute(args: string[], cwd: string): string {
  const result = Bun.spawnSync(args, { cwd, env: { ...process.env, BUN_INSTALL_CACHE_DIR: cache, TMPDIR: temporaryRoot }, stdout: 'pipe', stderr: 'pipe' })
  const stdout = new TextDecoder().decode(result.stdout)
  const stderr = new TextDecoder().decode(result.stderr)
  if (result.exitCode !== 0) throw new Error(`${args.join(' ')}\n${stdout}\n${stderr}`)
  return stdout.trim()
}
/** 校验调用输出是 JSON 对象，避免把 CLI 的日志误当成功摘要。 */
function objectOutput(output: string): Record<string, unknown> {
  const value: unknown = JSON.parse(output)
  assert(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
/** 根据准确字节生成发行包证据。 */
function digest(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex') }
/** 只调用外部作者自己 node_modules 内安装的 bin，不借用仓库 CLI。 */
function authorCli(...args: string[]): string { return execute([process.execPath, join(author, 'node_modules/.bin/dutydeck-plugin'), ...args], author) }
/** 将样板正文和版本改成作者自己的两次发行，资源版本与 frontmatter 一致。 */
function authorVersion(version: string, marker: string): void {
  const manifestPath = join(author, 'plugin/plugin.json')
  const manifest = objectOutput(readFileSync(manifestPath, 'utf8'))
  manifest.version = version
  for (const field of ['skills', 'prompts']) {
    const entries = manifest[field]
    assert(Array.isArray(entries))
    for (const entry of entries as Array<Record<string, unknown>>) entry.version = version
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  for (const relativePath of ['skills/assist/SKILL.md', 'prompts/workflow.md']) {
    const path = join(author, 'plugin', relativePath)
    const content = readFileSync(path, 'utf8').replace(/^version: .*$/m, `version: ${version}`).replace(/\n作者验收标记：[^\n]+/g, '')
    writeFileSync(path, `${content.trimEnd()}\n\n作者验收标记：${marker}\n`)
  }
}
/** 真正生产模块解析器的统一输入，整个生命周期不替换宿主实现。 */
const input = { sessionId: 'external-author-smoke', policy: normalizeAgentSessionModulePolicy({}), explicitModuleIds: ['acme.external.assistant'] }

try {
  for (const directory of [artifacts, author, cache]) mkdirSync(directory)
  for (const name of ['plugin-sdk', 'plugin-kit']) {
    assert(existsSync(join(repository, 'packages', name, 'dist/index.js')), '请先构建 SDK 和 plugin-kit')
    const metadata = objectOutput(readFileSync(join(repository, 'packages', name, 'package.json'), 'utf8'))
    assert.equal(typeof metadata.version, 'string')
    const filename = `dutydeck-${name}-${metadata.version as string}.tgz`
    tarballPaths.set(name, join(artifacts, filename))
    execute([process.execPath, 'pm', 'pack', '--ignore-scripts', '--destination', artifacts], join(repository, 'packages', name))
    evidence.tarballs.push({ name, sha256: digest(join(artifacts, filename)), path: join(deliveryDirectory, filename) })
  }
  /** 尚未发布 registry 的 SDK 用作者工程 override 指向真实 tarball；不改发行包依赖合同。 */
  writeFileSync(join(author, 'package.json'), JSON.stringify({ name: 'external-plugin-author-verification', private: true, type: 'module', dependencies: {
    '@dutydeck/plugin-sdk': `file:${tarballPaths.get('plugin-sdk')!}`,
    '@dutydeck/plugin-kit': `file:${tarballPaths.get('plugin-kit')!}`,
  }, overrides: { '@dutydeck/plugin-sdk': `file:${tarballPaths.get('plugin-sdk')!}` } }, null, 2))
  execute([process.execPath, 'install', '--offline', '--ignore-scripts'], author)
  for (const name of ['plugin-sdk', 'plugin-kit']) {
    const root = realpathSync(join(author, 'node_modules/@dutydeck', name))
    assert(!root.startsWith(`${repository}${sep}`), '禁止使用仓库工作区链接冒充独立安装')
    assert(root.startsWith(`${author}${sep}`), '安装包必须属于外部作者目录')
    const metadata = objectOutput(readFileSync(join(root, 'package.json'), 'utf8'))
    assert(!JSON.stringify(metadata).includes('workspace:'), '发行物不能依赖 workspace 协议')
    const dependencies = metadata.dependencies as Record<string, string> | undefined
    assert(!dependencies || Object.keys(dependencies).every(dependency => dependency === '@dutydeck/plugin-sdk'), 'CLI/SDK 不能依赖宿主')
    assert(!existsSync(join(root, 'src')), '发行物不能借用仓库源码')
    evidence.installedPackages.push({ name, realPath: root, independent: true })
  }
  evidence.checks.push('真实 SDK/CLI tarball 离线安装，无仓库软链接、workspace 协议或宿主依赖')
  authorCli('init', 'plugin', '--id', 'acme.external', '--name', '外部作者验收插件')
  authorVersion('1.0.0', 'EXTERNAL_AUTHOR_V1')
  authorCli('validate', 'plugin')
  authorCli('test', 'plugin')
  const identity = objectOutput(authorCli('publisher', 'init', '--config-dir', 'signer'))
  assert.equal(typeof identity.keyId, 'string')
  const fingerprint = identity.keyId as string
  evidence.publisherFingerprint = fingerprint
  authorCli('pack', 'plugin', '--out', 'v1.ddplugin', '--release', '--config-dir', 'signer')
  assert.equal(objectOutput(authorCli('verify', 'v1.ddplugin', '--trusted-key', fingerprint)).trusted, true)
  evidence.checks.push('已安装 bin 创建脚手架、验证、合同测试、签名打包和指纹验签通过')

  /** 用户作品属于独立目录，升级与卸载不能删除。 */
  const userDirectory = join(temporaryRoot, 'user-workspace')
  mkdirSync(userDirectory)
  const userPath = join(userDirectory, 'my-notes.md')
  writeFileSync(userPath, '用户原有作品，安装和卸载都应保留。\n')
  const userDigest = digest(userPath)
  const service = new ContentPluginService(join(temporaryRoot, 'host'))
  const manager = new ContentPluginManager(service, new AgentPluginRegistry())
  manager.initialize()
  const preview = manager.preview(join(author, 'v1.ddplugin'))
  manager.install(preview.token, fingerprint)
  const unselected = resolveActiveModuleContext({ ...input, explicitModuleIds: [] })
  assert.deepEqual(unselected.promptFragments, [])
  assert.deepEqual(unselected.modules, [])
  const selected = resolveActiveModuleContext(input)
  assert.deepEqual(selected.unavailable, [])
  assert.equal(selected.modules.length, 1)
  assert(selected.promptFragments.join('\n').includes('EXTERNAL_AUTHOR_V1'))
  assert(selected.promptFragments.some(fragment => fragment.includes('适用任务')))
  assert.deepEqual(selected.skillMentions, [])
  assert.deepEqual(selected.allowedToolNames, [])
  evidence.versions.push({ version: '1.0.0', packageHash: preview.packageHash, injectedResources: selected.modules[0]!.packageResources!.length })
  evidence.checks.push('同一生产 Manager/Service/Resolver 安装 V1，未选不注入，选中读取真实包 Skill 和提示，未扩大工具权限')

  authorVersion('1.1.0', 'EXTERNAL_AUTHOR_V2')
  authorCli('validate', 'plugin')
  authorCli('test', 'plugin')
  authorCli('pack', 'plugin', '--out', 'v2.ddplugin', '--release', '--config-dir', 'signer')
  assert.equal(objectOutput(authorCli('verify', 'v2.ddplugin', '--trusted-key', fingerprint)).trusted, true)
  const update = manager.preview(join(author, 'v2.ddplugin'))
  assert.equal(update.operation, 'update')
  assert.equal(update.previousVersion, '1.0.0')
  manager.install(update.token)
  const updated = resolveActiveModuleContext(input)
  assert.deepEqual(updated.unavailable, [])
  assert.equal(updated.modules[0]!.moduleVersion, '1.1.0')
  assert(updated.promptFragments.join('\n').includes('EXTERNAL_AUTHOR_V2'))
  assert(!updated.promptFragments.join('\n').includes('EXTERNAL_AUTHOR_V1'))
  assert.notEqual(update.packageHash, preview.packageHash)
  evidence.versions.push({ version: '1.1.0', packageHash: update.packageHash, injectedResources: updated.modules[0]!.packageResources!.length })
  evidence.checks.push('不重建宿主的 V2 升级更换真实正文与审计版本/hash')

  manager.setEnabled('acme.external', false, service.snapshot().revision)
  const disabled = resolveActiveModuleContext(input)
  assert.equal(disabled.unavailable.length, 1)
  assert.deepEqual(disabled.promptFragments, [])
  manager.setEnabled('acme.external', true, service.snapshot().revision)
  assert(resolveActiveModuleContext(input).promptFragments.join('\n').includes('EXTERNAL_AUTHOR_V2'))
  manager.uninstall('acme.external', service.snapshot().revision)
  assert.deepEqual(service.snapshot().plugins, [])
  const removed = resolveActiveModuleContext(input)
  assert.equal(removed.unavailable.length, 1)
  assert.deepEqual(removed.promptFragments, [])
  assert.equal(digest(userPath), userDigest)
  assert(existsSync(join(author, 'plugin/skills/assist/SKILL.md')))
  evidence.checks.push('关闭立即阻断、重新启用恢复、卸载撤销接入，用户作品与作者源文件保持不变')
  mkdirSync(deliveryDirectory, { recursive: true })
  for (const tarball of evidence.tarballs) {
    copyFileSync(join(artifacts, basename(tarball.path)), tarball.path)
    assert.equal(digest(tarball.path), tarball.sha256)
  }
  evidence.completedAt = new Date().toISOString()
} finally {
  setAgentModuleRuntimeCatalog(null)
  setPackageModuleResolver(undefined)
  rmSync(temporaryRoot, { recursive: true, force: true })
}
evidence.cleaned = true
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`${JSON.stringify({ result: 'PASS', evidence: evidencePath, ...evidence }, null, 2)}\n`)
