import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MediaAssetRef, MediaGenerationRequest, MediaInputValue } from '@dutydeck/shared'
import { generateDreaminaImages } from '../chat-tools/dreamina-image-generation'
import type { DreaminaImageGenerationDependencies } from '../chat-tools/dreamina-image-generation'
import { detectMediaFileSignature } from './media-file-probe'
import { MediaGenerationUserError, scalarInput } from './unified-media-generation-service'
import type { UnifiedMediaGenerationAdapter } from './unified-media-generation-service'
import type { UnifiedMediaModelRoute } from './unified-media-model-catalog'

/** 宿主按项目读取可信资产；测试仅替换 CLI，不调用真实生成服务。 */
export interface UnifiedDreaminaImageAdapterOptions {
  readAsset(projectId: string, reference: MediaAssetRef): Promise<Uint8Array>
  generationDependencies?: DreaminaImageGenerationDependencies
}
/** 当前 CLI 接受的图片比例；自定义尺寸与比例互斥。 */
const RATIOS = new Set(['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'])
/** 只消费明确接入的标量，未知输入不能被静默忽略。 */
const PARAMETERS = new Set(['ratio', 'count', 'resolution_type', 'width', 'height'])

/** 校验生成参数并冻结真正提交的默认值；只读纯计算，不检查在线登录。 */
function prepareInputs({ request, route }: { request: MediaGenerationRequest; route: UnifiedMediaModelRoute }): Record<string, MediaInputValue> {
  if (route.ref.provider !== 'dreamina' || route.ref.kind !== 'image' || route.option.adapterId !== 'dreamina-image') throw new Error('MEDIA_MODEL_UNAVAILABLE')
  /** 拷贝输入以保留原始请求，参考资产身份由媒体服务继续验证。 */
  const inputs = structuredClone(request.inputs)
  for (const [key, value] of Object.entries(inputs)) {
    if (value.kind === 'scalar' && !PARAMETERS.has(key)) throw new Error('MEDIA_DREAMINA_PARAMETER_INVALID')
    if (value.kind === 'asset' && (PARAMETERS.has(key) || value.asset.mediaKind !== 'image')) throw new Error('MEDIA_DREAMINA_REFERENCE_INVALID')
  }
  /** 默认分辨率取全局已选模型设置，不以 UI 通用默认覆盖。 */
  const resolution = scalarInput(inputs, 'resolution_type') ?? route.resolutionType ?? (['3.0', '3.1'].includes(route.ref.modelId) ? '1k' : '2k')
  const resolutions = route.ref.modelId === '5.0Pro' ? ['1.5k', '2k', '4k'] : ['3.0', '3.1'].includes(route.ref.modelId) ? ['1k', '2k'] : ['2k', '4k']
  const count = scalarInput(inputs, 'count') ?? 1
  const ratio = scalarInput(inputs, 'ratio')
  const width = scalarInput(inputs, 'width')
  const height = scalarInput(inputs, 'height')
  if (typeof resolution !== 'string' || !resolutions.includes(resolution)
    || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > 4
    || (ratio !== undefined && (typeof ratio !== 'string' || !RATIOS.has(ratio)))
    || ((width === undefined) !== (height === undefined))
    || (width !== undefined && ['3.0', '3.1'].includes(route.ref.modelId) && resolution !== '2k')
    || (width !== undefined && (typeof width !== 'number' || !Number.isSafeInteger(width) || width <= 0 || ratio !== undefined))
    || (height !== undefined && (typeof height !== 'number' || !Number.isSafeInteger(height) || height <= 0))) throw new Error('MEDIA_DREAMINA_PARAMETER_INVALID')
  inputs.resolution_type = { kind: 'scalar', value: resolution }
  inputs.count = { kind: 'scalar', value: count }
  return inputs
}

/** 将生成核心的已知错误映射成固定提示，绝不把 CLI 原始输出传到界面或 Agent。 */
function visibleError(error: unknown): Error {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('未找到即梦 CLI')) return new MediaGenerationUserError('未找到即梦 CLI，请在媒体设置中检查 CLI 路径。')
  if (message.includes('网页端完成一次生成确认')) return new MediaGenerationUserError('请先到即梦网页完成此模型的生成确认，再重试。')
  if (message.includes('登录态')) return new MediaGenerationUserError('即梦 CLI 调用失败，请在媒体设置中检查本机登录状态。')
  if (message.includes('超时')) return new MediaGenerationUserError('即梦等待超时，远端任务可能仍在运行；请先在即梦中查看，避免重复生成。')
  if (message === '内容安全审核未通过') return new MediaGenerationUserError('即梦内容审核未通过，请调整提示词。')
  if (message.includes('自定义尺寸')) return new MediaGenerationUserError('自定义宽高不符合当前即梦分辨率要求，请调整尺寸。')
  if (message.startsWith('MEDIA_')) return new Error(message)
  return new MediaGenerationUserError('即梦图片生成失败，请检查模型与即梦任务状态后重试。')
}

/**
 * 将统一媒体引用交给既有即梦图片核心，产物仍由统一服务登记为项目资产。
 * @param options 宿主资产读取与可选隔离测试依赖。
 * @returns 不创建聊天附件、不读取任意本地路径的图片适配器。
 */
export function createUnifiedDreaminaImageAdapter(options: UnifiedDreaminaImageAdapterOptions): UnifiedMediaGenerationAdapter {
  return { id: 'dreamina-image', prepareInputs, async generate({ request, route, signal }) {
    signal.throwIfAborted()
    /** 直接调用适配器也执行同一参数校验，不能绕过准备入口。 */
    const inputs = prepareInputs({ request, route })
    const references = Object.values(inputs).filter((value): value is Extract<MediaInputValue, { kind: 'asset' }> => value.kind === 'asset')
    if (references.length > 10) throw new Error('MEDIA_GENERATION_MULTIPLE_REFERENCES_UNSUPPORTED')
    if (references.length && !route.option.capabilities.includes('image-to-image')) throw new Error('MEDIA_GENERATION_INPUT_INVALID')
    /** CLI 仅接收私有临时副本，主目录与资产内部路径不会暴露给模型参数。 */
    const directory = await mkdtemp(join(tmpdir(), 'dutydeck-dreamina-references-'))
    try {
      const paths: string[] = []
      let totalBytes = 0
      for (const [index, reference] of references.entries()) {
        signal.throwIfAborted()
        const bytes = await options.readAsset(request.projectId, reference.asset)
        signal.throwIfAborted()
        totalBytes += bytes.byteLength
        if (!bytes.byteLength || bytes.byteLength > 32 * 1024 * 1024 || totalBytes > 100 * 1024 * 1024) throw new Error('MEDIA_DREAMINA_REFERENCE_LIMIT_EXCEEDED')
        const signature = detectMediaFileSignature(bytes)
        if (signature.mediaKind !== 'image') throw new Error('MEDIA_DREAMINA_REFERENCE_INVALID')
        const path = join(directory, `reference-${index + 1}${signature.extension}`)
        await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
        paths.push(path)
      }
      return await generateDreaminaImages({
        route: { executor: 'dreamina-image', snapshot: { executor: 'dreamina-image', profileId: `imagegen:${route.ref.profileId}:${route.ref.modelId}`, imageProfileId: route.ref.profileId, modelId: route.ref.modelId, name: route.option.name }, cliPath: route.cliPath, resolutionType: String(scalarInput(inputs, 'resolution_type')) },
        prompt: request.prompt, referenceImagePaths: paths, cwd: directory, signal,
        numberOfImages: Number(scalarInput(inputs, 'count')),
        ...(scalarInput(inputs, 'ratio') !== undefined ? { aspectRatio: String(scalarInput(inputs, 'ratio')) } : {}),
        ...(scalarInput(inputs, 'width') !== undefined ? { width: Number(scalarInput(inputs, 'width')), height: Number(scalarInput(inputs, 'height')) } : {}),
      }, options.generationDependencies)
    } catch (error) {
      signal.throwIfAborted()
      throw visibleError(error)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  } }
}
