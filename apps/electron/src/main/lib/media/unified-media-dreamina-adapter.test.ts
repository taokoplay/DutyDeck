import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MediaGenerationRequest, MediaInputValue } from '@proma/shared'
import type { DreaminaImageGenerationDependencies } from '../chat-tools/dreamina-image-generation'
import type { UnifiedMediaModelRoute } from './unified-media-model-catalog'
import { UnifiedMediaGenerationService } from './unified-media-generation-service'
import { createUnifiedDreaminaImageAdapter } from './unified-media-dreamina-adapter'

/** 测试字节只用于协议与归属验证，不访问用户媒体。 */
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex')
/** 所有模拟 CLI 下载均落在独立目录。 */
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
/** 即梦路由只有本机 CLI 配置，没有 API 密钥。 */
const route: UnifiedMediaModelRoute = {
  ref: { kind: 'image', provider: 'dreamina', profileId: 'dreamina', modelId: '4.0' },
  option: { ref: 'media:image:dreamina:dreamina:4.0', name: '即梦 4.0', kind: 'image', provider: 'dreamina', profileId: 'dreamina', modelId: '4.0', available: true, capabilities: ['text-to-image', 'image-to-image'], adapterId: 'dreamina-image' },
  baseUrl: '', apiKey: '', cliPath: '/fixture/dreamina', resolutionType: '4k',
}
/** 每次运行使用规范媒体引用，而不是用户提供的任意文件路径。 */
const reference: MediaInputValue = { kind: 'asset', asset: { assetId: 'reference', revision: 1, hash: 'a'.repeat(64), mediaKind: 'image' } }
/** 基础生成请求与模型来源完全一致。 */
const request: MediaGenerationRequest = { projectId: 'project', operationId: 'operation', modelRef: route.option.ref, prompt: '保持主角与服饰，制作镜头', inputs: {} }

/** 复用真实核心与适配器，只有 CLI 和资产读取由受控 fixture 替换。 */
async function fixture(options: { failure?: 'login' | 'missing' | 'confirmation'; hold?: boolean } = {}) {
  /** 记录实际参数和引用字节，证明没有静默丢弃多图。 */
  const calls: string[][] = []
  const references: Buffer[] = []
  const referencePaths: string[] = []
  const root = await mkdtemp(join(tmpdir(), 'unified-dreamina-test-')); roots.push(root)
  let resume: (() => void) | undefined
  let notifyQuery: (() => void) | undefined
  const queryStarted = new Promise<void>(resolve => { notifyQuery = resolve })
  const queryReleased = new Promise<void>(resolve => { resume = resolve })
  const dependencies: DreaminaImageGenerationDependencies = {
    createTempDir: async () => root,
    removeTempDir: async path => { await rm(path, { recursive: true, force: true }) },
    runCli: async (args, cliPath) => {
      expect(cliPath).toBe('/fixture/dreamina')
      calls.push([...args])
      if (options.failure === 'missing') return { exitCode: 1, stdout: '', stderr: '', failureCode: 'cliMissing' }
      if (options.failure === 'login') return { exitCode: 1, stdout: '', stderr: 'Not logged in. Please login. secret-cookie-value' }
      if (options.failure === 'confirmation') return { exitCode: 1, stdout: 'AigcComplianceConfirmationRequired', stderr: '' }
      if (args[0] !== 'query_result') {
        for (const arg of args.filter(value => value.startsWith('--images='))) {
          const path = arg.slice('--images='.length)
          referencePaths.push(path); references.push(await readFile(path))
        }
        return { exitCode: 0, stdout: JSON.stringify({ submit_id: 'fixture-submit', gen_status: 'querying' }), stderr: '' }
      }
      notifyQuery?.()
      if (options.hold) await queryReleased
      const path = join(root, 'result.png')
      await writeFile(path, png)
      return { exitCode: 0, stdout: JSON.stringify({ submit_id: 'fixture-submit', gen_status: 'success', result_json: { images: [{ path }] } }), stderr: '' }
    },
  }
  const adapter = createUnifiedDreaminaImageAdapter({ readAsset: async (projectId, asset) => { expect(projectId).toBe('project'); expect(asset.mediaKind).toBe('image'); return png }, generationDependencies: dependencies })
  const registered: Uint8Array[] = []
  const service = new UnifiedMediaGenerationService({ resolveModel: () => route, adapters: [adapter], registerOutput: async (projectId, _operation, bytes, type, origin, kind) => {
    expect(projectId).toBe('project'); expect(origin.sourceSessionId).toBe('session'); expect(kind).toBe('image'); expect(type).toBe('image/png'); registered.push(bytes)
    return { assetId: 'output', revision: 1, hash: 'b'.repeat(64), mediaKind: 'image' }
  } })
  return { adapter, service, calls, references, referencePaths, root, registered, queryStarted, resume: () => resume?.() }
}

describe('即梦接入统一媒体运行', () => {
  test('Given 本机CLI模型与两个资产 When 生成 Then 传递多图和分辨率并登记真实产物', async () => {
    const f = await fixture()
    const prepared = f.service.prepare('session', { ...request, inputs: { first: reference, last: reference, count: { kind: 'scalar', value: 2 }, ratio: { kind: 'scalar', value: '16:9' } } })
    expect(f.calls).toHaveLength(0)
    expect(f.service.getAttachmentSource('session', prepared.id).request.inputs.resolution_type).toEqual({ kind: 'scalar', value: '4k' })
    const running = await f.service.execute('session', prepared.id, prepared.revision)
    const done = await f.service.wait('session', prepared.id, 2000, running.revision)
    expect(done.phase).toBe('succeeded')
    expect(f.calls[0]).toContain('image2image')
    expect(f.calls[0]).toContain('--resolution_type=4k')
    expect(f.calls[0]).toContain('--generate_num=2')
    expect(f.calls[0]).toContain('--ratio=16:9')
    expect(f.references).toEqual([png, png])
    expect(f.registered).toEqual([png])
    expect(f.referencePaths.every(path => !existsSync(path))).toBe(true)
    expect(existsSync(f.root)).toBe(false)
    expect(done.outputs[0]?.asset.assetId).toBe('output')
  })
  test('Given 非法或未知参数 When 准备 Then CLI和资产读取前拒绝', async () => {
    const f = await fixture()
    /** 显式合同类型避免联合对象中的隐式 undefined 绕过输入校验。 */
    const invalidInputs: Record<string, MediaInputValue>[] = [{ invented: { kind: 'scalar', value: true } }, { count: { kind: 'scalar', value: 1.5 } }, { resolution_type: { kind: 'scalar', value: '1k' } }, { width: { kind: 'scalar', value: 1024 } }]
    for (const inputs of invalidInputs) {
      expect(() => f.service.prepare('session', { ...request, inputs })).toThrow()
    }
    expect(f.calls).toHaveLength(0)
  })
  test('Given 即梦3.0自定义尺寸 When 使用1k分辨率准备 Then 在提交前拒绝', async () => {
    const f = await fixture()
    /** 模型3.x只有2k支持自定义尺寸，不以数值范围推断能力。 */
    const legacyRoute = { ...route, ref: { ...route.ref, modelId: '3.0' }, resolutionType: '1k' }
    expect(() => f.adapter.prepareInputs!({ request: { ...request, inputs: { width: { kind: 'scalar', value: 1024 }, height: { kind: 'scalar', value: 1024 } } }, route: legacyRoute })).toThrow('PARAMETER_INVALID')
    expect(f.calls).toHaveLength(0)
  })
  test('Given 缺CLI、登录失效或网页确认 When 执行失败 Then 返回可操作提示且不泄漏原始日志', async () => {
    for (const failure of ['missing', 'login', 'confirmation'] as const) {
      const f = await fixture({ failure })
      const prepared = f.service.prepare('session', request)
      const running = await f.service.execute('session', prepared.id, prepared.revision)
      const done = await f.service.wait('session', prepared.id, 2000, running.revision)
      expect(done.phase).toBe('failed')
      expect(done.error).toContain(failure === 'missing' ? 'CLI' : failure === 'login' ? '登录' : '网页')
      expect(done.error).not.toContain('secret-cookie-value')
      expect(f.registered).toHaveLength(0)
    }
  })
  test('Given 即梦正在查询 When 本地取消后成功响应迟到 Then 不登记产物且清理临时文件', async () => {
    const f = await fixture({ hold: true })
    const prepared = f.service.prepare('session', request)
    await f.service.execute('session', prepared.id, prepared.revision)
    await f.queryStarted
    f.service.cancel('session', prepared.id)
    f.resume()
    /** 等待受控文件清理，保证断言发生在适配器结束后。 */
    for (let attempt = 0; attempt < 100 && existsSync(f.root); attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    expect(f.service.get('session', prepared.id).phase).toBe('cancelled')
    expect(f.registered).toHaveLength(0)
    expect(existsSync(f.root)).toBe(false)
  })
})
