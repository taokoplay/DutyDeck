import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderVisualEditingExport } from './visual-editing-export'
import type { VisualEditingDocument, VisualEditingExportSettings } from '@dutydeck/shared'

const timeline: VisualEditingDocument = {
  schemaVersion: 1, id: 'timeline', productionId: 'production', episodeId: 'episode', revision: 1, baseProductionRevision: 1,
  tracks: [{ id: 'video', kind: 'video', clips: [{ id: 'clip', source: { type: 'shot-media', shotId: 'shot', mediaId: 'media', mediaHash: 'a'.repeat(64), shotOutputVersion: 1 }, start: 0, duration: 1, sourceIn: 0, sourceOut: 1, label: '开场' }] }], duration: 1, createdAt: 1, updatedAt: 1,
}
const settings: VisualEditingExportSettings = { ratio: '16:9', fps: 24, includeVoice: false, includeMusic: false, includeCaptions: false }

describe('影像成片编码器', () => {
  it('Given 延迟入场的独立声音 When 导出 Then 保留镜头起点音量且不截短影片', async () => {
    const root = mkdtempSync(join(tmpdir(), 'visual-export-audio-'))
    try {
      const edit = structuredClone(timeline)
      edit.tracks.push({ id: 'voice', kind: 'voice', clips: [{ ...edit.tracks[0]!.clips[0]!, id: 'voice-clip', start: 2, volume: 0.5, source: { ...edit.tracks[0]!.clips[0]!.source!, mediaId: 'audio' } }] })
      edit.duration = 4
      let captured: readonly string[] = []
      const hash = createHash('sha256').update(Buffer.from('0000ftypisom')).digest('hex')
      await renderVisualEditingExport({ productionId: 'production', episodeId: 'episode', timeline: edit, settings: { ...settings, includeVoice: true }, sourceMedia: [{ id: 'media', name: 'frame', hash: 'a'.repeat(64), mime: 'image/png', kind: 'image', byteSize: 3, createdAt: 1 }, { id: 'audio', name: 'voice', hash: 'b'.repeat(64), mime: 'audio/wav', kind: 'audio', byteSize: 3, createdAt: 1 }], readMedia: id => ({ bytes: new Uint8Array([1, 2, 3]), mime: id === 'audio' ? 'audio/wav' : 'image/png' }) }, {
        candidates: ['fake'], probe: async () => true, tempDirectory: () => root,
        execute: async (_file, args, options) => { captured = args; writeFileSync(join(options.cwd, 'output.mp4'), Buffer.from('0000ftypisom')); return { stdout: '', stderr: '' } },
        registerArtifact: async () => ({ mediaId: hash, hash }),
      })
      expect(captured[captured.indexOf('-filter_complex') + 1]).toContain('volume=0.5,adelay=2000:all=1')
      expect(captured).not.toContain('-shortest')
      expect(captured[captured.indexOf('-t') + 1]).toBeDefined()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('Given ffmpeg 执行成功 When 编码时间线 Then 注册真实 MP4 输出并返回哈希身份', async () => {
    const root = mkdtempSync(join(tmpdir(), 'visual-export-'))
    try {
      const registered: { bytes: Uint8Array; mime: string }[] = []
      const outputHash = createHash('sha256').update(Buffer.from('0000ftypisom')).digest('hex')
      const result = await renderVisualEditingExport({ productionId: 'production', episodeId: 'episode', timeline, settings, sourceMedia: [{ id: 'media', name: 'shot.png', hash: 'a'.repeat(64), mime: 'image/png', kind: 'image', byteSize: 8, createdAt: 1 }], readMedia: () => ({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' }) }, {
        candidates: ['fake-ffmpeg'],
        execute: async (_file, args, options) => { const output = args.at(-1)!; writeFileSync(join(options.cwd, output), Buffer.from('0000ftypisom')); return { stdout: '', stderr: '' } },
        tempDirectory: () => root,
        registerArtifact: async (bytes, mime) => { registered.push({ bytes, mime }); return { mediaId: outputHash, hash: outputHash } },
        probe: async () => true,
      })
      expect(result.encoderId).toBe('fake-ffmpeg')
      expect(result.artifactMedia.id).toBe(outputHash)
      expect(Buffer.from(registered[0]!.bytes)).toEqual(Buffer.from('0000ftypisom'))
      expect(registered[0]!.mime).toBe('video/mp4')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
