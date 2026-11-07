import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, statSync, symlinkSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureBundleSet, capturePackagedPayload, capturePackagedPayloadAsync, HostBuildIdentitySession, HOST_BUNDLE_FILES } from './host-build-identity'

const roots: string[] = []
const root = (): string => { const value = mkdtempSync(join(tmpdir(), 'dutydeck-build-identity-')); roots.push(value); return value }
const put = (directory: string, path: string, value = 'fixture'): void => { const full = join(directory, path); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, value) }
const runtime = { hostVersion: '0.20.20', electron: '43.2.0', node: '24.0.0', modules: '140', platform: 'darwin', arch: 'arm64' }
const bundle = (): string => { const dir = root(); for (const file of HOST_BUNDLE_FILES) put(dir, file); put(dir, 'renderer/index.html'); put(dir, 'renderer/assets/app.js'); return dir }
const packaged = (): string => { const dir = root(); put(dir, 'app.asar', 'raw archive fixture'); put(dir, 'app.asar.unpacked/node_modules/native/addon.node'); put(dir, 'bin/dutydeck'); return dir }
afterEach(() => { for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('Given 版本化的实际构建材料合同', () => {
  test('When 相同字节复制到不同目录 Then 摘要不含绝对路径和时间', () => {
    expect(captureBundleSet(bundle())).toEqual(captureBundleSet(bundle()))
    expect(capturePackagedPayload(packaged(), runtime)).toEqual(capturePackagedPayload(packaged(), runtime))
  })
  test('When 字节同长度且保留mtime但被修改 Then 摘要仍改变', () => {
    const dir = bundle(); const before = captureBundleSet(dir); const path = join(dir, 'main.cjs'); const stat = statSync(path)
    writeFileSync(path, 'changed'); utimesSync(path, stat.atime, stat.mtime)
    expect(captureBundleSet(dir).sha256).not.toBe(before.sha256)
  })
  test('When 必需bundle缺失、空文件或新未知入口 Then 拒绝不完整集合', () => {
    const dir = bundle(); rmSync(join(dir, 'plugin-runtime.cjs'))
    expect(() => captureBundleSet(dir)).toThrow('HOST_BUILD_REQUIRED_FILE')
    put(dir, 'plugin-runtime.cjs', '')
    expect(() => captureBundleSet(dir)).toThrow('HOST_BUILD_REQUIRED_FILE')
    put(dir, 'plugin-runtime.cjs'); put(dir, 'new-runtime.cjs')
    expect(() => captureBundleSet(dir)).toThrow('HOST_BUILD_UNKNOWN_BUNDLE')
  })
  test('When renderer成员新增删除或修改 Then 集合摘要变化；smoke文件不属于生产合同', () => {
    const dir = bundle(); const before = captureBundleSet(dir)
    put(dir, 'test-smoke.cjs'); expect(captureBundleSet(dir)).toEqual(before)
    put(dir, 'renderer/assets/new.js'); expect(captureBundleSet(dir).sha256).not.toBe(before.sha256)
    rmSync(join(dir, 'renderer/assets/app.js')); expect(captureBundleSet(dir).files).not.toContainEqual(expect.objectContaining({ path: 'renderer/assets/app.js' }))
  })
  test('When packaged的归档、unpacked依赖、helper或新增资源变化 Then 全负载摘要改变', () => {
    for (const path of ['app.asar', 'app.asar.unpacked/node_modules/native/addon.node', 'bin/dutydeck', 'extra-resource']) {
      const dir = packaged(); const before = capturePackagedPayload(dir, runtime)
      put(dir, path, 'changed'); expect(capturePackagedPayload(dir, runtime).sha256).not.toBe(before.sha256)
    }
  })
  test('When 同材料但Electron、ABI或平台不同 Then 不能互认', () => {
    const dir = packaged(); const before = capturePackagedPayload(dir, runtime)
    for (const key of Object.keys(runtime) as Array<keyof typeof runtime>) expect(capturePackagedPayload(dir, { ...runtime, [key]: `${runtime[key]}-other` }).sha256).not.toBe(before.sha256)
    expect(() => capturePackagedPayload(dir, { ...runtime, electron: 'unknown' })).toThrow('HOST_BUILD_RUNTIME_UNKNOWN')
  })
  test('When 缺少归档、出现链接或超出扫描预算 Then fail closed不沿用部分hash', () => {
    const dir = packaged(); symlinkSync('/tmp', join(dir, 'outside'))
    expect(() => capturePackagedPayload(dir, runtime)).toThrow('HOST_BUILD_LINK_UNSUPPORTED')
    rmSync(join(dir, 'outside')); rmSync(join(dir, 'app.asar'))
    expect(() => capturePackagedPayload(dir, runtime)).toThrow('HOST_BUILD_REQUIRED_FILE')
    expect(() => captureBundleSet(bundle(), { maxFiles: 1 })).toThrow('HOST_BUILD_BUDGET_EXCEEDED')
  })
  test('When 异步扫描 Then 摘要与同步合同一致且让出事件循环', async () => {
    const dir = packaged(); let yielded = false
    setImmediate(() => { yielded = true })
    expect(await capturePackagedPayloadAsync(dir, runtime)).toEqual(capturePackagedPayload(dir, runtime))
    expect(yielded).toBe(true)
  })
  test('When 分段扫描期间目录成员改变 Then 拒绝混合快照', async () => {
    const dir = packaged()
    setImmediate(() => put(dir, 'new-helper', 'created during scan'))
    await expect(capturePackagedPayloadAsync(dir, runtime)).rejects.toThrow('HOST_BUILD_SCAN_CHANGED')
  })
  test('When packaged及bundle相同文件内容 Then 域和覆盖合同仍明确区分', () => {
    expect(captureBundleSet(bundle()).contract).toBe('dutydeck-bundle-set-v1')
    expect(capturePackagedPayload(packaged(), runtime).contract).toBe('dutydeck-packaged-resources-v1')
  })
})

describe('Given 当前进程启动基线', () => {
  test('When 材料发生变化后恢复 Then 仍须重启，不把新磁盘身份赋给旧进程', async () => {
    const dir = packaged(); const capture = () => capturePackagedPayload(dir, runtime)
    const session = new HostBuildIdentitySession(capture)
    expect((await session.current()).hostBuildSha256).toBe(capture().sha256)
    put(dir, 'bin/dutydeck', 'changed')
    expect((await session.current())).toEqual({ status: 'changed', reason: 'HOST_BUILD_CHANGED_RESTART_REQUIRED' })
    put(dir, 'bin/dutydeck')
    expect((await session.current()).hostBuildSha256).toBeUndefined()
  })
  test('When 扫描后段时前面已读文件发生普通原地写入 Then 本次检查即撤销身份', async () => {
    const dir = packaged(); put(dir, 'zz/tail')
    let mutate = false
    const instrumented = { ...fs, readdirSync: ((path: fs.PathLike, ...args: unknown[]) => {
      if (mutate && String(path).endsWith('/zz')) { mutate = false; put(dir, 'app.asar', 'changed archive') }
      return Reflect.apply(fs.readdirSync, fs, [path, ...args])
    }) as typeof fs.readdirSync }
    const session = new HostBuildIdentitySession(() => capturePackagedPayloadAsync(dir, runtime, { fs: instrumented }))
    expect((await session.current()).status).toBe('available')
    mutate = true
    expect((await session.current()).status).toBe('changed')
  })
  test('When 启动捕获失败 Then 稍后新产物不得在旧进程中激活', async () => {
    const dir = root(); const session = new HostBuildIdentitySession(() => capturePackagedPayload(dir, runtime))
    put(dir, 'app.asar'); expect((await session.current()).status).toBe('unavailable')
  })
  test('When 误把开发bundle摘要送入会话 Then 不能取得完整宿主指纹', async () => {
    const session = new HostBuildIdentitySession(() => captureBundleSet(bundle()))
    expect((await session.current()).hostBuildSha256).toBeUndefined()
  })
})
