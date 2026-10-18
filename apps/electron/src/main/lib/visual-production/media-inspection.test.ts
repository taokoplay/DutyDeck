import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { inspectVisualProductionMedia } from './media-inspection'

/** 不涉及真实业务文件的固定视频字节与可信媒体身份。 */
const bytes = Buffer.from('isolated-video-snapshot')
const media = { id: createHash('sha256').update(bytes).digest('hex'), hash: createHash('sha256').update(bytes).digest('hex'), name: 'clip.mp4', mime: 'video/mp4', kind: 'video' as const, byteSize: bytes.length, createdAt: 1 }

describe('影像媒体临时检查', () => {
  test('Given 可信副本 When 抽样检查 Then 使用私有文件并在完成后清理且不改变原始字节', async () => {
    /** 保存检查时的私有路径，用于确认 finally 清理。 */
    let inspectedPath = ''
    const result = await inspectVisualProductionMedia('workspace', { sessionId: 'session', productionId: 'production', media, bytes }, undefined, {
      probe: async (path) => {
        inspectedPath = path
        expect(readFileSync(path)).toEqual(bytes)
        return { mediaKind: 'video', mediaType: 'video/mp4', extension: '.mp4', metadata: { width: 8, height: 8, durationMs: 1000, fps: 1, codec: 'h264', hasAudio: false } }
      },
      execute: async (_file, args) => ({ stdout: args.includes('image2pipe') ? new Uint8Array([1, 2, 3]) : new Uint8Array(), stderr: '' }),
    })
    expect(result.summary.evidenceHash).toBe(media.hash)
    expect(result.summary.coverage).toBe('sampled')
    expect(result.summary.unchecked).toContain('full-video-content')
    expect(existsSync(inspectedPath)).toBe(false)
    expect(bytes.toString()).toBe('isolated-video-snapshot')
  })

  test('Given 字节hash不符或已取消 When 检查 Then 在探测前拒绝', async () => {
    /** 记录是否提前调用了解码器。 */
    let probes = 0
    const probe = async (): Promise<never> => { probes++; throw new Error('unexpected probe') }
    await expect(inspectVisualProductionMedia('workspace', { sessionId: 'session', productionId: 'production', media, bytes: new Uint8Array([9]) }, undefined, { probe })).rejects.toThrow('VISUAL_MEDIA_CHANGED')
    await expect(inspectVisualProductionMedia('workspace', { sessionId: 'session', productionId: 'production', media, bytes }, AbortSignal.abort(), { probe })).rejects.toThrow()
    expect(probes).toBe(0)
  })
})
