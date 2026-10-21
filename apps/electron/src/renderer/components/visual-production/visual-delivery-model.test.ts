import { describe, expect, it } from 'bun:test'
import type { VisualMedia, VisualProductionSnapshot } from '@dutydeck/shared'
import { buildVisualDelivery, visualDeliveryFileName } from './visual-delivery-model'

/** 使用机器文件名复现原页面只有 UUID、无法辨认用途的情况。 */
const media: VisualMedia = { id: 'media-one', name: 'cde95bf4-ea76-4deb-8e53-5a1100a4f808', hash: 'hash', mime: 'image/png', kind: 'image', byteSize: 4096, createdAt: 1 }
/** 两集共享图片且包含尚未制作内容，覆盖去重、归属与状态边界。 */
function fixture(): VisualProductionSnapshot {
  return {
    document: { schemaVersion: 1, id: 'production', revision: 1, createdAt: 1, updatedAt: 1, title: '大胤刑警', kind: 'comic', brief: '', ratio: '16:9', fps: 24, voice: '', music: '',
      episodes: [{ id: 'episode-one', title: '醒来就在刑场' }, { id: 'episode-two', title: '调查真相' }],
      assets: [{ id: 'hero', name: '刑警林川', type: '角色', description: '', locked: true, mediaId: media.id }, { id: 'city', name: '古城', type: '场景', description: '', locked: false, mediaId: null }],
      shots: [
        { id: 'shot-one', episodeId: 'episode-one', title: '刑场苏醒', duration: 3, scene: '', motion: '', dialogue: '', assetIds: ['hero'], mediaId: media.id },
        { id: 'shot-two', episodeId: 'episode-two', title: '再次回忆', duration: 3, scene: '', motion: '', dialogue: '', assetIds: [], mediaId: media.id },
        { id: 'shot-three', episodeId: 'episode-two', title: '追踪线索', duration: 3, scene: '', motion: '', dialogue: '', assetIds: [], mediaId: null },
      ] },
    media: [media, { ...media, id: 'unused', name: '未采用的候选.png' }], shotStates: { 'shot-two': { revision: 2, outputVersion: 1, needsUpdate: true } }, assetVersions: {}, candidates: [], jobs: [],
  }
}

describe('影像素材导出', () => {
  it('Given 同镜头有独立画面影片音频 When 导出 Then 三者均保留且未绑定候选不混入', () => {
    const snapshot = fixture()
    snapshot.media.push({ ...media, id: 'video', kind: 'video', mime: 'video/mp4' }, { ...media, id: 'audio', kind: 'audio', mime: 'audio/wav' })
    snapshot.document.shots[0]!.outputs = { image: media.id, video: 'video', audio: 'audio' }
    expect(buildVisualDelivery(snapshot).items.map(item => item.id)).toEqual([media.id, 'video', 'audio'])
  })
  it('Given 镜头只有独立音频 When 整理交付 Then 音频可交付且无画面的镜头仍待制作', () => {
    /** 音频已采用不等于镜头的视觉内容已完成。 */
    const snapshot = fixture()
    snapshot.document.assets = []
    snapshot.document.shots = [{ ...snapshot.document.shots[0]!, mediaId: null, outputs: { image: null, video: null, audio: 'audio' } }]
    snapshot.media.push({ ...media, id: 'audio', kind: 'audio', mime: 'audio/wav' })
    const result = buildVisualDelivery(snapshot)
    expect(result.items.map(item => item.id)).toEqual(['audio'])
    expect(result.unmadeShots).toBe(1)
  })
  it('Given 机器文件名且跨集共享 When 整理导出列表 Then 使用业务名并去重且保留全部来源', () => {
    /** 保留副本，验证投影不改写作品或素材名称。 */
    const snapshot = fixture()
    const before = structuredClone(snapshot)
    const result = buildVisualDelivery(snapshot)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ id: media.id, title: '刑场苏醒', group: 'shot', needsUpdate: true,
      usages: [{ kind: 'shot', id: 'shot-one', episodeId: 'episode-one', label: '醒来就在刑场 · 镜头 1 · 刑场苏醒' }, { kind: 'shot', id: 'shot-two', episodeId: 'episode-two', label: '调查真相 · 镜头 1 · 再次回忆' }, { kind: 'asset', id: 'hero', label: '角色 · 刑警林川' }] })
    expect(result).toMatchObject({ unmadeShots: 1, unmadeAssets: 1 })
    expect(snapshot).toEqual(before)
  })
  it('Given 仅资产绑定的媒体 When 展示 Then 归项目资产且不混入未使用文件', () => {
    /** 只清空镜头绑定，保留同一资产文件用于验证分类。 */
    const snapshot = fixture()
    snapshot.document.shots = []
    expect(buildVisualDelivery(snapshot).items).toMatchObject([{ title: '刑警林川', group: 'asset', needsUpdate: false }])
    expect(buildVisualDelivery(snapshot).items).toHaveLength(1)
  })
  it('Given 素材元数据缺失 When 整理 Then 保留可定位的来源并显式标记不可用', () => {
    /** 缺失记录仍是正式引用，不能悄悄漏掉或改用其他媒体。 */
    const snapshot = fixture()
    snapshot.media = []
    expect(buildVisualDelivery(snapshot).items[0]).toMatchObject({ title: '刑场苏醒', media: undefined })
  })
  it('Given 图片作品且无镜头标题 When 展示 Then 使用图片序号作为可读回退', () => {
    /** 图片工作流不应继续使用镜头术语或内部 ID。 */
    const snapshot = fixture()
    snapshot.document.kind = 'image'
    snapshot.document.shots[0]!.title = ''
    expect(buildVisualDelivery(snapshot).items[0]).toMatchObject({ title: '图片 1', usages: [{ label: '醒来就在刑场 · 图片 1' }, { label: '调查真相 · 图片 1 · 再次回忆' }, { label: '角色 · 刑警林川' }] })
  })
  it('Given 无绑定素材 When 整理 Then 返回空列表并保留待制作数量', () => {
    /** 已导入但未采用的媒体不能让空态变成可交付。 */
    const snapshot = fixture()
    snapshot.document.shots.forEach(shot => { shot.mediaId = null })
    snapshot.document.assets.forEach(asset => { asset.mediaId = null })
    expect(buildVisualDelivery(snapshot)).toEqual({ items: [], unmadeShots: 3, unmadeAssets: 2 })
  })
  it('Given 标题含路径字符或伪后缀 When 下载 Then 名称安全且使用真实 MIME 后缀', () => {
    expect(visualDeliveryFileName('刑场/苏醒：画面?.exe', 'image/png')).toBe('刑场-苏醒：画面-.exe.png')
    expect(visualDeliveryFileName('配音', 'audio/mpeg')).toBe('配音.mp3')
    expect(visualDeliveryFileName('电影', 'video/mp4')).toBe('电影.mp4')
    expect(visualDeliveryFileName('作品-制作清单', 'application/json')).toBe('作品-制作清单.json')
    expect(visualDeliveryFileName(' .. ', 'unknown')).toBe('素材.bin')
    expect(visualDeliveryFileName('CON', 'image/jpeg')).toBe('_CON.jpg')
    expect(new TextEncoder().encode(visualDeliveryFileName('画'.repeat(500), 'image/png')).byteLength).toBeLessThan(240)
  })
})
