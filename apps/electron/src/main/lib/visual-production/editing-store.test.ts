import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VisualProductionDraft } from '@dutydeck/shared'
import { VisualProductionService } from './store'

/** 每个用例使用独立临时项目，避免读取真实用户数据。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** 取出作品正式文档允许编辑的字段。 */
function editable(document: VisualProductionDraft): VisualProductionDraft {
  const { title, kind, brief, ratio, fps, voice, music, episodes, assets, shots } = document
  return { title, kind, brief, ratio, fps, voice, music, episodes, assets, shots }
}

/** 创建带一个已采用图片镜头的影像作品。 */
async function fixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'visual-editing-'))
  roots.push(projectRoot)
  const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot })
  const created = await service.invoke('create', { sessionId: 'session', title: '剪辑测试', kind: 'film' })
  const target = { sessionId: 'session', productionId: created.document.id }
  writeFileSync(join(projectRoot, 'shot.png'), Buffer.from('89504e470d0a1a0a00000000', 'hex'))
  const media = await service.invoke('importFile', { ...target, relativePath: 'shot.png' })
  const episodeId = created.document.episodes[0]!.id
  const draft = { ...editable(created.document), assets: [{ id: 'asset-1', name: '产品', type: '产品', description: '', locked: false, mediaId: media.id }], shots: [{ id: 'shot-1', episodeId, title: '开场镜头', duration: 4, scene: '', motion: '', dialogue: '', assetIds: ['asset-1'], mediaId: media.id }] }
  const saved = await service.invoke('save', { ...target, baseRevision: 1, draft })
  return { service, target, episodeId, snapshot: saved }
}

describe('影像剪辑时间线存储', () => {
  it('Given 已采用镜头 When 建立粗剪 Then 只创建有媒体的连续画面片段', async () => {
    const { service, target, episodeId } = await fixture()
    const result = await service.invoke('createRoughCut', { ...target, episodeId, baseProductionRevision: 2 })
    expect(result.timeline?.tracks[0]?.clips).toHaveLength(1)
    expect(result.timeline?.tracks[0]?.clips[0]?.source?.shotId).toBe('shot-1')
    expect(result.timeline?.duration).toBe(4)
  })

  it('Given 时间线已保存 When 使用旧 revision 保存 Then 拒绝覆盖并保留正式版本', async () => {
    const { service, target, episodeId } = await fixture()
    const initial = await service.invoke('createRoughCut', { ...target, episodeId, baseProductionRevision: 2 })
    const next = structuredClone(initial.timeline!)
    next.revision = 2
    next.duration = 3
    next.tracks[0]!.clips[0]!.duration = 3
    next.tracks[0]!.clips[0]!.sourceOut = 3
    const saved = await service.invoke('saveTimeline', { ...target, episodeId, expectedRevision: 1, timeline: next })
    expect(saved.timeline?.revision).toBe(2)
    const stale = structuredClone(next)
    stale.revision = 2
    await expect(service.invoke('saveTimeline', { ...target, episodeId, expectedRevision: 1, timeline: stale })).rejects.toThrow('CONFLICT')
    expect((await service.invoke('loadTimeline', { ...target, episodeId })).timeline?.revision).toBe(2)
  })

  it('Given 镜头输出换成新媒体 When 读取旧时间线 Then 标记需要替换但保留旧片段', async () => {
    const { service, target, episodeId, snapshot } = await fixture()
    const initial = await service.invoke('createRoughCut', { ...target, episodeId, baseProductionRevision: 2 })
    const nextMediaBytes = Buffer.from('89504e470d0a1a0a00000001', 'hex')
    writeFileSync(join(roots[0]!, 'shot-2.png'), nextMediaBytes)
    const nextMedia = await service.invoke('importFile', { ...target, relativePath: 'shot-2.png' })
    const nextDraft = { ...editable(snapshot.document), shots: [{ ...snapshot.document.shots[0]!, mediaId: nextMedia.id }] }
    await service.invoke('save', { ...target, baseRevision: snapshot.document.revision, draft: nextDraft })
    const loaded = await service.invoke('loadTimeline', { ...target, episodeId })
    expect(loaded.timeline?.revision).toBe(initial.timeline?.revision)
    expect(loaded.needsReplacementClipIds).toHaveLength(1)
  })
})
