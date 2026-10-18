import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MediaAssetRecord, MediaAssetRef, VisualMedia } from '@dutydeck/shared'
import { createMediaDeliveryInspectionService } from '../media/media-delivery-inspection-service'
import type { MediaDeliveryInspectionDependencies, MediaDeliveryInspectionResult } from '../media/media-delivery-inspection-service'
import { probeMediaFile } from '../media/media-file-probe'

/** 只接收已经由作品域读取并验证的媒体副本，不允许调用者提供路径。 */
interface VisualInspectionInput {
  /** 固定的调用会话身份。 */
  sessionId: string
  /** 固定的作品身份，仅用于调用链追溯。 */
  productionId: string
  /** 内容寻址媒体元数据。 */
  media: VisualMedia
  /** 已通过作品存储 hash 校验的字节。 */
  bytes: Uint8Array
}

/**
 * 在私有临时文件上复用媒体检查器，返回有界技术信息和抽帧，始终删除临时文件。
 * @param workspaceId 宿主已授权项目。
 * @param input 作品不可变副本及其身份。
 * @param signal 当前运行或工具的取消信号。
 * @param dependencies 测试可替换探测和解码；生产使用既有媒体实现。
 * @returns 不含本机路径的检查结论与临时样本。
 */
export async function inspectVisualProductionMedia(
  workspaceId: string,
  input: VisualInspectionInput,
  signal?: AbortSignal,
  dependencies: Pick<MediaDeliveryInspectionDependencies, 'probe' | 'execute'> = {},
): Promise<MediaDeliveryInspectionResult> {
  signal?.throwIfAborted()
  const { media, bytes } = input
  if (media.kind === 'image' || bytes.byteLength > 32 * 1024 * 1024 || bytes.byteLength !== media.byteSize
    || createHash('sha256').update(bytes).digest('hex') !== media.hash || media.id !== media.hash) throw new Error('VISUAL_MEDIA_CHANGED')
  /** 随机私有目录避免暴露作品路径，文件名只由可信媒体种类决定。 */
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-visual-inspect-'))
  try {
    signal?.throwIfAborted()
    const path = join(directory, media.kind === 'video' ? 'source.mp4' : media.mime === 'audio/wav' ? 'source.wav' : 'source.mp3')
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx', signal })
    /** 探测产出真实 metadata，不能为公共检查器伪造时长或像素上界。 */
    const probed = await (dependencies.probe ?? probeMediaFile)(path, bytes.subarray(0, 4096))
    signal?.throwIfAborted()
    if (probed.mediaKind !== media.kind || probed.mediaType !== media.mime) throw new Error('VISUAL_MEDIA_CHANGED')
    const asset: MediaAssetRef = { assetId: media.id, hash: media.hash, revision: 1, mediaKind: media.kind }
    const record = { id: media.id, hash: media.hash, revision: 1, filename: media.name, byteSize: media.byteSize, createdAt: media.createdAt,
      ...probed } as MediaAssetRecord
    const inspection = createMediaDeliveryInspectionService({
      probe: async () => probed,
      ...(dependencies.execute ? { execute: dependencies.execute } : {}),
      withAssetFile: async (context, requested, maxBytes, effect, currentSignal) => {
        currentSignal?.throwIfAborted()
        if (context.projectId !== workspaceId || context.sessionId !== input.sessionId || requested.hash !== media.hash || maxBytes < bytes.byteLength) throw new Error('VISUAL_MEDIA_CHANGED')
        return await effect({ path, asset, record })
      },
    })
    return await inspection.inspect({ projectId: workspaceId, sessionId: input.sessionId }, asset,
      { audioPolicy: 'optional', ...(media.kind === 'video' ? { visualSamples: { count: 4 } } : {}) }, signal)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
