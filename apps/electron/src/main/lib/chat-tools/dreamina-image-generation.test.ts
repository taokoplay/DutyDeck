import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateDreaminaImages, runDreaminaCli } from './dreamina-image-generation'
import type { GenerateDreaminaImagesInput, DreaminaImageGenerationDependencies } from './dreamina-image-generation'

/** 每例仅操作独立临时目录，无真实 CLI 或供应商请求。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
/** 无附件依赖的 CLI 核心 fixture。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dreamina-core-')); roots.push(root)
  const path = join(root, 'result.dat')
  writeFileSync(path, Buffer.from('ffd8ffe000104a4649460001', 'hex'))
  const calls: string[][] = []
  const input: GenerateDreaminaImagesInput = { route: { executor: 'dreamina-image', snapshot: { executor: 'dreamina-image', profileId: 'profile', imageProfileId: 'image', modelId: '5.0', name: '测试' } }, prompt: '测试', pollIntervalMs: 1 }
  const dependencies: DreaminaImageGenerationDependencies = { createTempDir: async () => root, removeTempDir: async () => { rmSync(root, { recursive: true, force: true }) }, runCli: async args => {
    calls.push([...args])
    return { exitCode: 0, stderr: '', stdout: JSON.stringify(args[0] === 'query_result' ? { gen_status: 'success', result_json: { images: [{ path }] } } : { submit_id: 'task' }) }
  } }
  return { root, path, input, calls, dependencies }
}

test('Given CLI 返回 JPEG 字节但路径无图片后缀 When 生成 Then 返回真实 MIME 并清理目录', async () => {
  const f = fixture()
  const result = await generateDreaminaImages({ ...f.input, aspectRatio: '3:2' }, f.dependencies)
  expect(result[0]?.contentType).toBe('image/jpeg')
  expect(f.calls[0]).toContain('--resolution_type=2k')
  expect(f.calls[0]).toContain('--ratio=3:2')
  expect(existsSync(f.root)).toBe(false)
})

for (const [model, resolution] of [['3.0', '1k'], ['3.1', '2k'], ['4.0', '4k'], ['5.0', '2k'], ['5.0Pro', '1.5k']]) test(`Given ${model} 与 ${resolution} When 提交 Then 必传合法档位`, async () => {
  const f = fixture()
  await generateDreaminaImages({ ...f.input, route: { ...f.input.route, snapshot: { ...f.input.route.snapshot, modelId: model! }, ...(model === '3.0' ? {} : { resolutionType: resolution }) } }, f.dependencies)
  expect(f.calls[0]).toContain(`--resolution_type=${resolution}`)
})

test('Given 非法模型分辨率组合 When 生成 Then 提交前拒绝', async () => {
  const f = fixture()
  await expect(generateDreaminaImages({ ...f.input, route: { ...f.input.route, resolutionType: '1k' } }, f.dependencies)).rejects.toThrow('组合不受支持')
  expect(f.calls).toHaveLength(0)
})

for (const mode of ['symlink', 'oversize', 'invalid', 'too-many'] as const) test(`Given 不安全输出 ${mode} When 收集 Then 拒绝且清理`, async () => {
  const f = fixture()
  if (mode === 'symlink') { rmSync(f.path); symlinkSync('/etc/hosts', f.path) }
  if (mode === 'oversize') truncateSync(f.path, 32 * 1024 * 1024 + 1)
  if (mode === 'invalid') writeFileSync(f.path, '<html>bad</html>')
  if (mode === 'too-many') f.dependencies.runCli = async args => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(args[0] === 'query_result' ? { gen_status: 'success', result_json: { images: Array.from({ length: 5 }, () => ({ path: f.path })) } } : { submit_id: 'task' }) })
  await expect(generateDreaminaImages(f.input, f.dependencies)).rejects.toThrow()
  expect(existsSync(f.root)).toBe(false)
})

for (const cancelAt of ['submit', 'query'] as const) test(`Given ${cancelAt} 返回时取消 When 生成 Then 无迟到产物且不泄露取消原因`, async () => {
  const f = fixture()
  const controller = new AbortController()
  const original = f.dependencies.runCli
  f.dependencies.runCli = async (args, cliPath, signal) => {
    const result = await original(args, cliPath, signal)
    if ((cancelAt === 'submit' && args[0] !== 'query_result') || (cancelAt === 'query' && args[0] === 'query_result')) controller.abort(new Error('secret-token'))
    return result
  }
  await expect(generateDreaminaImages({ ...f.input, signal: controller.signal }, f.dependencies)).rejects.toThrow('即梦生成已取消')
  expect(f.calls).toHaveLength(cancelAt === 'submit' ? 1 : 2)
  expect(existsSync(f.root)).toBe(false)
})

test('Given 不可信失败文本 When CLI 失败 Then 不回传 stderr 或 fail_reason', async () => {
  const f = fixture()
  f.dependencies.runCli = async args => ({ exitCode: args[0] === 'query_result' ? 1 : 0, stderr: 'secret-token', stdout: JSON.stringify(args[0] === 'query_result' ? { gen_status: 'fail', fail_reason: 'secret-token' } : { submit_id: 'task' }) })
  await expect(generateDreaminaImages(f.input, f.dependencies)).rejects.toThrow(/^即梦生成失败$/)
})

test('Given 本机长时间子进程 When AbortSignal 取消 Then 立即终止等待且使用受控错误', async () => {
  const controller = new AbortController()
  const task = runDreaminaCli(['-e', 'setInterval(() => {}, 1000)'], process.execPath, controller.signal)
  const timer = setTimeout(() => controller.abort(), 30)
  try { await expect(task).rejects.toThrow('本机进程已终止') } finally { clearTimeout(timer) }
})

test('Given CLI 宣布成功但没有图片 When 收集 Then 立即拒绝而不是继续等待', async () => {
  const f = fixture()
  f.dependencies.runCli = async args => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(args[0] === 'query_result' ? { gen_status: 'success', result_json: { images: [] } } : { submit_id: 'task' }) })
  await expect(generateDreaminaImages(f.input, f.dependencies)).rejects.toThrow('图片数量无效')
  expect(existsSync(f.root)).toBe(false)
})

test('Given 本机依赖抛出敏感异常 When 生成 Then 只返回受控错误', async () => {
  const f = fixture()
  f.dependencies.createTempDir = async () => { throw new Error('/private/secret-token') }
  await expect(generateDreaminaImages(f.input, f.dependencies)).rejects.toThrow(/^即梦生成失败，请检查本机 CLI 和媒体文件$/)
})

test('Given 查询 JSON 成功但 CLI 非零退出 When 收集 Then 不采纳可读输出文件', async () => {
  const f = fixture()
  const original = f.dependencies.runCli
  f.dependencies.runCli = async (args, path, signal) => ({ ...await original(args, path, signal), exitCode: args[0] === 'query_result' ? 1 : 0 })
  await expect(generateDreaminaImages(f.input, f.dependencies)).rejects.toThrow('CLI 执行失败')
  expect(existsSync(f.root)).toBe(false)
})

test('Given 查询阶段登录失败且没有 JSON When 生成 Then 返回登录提示而非解析错误', async () => {
  const f = fixture()
  const original = f.dependencies.runCli
  f.dependencies.runCli = async (args, path, signal) => args[0] === 'query_result' ? { exitCode: 1, stdout: 'login required', stderr: 'secret-token' } : original(args, path, signal)
  await expect(generateDreaminaImages(f.input, f.dependencies)).rejects.toThrow('请检查登录态')
})

for (const model of ['3.0', '3.1']) test(`Given ${model} 默认 1k 与自定义尺寸 When 生成 Then 拒绝提交直到显式选择 2k`, async () => {
  const f = fixture()
  const input = { ...f.input, route: { ...f.input.route, snapshot: { ...f.input.route.snapshot, modelId: model } }, width: 768, height: 768 }
  await expect(generateDreaminaImages(input, f.dependencies)).rejects.toThrow('自定义尺寸必须使用 2k')
  expect(f.calls).toHaveLength(0)
  await generateDreaminaImages({ ...input, route: { ...input.route, resolutionType: '2k' } }, f.dependencies)
  expect(f.calls[0]).toContain('--resolution_type=2k')
})
