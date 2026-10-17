import type {
  AudioGenerationPublicCatalog,
  ImageGenerationMediaKind,
  ImageGenerationPublicCatalog,
  MediaApiModelCapability,
  MediaModelRef,
  UnifiedMediaModelOption,
} from '@dutydeck/shared'
import { formatMediaModelRef, imageGenerationModelKind, parseMediaModelRef, IMAGE_GENERATION_PROVIDER_DEFAULTS } from '@dutydeck/shared'

/** 统一媒体目录解析出的主进程路由；API Key 只在此对象生命周期内存在。 */
export interface UnifiedMediaModelRoute {
  option: UnifiedMediaModelOption
  ref: MediaModelRef
  baseUrl: string
  apiKey: string
  cliPath?: string
  /** 即梦模型配置的默认分辨率，执行器验证合法组合。 */
  resolutionType?: string
  groupId?: string
}

/** 统一目录只依赖各配置 Store 的公开读取与单条凭据解析。 */
export interface UnifiedMediaModelCatalogDependencies {
  readImageCatalog(): ImageGenerationPublicCatalog
  readAudioCatalog(): AudioGenerationPublicCatalog
  resolveImageApiKey(profileId: string): string
  resolveAudioApiKey(profileId: string): string
}

/** 已按本机CLI帮助核验的图片版本；新增目录模型不能自动取得执行资格。 */
const DREAMINA_IMAGE_MODELS = new Set(['3.0', '3.1', '4.0', '4.1', '4.5', '4.6', '4.7', '5.0', '5.0Pro'])

/** 将独立图片、音频配置投影成 Agent 与 Canvas 共用的模型目录。 */
export class UnifiedMediaModelCatalog {
  constructor(private readonly dependencies: UnifiedMediaModelCatalogDependencies) {}

  /** 列出当前配置快照；调用期间每个 Store 只读取一次。 */
  list(_projectId: string): UnifiedMediaModelOption[] {
    const imageCatalog = this.dependencies.readImageCatalog()
    const audioCatalog = this.dependencies.readAudioCatalog()
    const options: UnifiedMediaModelOption[] = []
    for (const profile of imageCatalog.profiles) {
      for (const model of profile.models) {
        const kind = imageGenerationModelKind(model)
        /** 即梦声明须与已核验内置能力取交集，避免旧版本伪报图生图。 */
        const dreaminaModel = profile.provider === 'dreamina' && DREAMINA_IMAGE_MODELS.has(model.id)
          ? IMAGE_GENERATION_PROVIDER_DEFAULTS.dreamina.builtinModels.find(item => item.id === model.id) : undefined
        const capabilities = model.capabilities.filter(capability => profile.provider !== 'dreamina' || dreaminaModel?.capabilities.includes(capability)).reduce<MediaApiModelCapability[]>((items, capability) => {
          if (capability === 'text-to-image' || capability === 'image-to-image' || capability === 'text-to-video' || capability === 'image-to-video') {
            items.push(capability as MediaApiModelCapability)
          }
          return items
        }, [])
        const adapterId = profile.provider === 'dreamina'
          ? kind === 'image' && dreaminaModel && capabilities.some(capability => capability === 'text-to-image' || capability === 'image-to-image') ? 'dreamina-image' : undefined
          : this.adapterForImage(profile.provider, kind, capabilities)
        const available = profile.enabled && (profile.provider === 'dreamina' || profile.credentialConfigured) && adapterId !== undefined
        options.push({
          ref: formatMediaModelRef({ kind, provider: profile.provider, profileId: profile.id, modelId: model.id }),
          name: `${profile.name} · ${model.name ?? model.id}`,
          kind,
          provider: profile.provider,
          profileId: profile.id,
          modelId: model.id,
          capabilities,
          available,
          ...(adapterId ? { adapterId } : {}),
          ...(available ? {} : { unavailableReason: !profile.enabled ? '模型已停用' : profile.provider === 'dreamina' ? kind === 'video' ? '即梦视频执行器尚未接入' : '当前即梦图片模型或能力尚未接入' : !profile.credentialConfigured ? '凭据未配置' : '执行器尚未接入' }),
        })
      }
    }
    for (const profile of audioCatalog.profiles) {
      for (const model of profile.models) {
        const adapterId = profile.provider === 'minimax' ? 'minimax-speech' : 'xiaomi-speech'
        const capabilities: MediaApiModelCapability[] = ['text-to-speech']
        const available = profile.enabled && profile.credentialConfigured
        options.push({
          ref: formatMediaModelRef({ kind: 'audio', provider: profile.provider, profileId: profile.id, modelId: model.id }),
          name: `${profile.name} · ${model.name ?? model.id}`,
          kind: 'audio', provider: profile.provider, profileId: profile.id, modelId: model.id,
          capabilities, available, adapterId,
          ...(available ? {} : { unavailableReason: !profile.enabled ? '模型已停用' : '凭据未配置' }),
        })
      }
    }
    return options
  }

  /** 按稳定引用重新读取并解析敏感路由，停用或凭据失效时 fail closed。 */
  resolve(modelRef: string): UnifiedMediaModelRoute {
    const ref = parseMediaModelRef(modelRef)
    const option = this.list('').find((candidate) => candidate.ref === modelRef)
    if (!option || !option.available || !option.adapterId) throw new Error('MEDIA_MODEL_UNAVAILABLE')
    if (ref.kind === 'audio') {
      const profile = this.dependencies.readAudioCatalog().profiles.find((candidate) => candidate.id === ref.profileId)
      if (!profile) throw new Error('MEDIA_MODEL_UNAVAILABLE')
      return { option, ref, baseUrl: profile.baseUrl, apiKey: this.dependencies.resolveAudioApiKey(profile.id), ...(profile.provider === 'minimax' && profile.groupId ? { groupId: profile.groupId } : {}) }
    }
    const profile = this.dependencies.readImageCatalog().profiles.find((candidate) => candidate.id === ref.profileId)
    if (!profile) throw new Error('MEDIA_MODEL_UNAVAILABLE')
    if (profile.provider === 'dreamina') {
      /** CLI复用本机登录态，绝不读取API密钥；未登录由执行时明确报告。 */
      const model = profile.models.find(item => item.id === ref.modelId)
      if (!model) throw new Error('MEDIA_MODEL_UNAVAILABLE')
      const resolutionType = typeof model.params?.resolution_type === 'string' ? model.params.resolution_type : ['3.0', '3.1'].includes(model.id) ? '1k' : '2k'
      return { option, ref, baseUrl: '', apiKey: '', ...(profile.cliPath ? { cliPath: profile.cliPath } : {}), resolutionType }
    }
    return { option, ref, baseUrl: profile.baseUrl, apiKey: this.dependencies.resolveImageApiKey(profile.id), ...(profile.provider === 'minimax' && profile.groupId ? { groupId: profile.groupId } : {}) }
  }

  /** 返回图片/视频协议对应的已实现 adapter；即梦 CLI 仍由图片专用链处理。 */
  private adapterForImage(provider: string, kind: ImageGenerationMediaKind, capabilities: MediaApiModelCapability[]): string | undefined {
    /** 只为已有 HTTP 合同的能力声明执行器，避免把放大或首尾帧模型误报为可执行。 */
    const executable = kind === 'image'
      ? capabilities.some((capability) => capability === 'text-to-image' || capability === 'image-to-image')
      : capabilities.some((capability) => capability === 'text-to-video' || capability === 'image-to-video')
    if (!executable) return undefined
    if (provider === 'openai-images' && kind === 'image') return 'openai-images'
    if (provider === 'minimax' && kind === 'image') return 'minimax-image'
    if (provider === 'minimax' && kind === 'video') return 'minimax-video'
    return undefined
  }
}
