import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VisualEditingDocument, VisualEditingExportSettings, VisualMedia } from '@dutydeck/shared'
import { execFileAsync } from '../async-command'

/** 成片编码输入；媒体字节由时间线存储在调用期间按身份读取。 */
export interface VisualEditingExportInput {
  productionId: string
  episodeId: string
  timeline: VisualEditingDocument
  settings: VisualEditingExportSettings
  sourceMedia: VisualMedia[]
  readMedia: (mediaId: string) => { bytes: Uint8Array; mime: string }
}

/** 编码器可替换依赖，测试可注入确定性执行器而不依赖开发机。 */
export interface VisualEditingExportDependencies {
  candidates?: readonly string[]
  execute?: (file: string, args: readonly string[], options: { cwd: string }) => Promise<{ stdout: string; stderr: string }>
  probe?: (file: string) => Promise<boolean>
  tempDirectory?: () => string
  registerArtifact: (bytes: Uint8Array, mime: string, name: string) => Promise<{ mediaId: string; hash: string }>
}

const DEFAULT_ENCODERS = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg']

/** 根据输出比例选择稳定的编码画布尺寸，避免播放器得到奇怪的非整数像素。 */
function outputSize(ratio: string): { width: number; height: number } {
  if (ratio === '9:16') return { width: 720, height: 1280 }
  if (ratio === '1:1') return { width: 1080, height: 1080 }
  if (ratio === '4:3') return { width: 1024, height: 768 }
  if (ratio === '3:4') return { width: 768, height: 1024 }
  return { width: 1280, height: 720 }
}

/** 临时文件扩展名只由已验证 MIME 决定，不使用用户可控名称。 */
function extension(mime: string): string {
  if (mime === 'image/png') return '.png'
  if (mime === 'image/jpeg') return '.jpg'
  if (mime === 'image/gif') return '.gif'
  if (mime === 'image/webp') return '.webp'
  if (mime === 'audio/mpeg') return '.mp3'
  if (mime === 'audio/wav') return '.wav'
  if (mime === 'video/mp4') return '.mp4'
  throw new Error('成片导出遇到不支持的媒体格式')
}

/** 转义 drawtext 的有限文字字段；字幕正文不会进入 shell。 */
function escapeDrawtext(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "\\'").replaceAll(',', '\\,').replaceAll(';', '\\;').replaceAll('%', '\\%').replaceAll('\n', '\\n').replaceAll('[', '\\[').replaceAll(']', '\\]')
}

/** 选择并验证 ffmpeg；不可用时由上层持久化明确失败任务。 */
async function resolveEncoder(dependencies: VisualEditingExportDependencies): Promise<string> {
  const candidates = dependencies.candidates ?? DEFAULT_ENCODERS
  const probe = dependencies.probe ?? (async (file: string) => {
    const result = await (dependencies.execute ?? ((candidate, args, options) => execFileAsync(candidate, args, { cwd: options.cwd, encoding: 'utf8' }).then(value => ({ stdout: String(value.stdout), stderr: String(value.stderr) }))))(file, ['-version'], { cwd: tmpdir() })
    return /^ffmpeg version /m.test(result.stdout)
  })
  for (const candidate of candidates) {
    try { if (await probe(candidate)) return candidate } catch { /* 尝试下一个受控候选。 */ }
  }
  throw new Error('成片编码器不可用，请安装 FFmpeg')
}

/** 使用 ffmpeg 将视频片段、音频轨与字幕合成真实 MP4，并登记为项目媒体。 */
export async function renderVisualEditingExport(input: VisualEditingExportInput, dependencies: VisualEditingExportDependencies): Promise<{ encoderId: string; artifactMedia: VisualMedia; artifactBytes: Uint8Array }> {
  const encoder = await resolveEncoder(dependencies)
  const execute = dependencies.execute ?? (async (file, args, options) => {
    const result = await execFileAsync(file, args, { cwd: options.cwd, encoding: 'utf8' })
    return { stdout: String(result.stdout), stderr: String(result.stderr) }
  })
  const videoTrack = input.timeline.tracks.find(track => track.kind === 'video')
  const videoClips = videoTrack?.clips ?? []
  if (!videoClips.length) throw new Error('时间线没有画面片段，无法导出成片')
  const audioTracks = input.timeline.tracks.filter(track => (track.kind === 'voice' && input.settings.includeVoice) || (track.kind === 'music' && input.settings.includeMusic))
  const audioClips = audioTracks.flatMap(track => track.clips)
  const tempRoot = dependencies.tempDirectory?.() ?? mkdtempSync(join(tmpdir(), 'dutydeck-visual-export-'))
  const shouldCleanup = !dependencies.tempDirectory
  try {
    const mediaById = new Map(input.sourceMedia.map(media => [media.id, media]))
    const args: string[] = ['-y', '-v', 'error']
    const videoInputIndexes: number[] = []
    for (const [index, clip] of videoClips.entries()) {
      if (!clip.source) throw new Error('画面片段缺少媒体来源')
      const media = mediaById.get(clip.source.mediaId)
      if (!media) throw new Error('成片引用的媒体不存在')
      const source = input.readMedia(media.id)
      const path = join(tempRoot, `video-${index}${extension(source.mime)}`)
      writeFileSync(path, source.bytes)
      videoInputIndexes.push(videoInputIndexes.length)
      if (media.kind === 'image') args.push('-loop', '1', '-t', String(clip.duration), '-i', path)
      else args.push('-ss', String(clip.sourceIn), '-t', String(clip.duration), '-i', path)
    }
    const audioInputIndexes: number[] = []
    for (const [index, clip] of audioClips.entries()) {
      if (!clip.source) continue
      const media = mediaById.get(clip.source.mediaId)
      if (!media || media.kind !== 'audio') continue
      const source = input.readMedia(media.id)
      const path = join(tempRoot, `audio-${index}${extension(source.mime)}`)
      writeFileSync(path, source.bytes)
      audioInputIndexes.push(videoInputIndexes.length + audioInputIndexes.length)
      args.push('-ss', String(clip.sourceIn), '-t', String(clip.duration), '-i', path)
    }
    const { width, height } = outputSize(input.settings.ratio)
    const filters: string[] = []
    const concatInputs = videoInputIndexes.map((index, clipIndex) => `[${index}:v]setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p[v${clipIndex}]`).join(';')
    filters.push(concatInputs)
    filters.push(`${videoInputIndexes.map((_, index) => `[v${index}]`).join('')}concat=n=${videoInputIndexes.length}:v=1:a=0[vbase]`)
    let finalVideo = 'vbase'
    if (input.settings.includeCaptions) {
      const captionClips = input.timeline.tracks.find(track => track.kind === 'caption')?.clips ?? []
      for (const [index, clip] of captionClips.entries()) {
        const text = escapeDrawtext(clip.caption?.text ?? '')
        const next = `vcaption${index}`
        filters.push(`[${finalVideo}]drawtext=text='${text}':x=(w-text_w)/2:y=h-text_h-40:enable='between(t,${clip.start},${clip.start + clip.duration})'[${next}]`)
        finalVideo = next
      }
    }
    if (audioInputIndexes.length) {
      const audioLabels = audioInputIndexes.map((index, clipIndex) => `[${index}:a]aresample=async=1[a${clipIndex}]`)
      filters.push(...audioLabels)
      filters.push(`${audioInputIndexes.map((_, index) => `[a${index}]`).join('')}amix=inputs=${audioInputIndexes.length}:duration=longest:dropout_transition=0[aout]`)
    }
    args.push('-filter_complex', filters.join(';'), '-map', `[${finalVideo}]`, '-r', String(input.settings.fps), '-c:v', 'libx264', '-pix_fmt', 'yuv420p')
    if (audioInputIndexes.length) args.push('-map', '[aout]', '-c:a', 'aac', '-shortest')
    else args.push('-an')
    args.push('-movflags', '+faststart', 'output.mp4')
    await execute(encoder, args, { cwd: tempRoot })
    const output = readFileSync(join(tempRoot, 'output.mp4'))
    if (output.length < 12 || output.subarray(4, 8).toString() !== 'ftyp') throw new Error('编码器未生成有效 MP4')
    const artifact = await dependencies.registerArtifact(output, 'video/mp4', `${input.productionId}-${input.episodeId}-v${input.timeline.revision}.mp4`)
    const outputHash = createHash('sha256').update(output).digest('hex')
    if (artifact.hash !== outputHash || artifact.mediaId !== outputHash) throw new Error('成片登记返回的媒体身份无效')
    const artifactMedia: VisualMedia = { id: outputHash, name: `${input.productionId}-${input.episodeId}-v${input.timeline.revision}.mp4`, hash: outputHash, mime: 'video/mp4', kind: 'video', byteSize: output.length, createdAt: Date.now() }
    return { encoderId: encoder, artifactMedia, artifactBytes: output }
  } finally {
    if (shouldCleanup) rmSync(tempRoot, { recursive: true, force: true })
  }
}
