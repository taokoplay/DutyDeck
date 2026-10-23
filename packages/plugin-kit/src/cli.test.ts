import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { inspectPluginPackage } from './package.js'

/** 外部作者测试全部落在独立临时目录，不使用宿主源码作为插件资源。 */
const roots: string[] = []
/** 构建后的公开 CLI 是实际子进程入口。 */
const cli = resolve(import.meta.dir, '../dist/cli.js')
/** 创建每个场景的隔离作者根目录。 */
function temporary(): string { const root = mkdtempSync(join(tmpdir(), 'dutydeck-author-')); roots.push(root); return root }
/** 执行真正 CLI 子进程并保留退出码和标准输出供断言。 */
function run(root: string, ...args: string[]) { return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' }) }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('独立插件作者 CLI', () => {
  test('Given 外部空目录 When 创建、验证、签名、打包 Then 指纹验签成功且不执行作者脚本', () => {
    const root = temporary()
    expect(run(root, 'init', 'plugin', '--id', 'acme.demo', '--name', '示例插件').status).toBe(0)
    writeFileSync(join(root, 'plugin/package.json'), JSON.stringify({ scripts: { test: 'exit 87', postinstall: 'exit 88' } }))
    mkdirSync(join(root, 'plugin/node_modules'))
    writeFileSync(join(root, 'plugin/node_modules/secret.json'), 'private')
    writeFileSync(join(root, 'plugin/.env'), 'PRIVATE=secret')
    expect(run(root, 'validate', 'plugin').status).toBe(0)
    expect(run(root, 'test', 'plugin').status).toBe(0)
    const publisher = run(root, 'publisher', 'init', '--config-dir', 'signer')
    expect(publisher.status).toBe(0)
    const identity = JSON.parse(publisher.stdout) as { keyId: string }
    expect(identity.keyId).toMatch(/^[a-f0-9]{64}$/)
    expect(publisher.stdout).not.toContain('PRIVATE KEY')
    if (process.platform !== 'win32') expect(statSync(join(root, 'signer/publisher-key.pem')).mode & 0o777).toBe(0o600)
    const packed = run(root, 'pack', 'plugin', '--out', 'release.ddplugin', '--release', '--config-dir', 'signer')
    expect(packed.status).toBe(0)
    expect(packed.stdout).toContain('release')
    expect(run(root, 'verify', 'release.ddplugin', '--trusted-key', identity.keyId).status).toBe(0)
    expect(run(root, 'verify', 'release.ddplugin', '--trusted-key', '0'.repeat(64)).status).toBe(1)
    const contents = inspectPluginPackage(readFileSync(join(root, 'release.ddplugin')))
    expect([...contents.files.keys()].some(path => /node_modules|package.json|\.env|pem/.test(path))).toBe(false)
  })

  test('Given 开发包 When 未指定开发或信任模式 Then 拒绝；显式开发验证成功', () => {
    const root = temporary()
    expect(run(root, 'init', 'plugin', '--id', 'acme.demo').status).toBe(0)
    expect(run(root, 'pack', 'plugin', '--out', 'dev.ddplugin').status).toBe(0)
    expect(run(root, 'verify', 'dev.ddplugin').status).toBe(1)
    expect(run(root, 'verify', 'dev.ddplugin', '--development').status).toBe(0)
    expect(run(root, 'pack', 'plugin', '--out', 'release.ddplugin', '--release').status).toBe(1)
    expect(run(root, 'pack', 'plugin', '--out', 'release.ddplugin', '--relese').status).toBe(1)
  })

  test('Given 既有目录、包和密钥 When 重新创建 Then 原始内容不变', () => {
    const root = temporary()
    expect(run(root, 'init', 'plugin', '--id', 'acme.demo').status).toBe(0)
    expect(run(root, 'init', 'plugin', '--id', 'acme.other').status).toBe(1)
    expect(run(root, 'pack', 'plugin', '--out', 'dev.ddplugin').status).toBe(0)
    const original = readFileSync(join(root, 'dev.ddplugin'))
    expect(run(root, 'pack', 'plugin', '--out', 'dev.ddplugin').status).toBe(1)
    expect(readFileSync(join(root, 'dev.ddplugin'))).toEqual(original)
    expect(run(root, 'publisher', 'init', '--config-dir', 'signer').status).toBe(0)
    const key = readFileSync(join(root, 'signer/publisher-key.pem'))
    expect(run(root, 'publisher', 'init', '--config-dir', 'signer').status).toBe(1)
    expect(readFileSync(join(root, 'signer/publisher-key.pem'))).toEqual(key)
  })

  test('Given 指向源目录外的资源软链接 When 验证 Then 拒绝读取', () => {
    const root = temporary()
    expect(run(root, 'init', 'plugin', '--id', 'acme.demo').status).toBe(0)
    writeFileSync(join(root, 'secret.md'), 'secret')
    symlinkSync(join(root, 'secret.md'), join(root, 'plugin/prompts/linked.md'))
    expect(run(root, 'validate', 'plugin').status).toBe(1)
    rmSync(join(root, 'plugin/prompts/linked.md'))
    mkdirSync(join(root, 'external'))
    symlinkSync(join(root, 'external'), join(root, 'plugin/assets'))
    expect(run(root, 'validate', 'plugin').status).toBe(1)
  })

  test('Given 宽松权限签名私钥 When 发布打包 Then 拒绝使用', () => {
    if (process.platform === 'win32') return
    const root = temporary()
    expect(run(root, 'init', 'plugin', '--id', 'acme.demo').status).toBe(0)
    expect(run(root, 'publisher', 'init', '--config-dir', 'signer').status).toBe(0)
    chmodSync(join(root, 'signer/publisher-key.pem'), 0o644)
    const result = run(root, 'pack', 'plugin', '--out', 'release.ddplugin', '--release', '--config-dir', 'signer')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('PLUGIN_SIGNER_PERMISSIONS_INVALID')
  })

  test('Given module-runtime 类型 When init Then 生成 V3 清单和运行时模板', () => {
    const root = temporary()
    const result = run(root, 'init', 'plugin', '--id', 'acme.echo', '--name', '回显', '--profile', 'module-runtime')
    expect(result.status).toBe(0)
    const manifest = JSON.parse(readFileSync(join(root, 'plugin/plugin.json'), 'utf8')) as { formatVersion?: number; profile?: string }
    expect(manifest.formatVersion).toBe(3)
    expect(manifest.profile).toBe('module-runtime')
    expect(() => statSync(join(root, 'plugin/src/runtime.ts'))).not.toThrow()
    expect(() => statSync(join(root, 'plugin/src/surfaces/workspace/index.html'))).not.toThrow()
  })

  test('Given runtime 与 Surface 源码 When build Then 生成包内自包含入口', () => {
    const root = temporary()
    expect(run(root, 'init', 'plugin', '--id', 'acme.echo', '--name', '回显', '--profile', 'module-runtime').status).toBe(0)
    writeFileSync(join(root, 'plugin/src/runtime.ts'), 'export default { activate() {} }\n')
    writeFileSync(join(root, 'plugin/src/surfaces/workspace/main.ts'), 'document.body.dataset.ready = "yes"\n')
    const result = run(root, 'build', 'plugin')
    expect(result.status).toBe(0)
    expect(readFileSync(join(root, 'plugin/runtime/main.mjs'), 'utf8')).toContain('activate')
    expect(readFileSync(join(root, 'plugin/surfaces/workspace/main.js'), 'utf8')).toContain('dataset.ready')
    expect(readFileSync(join(root, 'plugin/surfaces/workspace/index.html'), 'utf8')).toContain('main.js')
  })
})
