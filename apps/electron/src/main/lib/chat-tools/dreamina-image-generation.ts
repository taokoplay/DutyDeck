/**
 * 即梦图像执行器。
 *
 * 本执行链使用本机 CLI 登录态：先 `text2image` 提交任务拿到 submit_id，
 * 再 `query_result --download_dir` 轮询下载结果，最后返回经过校验的原始图片字节。
 * 只有 gen_status=success 才算成功；submit 被接受不等于生成完成。
 */
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { lstatSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { interactionSourcePath, readInteractionFile } from '../interaction-design/paths'
import type { ResolvedImageGenerationRoute } from '../image-generation-runtime'
import type { ImageRequestAudit } from './image-request-context'

/** 单次 CLI 调用结果；只保留判定所需字段。 */
export interface DreaminaCliResult {
  exitCode: number
  stdout: string
  stderr: string
  /** CLI 缺失或进程超时等基础设施失败，与业务失败区分。 */
  failureCode?: 'cliMissing' | 'timeout'
}

export type DreaminaCliRunner = (args: readonly string[], cliPath: string, signal?: AbortSignal) => Promise<DreaminaCliResult>

/** 执行器依赖，测试可整体替换。 */
export interface DreaminaImageGenerationDependencies {
  runCli: DreaminaCliRunner
  createTempDir: () => Promise<string>
  removeTempDir: (path: string) => Promise<void>
}

export interface GenerateDreaminaImagesInput {
  route: Extract<ResolvedImageGenerationRoute, { executor: 'dreamina-image' }>
  prompt: string
  /** 参考图路径；非空时走 image2image，最多 10 张。 */
  referenceImagePaths?: string[]
  /** 参考图授权根与工作目录，与其它执行器共用同一套校验。 */
  cwd?: string
  allowedRoots?: string[]
  aspectRatio?: string
  numberOfImages?: number
  signal?: AbortSignal
  captureRequest?: (request: ImageRequestAudit) => void
  /** 生成结果的等待上限；缺省 4 分钟。 */
  timeoutMs?: number
  /** 自定义输出宽高（像素）；与宽高比互斥，且必须同时给出。 */
  width?: number
  height?: number
  /** 轮询间隔；缺省 3 秒。 */
  pollIntervalMs?: number
}

export interface DreaminaImageOutput {
  bytes: Uint8Array
  contentType: string
}

/** 单次请求允许生成的图片数量上限。 */
const MAX_IMAGE_COUNT = 4
/** 即梦图生图允许的参考图数量上限，来自 CLI 说明。 */
const MAX_REFERENCE_IMAGE_COUNT = 10
/** 默认等待生成完成的时长。 */
const DEFAULT_TIMEOUT_MS = 4 * 60_000
/** 默认轮询间隔。 */
const DEFAULT_POLL_INTERVAL_MS = 3_000
/** 单次 CLI 调用超时，避免轮询或提交挂死。 */
const CLI_TIMEOUT_MS = 60_000
/** 即梦支持的宽高比；不在表内的取值不传 --ratio。 */
const SUPPORTED_ASPECT_RATIOS = new Set(['1:1', '3:4', '16:9', '4:3', '9:16', '21:9', '3:2', '2:3'])

/**
 * 各分辨率档位的边长与总像素上限，来自 `dreamina image2image -h`。
 * 两个约束必须同时满足，后端配置仍是最终权威。
 */
const RESOLUTION_LIMITS: Record<string, { minSide: number; maxSide: number; maxPixels: number }> = {
  '1k': { minSide: 512, maxSide: 2016, maxPixels: 1_763_584 },
  '1.5k': { minSide: 972, maxSide: 2268, maxPixels: 2_359_296 },
  '2k': { minSide: 768, maxSide: 3072, maxPixels: 4_194_304 },
  '4k': { minSide: 1536, maxSide: 6240, maxPixels: 16_777_216 },
}

const defaultDependencies: DreaminaImageGenerationDependencies = {
  runCli: runDreaminaCli,
  createTempDir: () => mkdtemp(join(tmpdir(), 'proma-dreamina-')),
  removeTempDir: (path) => rm(path, { recursive: true, force: true }),
}

/** 提交与查询结果的最小结构。 */
interface DreaminaTaskPayload {
  submitId: string
  status: string
  failReason: string
  imagePaths: string[]
}

/** 只允许本模块产生的受控错误离开生成边界。 */
class DreaminaGenerationError extends Error {}
/**
 * 生成图片字节，不创建会话附件；错误不包含 CLI 原始输出或系统路径。
 * @param input 模型路由、生成参数和已授权参考路径。
 * @param dependencies 可选 CLI 与临时目录实现。
 * @returns 已按真实格式验证的媒体字节。
 */
export async function generateDreaminaImages(input: GenerateDreaminaImagesInput, dependencies: DreaminaImageGenerationDependencies = defaultDependencies): Promise<DreaminaImageOutput[]> {
  try { return await generateImages(input, dependencies) }
  catch (error) {
    if (error instanceof DreaminaGenerationError) throw error
    throw new DreaminaGenerationError('即梦生成失败，请检查本机 CLI 和媒体文件')
  }
}
/** 执行一次即梦生成与安全收集，临时目录在所有出口清理。 */
async function generateImages(
  input: GenerateDreaminaImagesInput,
  dependencies: DreaminaImageGenerationDependencies = defaultDependencies,
): Promise<DreaminaImageOutput[]> {
  assertActive(input.signal)
  const prompt = input.prompt.trim()
  if (!prompt) throw new DreaminaGenerationError('生图提示词不能为空')
  /** 参考图必须通过授权目录校验；超限或越界都在调用 CLI 前拒绝。 */
  input = { ...input, route: { ...input.route, resolutionType: resolveResolution(input) } }
  const references = readReferences(input)
  if (references.length > MAX_REFERENCE_IMAGE_COUNT) {
    throw new DreaminaGenerationError(`即梦图生图最多支持 ${MAX_REFERENCE_IMAGE_COUNT} 张参考图`)
  }
  const count = normalizeImageCount(input.numberOfImages)
  const cliPath = input.route.cliPath?.trim() || 'dreamina'
  const workDir = await dependencies.createTempDir()
  try {
    input.captureRequest?.({
      executor: 'dreamina-image',
      modelId: input.route.snapshot.modelId,
      prompt,
      referenceImages: references.map((reference) => ({
        path: reference.path,
        sha256: createHash('sha256').update(reference.bytes).digest('hex'),
        byteSize: reference.bytes.length,
      })),
    })
    const submitted = await submitTask(input, dependencies, cliPath, prompt, count, references)
    const payload = await waitForResult(input, dependencies, cliPath, submitted, workDir)
    return readResults(input, payload.imagePaths, workDir)
  } finally {
    /** 临时下载目录只承载中间产物，落附件后必须清理。 */
    await dependencies.removeTempDir(workDir).catch(() => undefined)
  }
}

/** 提交文生图任务并解析 submit_id。 */
async function submitTask(
  input: GenerateDreaminaImagesInput,
  dependencies: DreaminaImageGenerationDependencies,
  cliPath: string,
  prompt: string,
  count: number,
  references: readonly { path: string }[],
): Promise<string> {
  const params = input.route.snapshot
  /** 有参考图就是编辑任务，必须走 image2image，而不是把参考图丢掉。 */
  const args = references.length > 0
    ? [
        'image2image',
        `--prompt=${prompt}`,
        `--model_version=${params.modelId}`,
        ...references.map((reference) => `--images=${reference.path}`),
        `--generate_num=${count}`,
        '--poll=0',
      ]
    : [
        'text2image',
        `--prompt=${prompt}`,
        `--model_version=${params.modelId}`,
        `--generate_num=${count}`,
        '--poll=0',
      ]
  args.push(`--resolution_type=${input.route.resolutionType}`)
  const ratio = resolveAspectRatio(input.aspectRatio)
  /** 自定义尺寸与宽高比互斥，CLI 不接受同时传入。 */
  const size = resolveCustomSize(input)
  if (size) args.push(`--width=${size.width}`, `--height=${size.height}`)
  else if (ratio) args.push(`--ratio=${ratio}`)
  assertActive(input.signal)
  const result = await callCli(dependencies, args, cliPath, input.signal)
  assertActive(input.signal)
  assertCliAvailable(result)
  /** 需要网页确认等情况 CLI 不返回 JSON，必须先识别提示再尝试解析。 */
  const failure = describeCliFailure(result)
  if (failure) throw new DreaminaGenerationError(failure)
  const payload = parseTaskPayload(result.stdout)
  if (!payload.submitId) throw new DreaminaGenerationError('即梦未返回任务 ID，提交失败')
  return payload.submitId
}

/** 轮询直到终态；超时或取消都立即结束并给出明确原因。 */
async function waitForResult(
  input: GenerateDreaminaImagesInput,
  dependencies: DreaminaImageGenerationDependencies,
  cliPath: string,
  submitId: string,
  workDir: string,
): Promise<DreaminaTaskPayload> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const intervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const deadline = Date.now() + timeoutMs
  while (true) {
    assertActive(input.signal)
    const result = await callCli(dependencies,
      ['query_result', `--submit_id=${submitId}`, `--download_dir=${workDir}`],
      cliPath,
      input.signal,
    )
    assertActive(input.signal)
    assertCliAvailable(result)
    /** CLI 退出状态优先于成功载荷；非 JSON 登录失败也保留受控提示。 */
    const failure = describeCliFailure(result)
    let payload: DreaminaTaskPayload
    try { payload = parseTaskPayload(result.stdout) }
    catch (error) { if (failure) throw new DreaminaGenerationError(failure); throw error }
    /** 结构化业务失败仅映射已知安全原因，不能回传原始 fail_reason。 */
    if (payload.status === 'fail') {
      throw new DreaminaGenerationError(payload.failReason === '内容安全审核未通过' ? '内容安全审核未通过' : '即梦生成失败')
    }
    if (failure) throw new DreaminaGenerationError(failure)
    if (payload.status === 'success') return payload
    if (Date.now() >= deadline) {
      throw new DreaminaGenerationError('即梦生成超时，远端任务可能仍在进行，可在即梦客户端查看')
    }
    await sleep(intervalMs, input.signal)
  }
}

/** 每个文件最多 32 MiB，且整体结果数量不能超过执行合同。 */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
/** 按字节识别被动图片格式，不相信文件后缀。 */
function imageMime(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  throw new DreaminaGenerationError('即梦返回的文件不是支持的图片')
}
/** 安全读取私有根内的普通文件，拒绝链接与越界，统一隐藏系统路径错误。 */
function safeImage(path: string, root: string): Buffer {
  const lexicalRoot = resolve(root)
  const lexicalPath = resolve(path)
  if (!lexicalPath.startsWith(`${lexicalRoot}${sep}`)) throw new DreaminaGenerationError('即梦返回的图片路径不在任务目录内，已拒绝读取')
  try {
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new DreaminaGenerationError('目录不安全')
    const realRoot = realpathSync(root)
    return readInteractionFile(interactionSourcePath(realRoot, relative(lexicalRoot, lexicalPath)), MAX_IMAGE_BYTES)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DreaminaGenerationError('即梦返回的图片文件不存在')
    throw new DreaminaGenerationError('即梦图片文件不安全或超过大小限制')
  }
}
/** 授权根先做词法边界校验，再通过 no-follow 有界读取，不依赖附件模块。 */
function readReferences(input: GenerateDreaminaImagesInput): Array<{ path: string; bytes: Buffer }> {
  const paths = input.referenceImagePaths ?? []
  if (paths.length > MAX_REFERENCE_IMAGE_COUNT) throw new DreaminaGenerationError('即梦图生图最多支持 10 张参考图')
  const roots = [input.cwd, ...(input.allowedRoots ?? [])].filter((root): root is string => Boolean(root?.trim()))
  let total = 0
  return paths.map(path => {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(input.cwd ?? '', path)
    const root = roots.find(candidate => absolute.startsWith(`${resolve(candidate)}${sep}`))
    if (!root) throw new DreaminaGenerationError('参考图不在授权目录内')
    const bytes = safeImage(absolute, root)
    imageMime(bytes)
    total += bytes.length
    if (total > 100 * 1024 * 1024) throw new DreaminaGenerationError('参考图总大小不能超过 100 MiB')
    return { path: join(realpathSync(root), relative(resolve(root), absolute)), bytes }
  })
}
/** 只从本次私有下载目录收集真实媒体字节，不产生会话附件。 */
function readResults(input: GenerateDreaminaImagesInput, paths: readonly string[], root: string): DreaminaImageOutput[] {
  if (!paths.length || paths.length > MAX_IMAGE_COUNT) throw new DreaminaGenerationError('即梦返回的图片数量无效')
  return paths.map(path => {
    assertActive(input.signal)
    const bytes = safeImage(path, root)
    return { bytes, contentType: imageMime(bytes) }
  })
}

/** 隔离 CLI/注入运行器的异常，不泄漏 stderr、系统路径或请求内容。 */
async function callCli(dependencies: DreaminaImageGenerationDependencies, args: readonly string[], cliPath: string, signal?: AbortSignal): Promise<DreaminaCliResult> {
  try { return await dependencies.runCli(args, cliPath, signal) }
  catch { assertActive(signal); throw new DreaminaGenerationError('即梦 CLI 执行失败，提交结果未知') }
}

/** CLI 缺失或超时统一转成可操作提示。 */
function assertCliAvailable(result: DreaminaCliResult): void {
  if (result.failureCode === 'cliMissing') throw new DreaminaGenerationError('未找到即梦 CLI，请检查安装或 cliPath 配置')
  if (result.failureCode === 'timeout') throw new DreaminaGenerationError('即梦 CLI 调用超时，请检查网络后重试')
}

/** 从 CLI 输出里识别需要用户先去网页确认的情况。 */
function describeCliFailure(result: DreaminaCliResult): string | null {
  const output = `${result.stdout}\n${result.stderr}`
  if (output.includes('AigcComplianceConfirmationRequired')) {
    return '该模型需要先在即梦网页端完成一次生成确认，请到即梦 Web 完成后再重试'
  }
  /** 只有明确登录错误才指导重新登录；未知退出可能发生在远端已接受提交之后。 */
  if (result.exitCode !== 0 && /not logged in|login required|please log(?:in| in)|未登录|登录(?:态)?(?:已)?失效/i.test(output)) return '即梦 CLI 执行失败，请检查登录态'
  if (result.exitCode !== 0) return '即梦 CLI 执行失败，提交结果未知'
  return null
}

/** 解析 CLI 的 JSON 输出；即梦在纯文本错误时也应给出可读提示。 */
function parseTaskPayload(stdout: string): DreaminaTaskPayload {
  const matched = /\{[\s\S]*\}/.exec(stdout)
  if (!matched) throw new DreaminaGenerationError('即梦返回内容无法解析')
  let parsed: unknown
  try {
    parsed = JSON.parse(matched[0])
  } catch {
    throw new DreaminaGenerationError('即梦返回内容无法解析')
  }
  if (parsed === null || typeof parsed !== 'object') throw new DreaminaGenerationError('即梦返回内容无法解析')
  const record = parsed as Record<string, unknown>
  const images = (record.result_json as { images?: unknown } | undefined)?.images
  return {
    submitId: typeof record.submit_id === 'string' ? record.submit_id : '',
    status: typeof record.gen_status === 'string' ? record.gen_status : '',
    failReason: typeof record.fail_reason === 'string' ? record.fail_reason : '',
    imagePaths: Array.isArray(images)
      ? images.flatMap((item) => (item !== null && typeof item === 'object' && typeof (item as { path?: unknown }).path === 'string'
        ? [(item as { path: string }).path]
        : []))
      : [],
  }
}

/** 归一化生成张数；非法值回落到 1。 */
function normalizeImageCount(value: number | undefined): number {
  if (value === undefined) return 1
  if (!Number.isSafeInteger(value) || value < 1) return 1
  return Math.min(value, MAX_IMAGE_COUNT)
}

/** 把画布宽高比映射到 CLI 支持的取值。 */
function resolveAspectRatio(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return SUPPORTED_ASPECT_RATIOS.has(value) ? value : undefined
}

/**
 * 校验并解析自定义尺寸。
 * 入参：执行输入；返回值：合法宽高，未指定时返回 null。
 * 规则来自 CLI 说明：必须同时给出正整数、落在所选分辨率档位的边长与总像素上限内。
 */
function resolveCustomSize(input: GenerateDreaminaImagesInput): { width: number; height: number } | null {
  const { width, height } = input
  if (width === undefined && height === undefined) return null
  if (width === undefined || height === undefined) {
    throw new DreaminaGenerationError('自定义尺寸必须同时提供 width 与 height')
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new DreaminaGenerationError('自定义尺寸必须为正整数')
  }
  /** 档位来自模型参数；未知档位时按 2k 处理，与内置默认一致。 */
  const resolutionType = input.route.resolutionType ?? '2k'
  const limits = RESOLUTION_LIMITS[resolutionType.toLowerCase()] ?? RESOLUTION_LIMITS['2k']!
  const withinSide = width >= limits.minSide && width <= limits.maxSide
    && height >= limits.minSide && height <= limits.maxSide
  const withinPixels = width * height <= limits.maxPixels
  if (!withinSide || !withinPixels) {
    throw new DreaminaGenerationError(`自定义尺寸超出 ${resolutionType} 档位限制：每边需在 ${limits.minSide}-${limits.maxSide}，总像素不超过 ${limits.maxPixels}`)
  }
  return { width, height }
}

/** 校验模型与分辨率组合；未知模型不推测 CLI 能力。 */
function resolveResolution(input: GenerateDreaminaImagesInput): string {
  const model = input.route.snapshot.modelId
  const choices = /^3\./.test(model) ? ['1k', '2k'] : model === '5.0Pro' ? ['1.5k', '2k', '4k'] : /^4\./.test(model) || model === '5.0' ? ['2k', '4k'] : []
  const resolution = input.route.resolutionType ?? (/^3\./.test(model) ? '1k' : '2k')
  if (!choices.includes(resolution)) throw new DreaminaGenerationError('即梦模型与分辨率组合不受支持')
  /** 3.0/3.1 的自定义宽高仅支持 2k，不将默认 1k 静默提升。 */
  if ((model === '3.0' || model === '3.1') && (input.width !== undefined || input.height !== undefined) && resolution !== '2k') throw new DreaminaGenerationError('即梦 3.0/3.1 自定义尺寸必须使用 2k 分辨率')
  return resolution
}
/** 不透传自定义取消原因，避免请求内容进入错误输出。 */
function assertActive(signal?: AbortSignal): void { if (signal?.aborted) throw new DreaminaGenerationError('即梦生成已取消，本机已停止等待，远端任务可能仍在运行') }
/** 可被取消的等待；监听器在成功和取消时都移除。 */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  assertActive(signal)
  await new Promise<void>((resolveSleep, rejectSleep) => {
    const onAbort = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); rejectSleep(new DreaminaGenerationError('即梦生成已取消，本机已停止等待，远端任务可能仍在运行')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolveSleep() }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}
/**
 * 以参数数组启动 CLI；取消立即终止本机子进程，不承诺远端取消。
 * @param args CLI 参数，不经过 shell。
 * @param cliPath 用户配置的可执行路径。
 * @param signal 可选本机取消信号，旧两参数调用兼容。
 */
export async function runDreaminaCli(args: readonly string[], cliPath: string, signal?: AbortSignal): Promise<DreaminaCliResult> {
  assertActive(signal)
  const { spawn } = await import('node:child_process')
  assertActive(signal)
  return await new Promise<DreaminaCliResult>((resolveResult, rejectResult) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    const limit = 256 * 1024
    const child = spawn(cliPath, [...args], { stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
    const finish = (result: DreaminaCliResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolveResult(result)
    }
    const onAbort = (): void => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      cleanup()
      rejectResult(new DreaminaGenerationError('即梦生成已取消，本机进程已终止，远端任务可能仍在运行'))
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ exitCode: 1, stdout, stderr, failureCode: 'timeout' })
    }, CLI_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8').slice(0, Math.max(0, limit - stdout.length)) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8').slice(0, Math.max(0, limit - stderr.length)) })
    child.once('error', () => finish({ exitCode: 1, stdout, stderr, failureCode: 'cliMissing' }))
    child.once('close', code => finish({ exitCode: code ?? 1, stdout, stderr }))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}
