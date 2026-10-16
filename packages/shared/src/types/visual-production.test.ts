import { describe, expect, it } from 'bun:test'
import { parseVisualProductionCommand, parseVisualProductionDraft, parseVisualProductionRelativePath } from './visual-production-validation'
import type { VisualProductionDraft } from './visual-production'

/** 最小真实作品，供边界测试独立修改。 */
const draft = (): VisualProductionDraft => ({ title: '第一支影片', kind: 'film', brief: '', ratio: '16:9', fps: 24, voice: '', music: '', episodes: [{ id: 'ep1', title: '第一集' }], assets: [{ id: 'a1', name: '主角', type: '角色', description: '', locked: false, mediaId: null }], shots: [{ id: 's1', episodeId: 'ep1', title: '开场', duration: 5, scene: '', motion: '', dialogue: '', assetIds: ['a1'], mediaId: null }] })

describe('影像创作请求合同', () => {
  it('Given 合法作品 When 解析保存请求 Then 保留关联且生成独立对象', () => {
    const input = draft()
    const result = parseVisualProductionCommand({ method: 'save', input: { sessionId: 'session1', productionId: 'p1', baseRevision: 1, draft: input } })
    expect(result.method).toBe('save')
    if (result.method !== 'save') throw new Error('错误命令')
    expect(result.input.draft).toEqual(input)
    expect(result.input.draft.shots).not.toBe(input.shots)
  })
  it('Given 断开的资产或集数引用 When 保存 Then 拒绝而不是静默丢失', () => {
    const input = draft()
    input.shots[0]!.assetIds = ['missing']
    expect(() => parseVisualProductionDraft(input)).toThrow()
    input.shots[0]!.assetIds = ['a1']
    input.shots[0]!.episodeId = 'missing'
    expect(() => parseVisualProductionDraft(input)).toThrow()
  })
  it('Given 未知字段、重复身份、原型属性身份或非法时长 Then 拒绝', () => {
    expect(() => parseVisualProductionDraft({ ...draft(), root: '/tmp' })).toThrow()
    const input = draft()
    input.assets.push({ ...input.assets[0]! })
    expect(() => parseVisualProductionDraft(input)).toThrow()
    expect(() => parseVisualProductionCommand({ method: 'load', input: { sessionId: 's', productionId: '__proto__' } })).toThrow()
    for (const duration of [0, -1, NaN, Infinity, 601]) {
      const value = draft()
      value.shots[0]!.duration = duration
      expect(() => parseVisualProductionDraft(value)).toThrow()
    }
  })
  it('Given 图片作品 When 时长为零 Then 允许静态作品', () => {
    const input = draft()
    input.kind = 'image'
    input.shots[0]!.duration = 0
    expect(parseVisualProductionDraft(input).shots[0]!.duration).toBe(0)
  })
  it('Given 来源路径穿越/绝对路径或未知方法 Then 拒绝', () => {
    for (const path of ['/tmp/a.png', '../a.png', 'x/../a.png', 'x/./a.png', 'C:\\a.png', 'https://example.com/a', 'a\0.png', '.proma/secret']) expect(() => parseVisualProductionRelativePath(path)).toThrow()
    expect(parseVisualProductionRelativePath('assets/主角.png')).toBe('assets/主角.png')
    expect(() => parseVisualProductionCommand({ method: 'removeRoot', input: { sessionId: 's' } })).toThrow()
    expect(() => parseVisualProductionCommand({ method: 'list', input: { sessionId: 's', projectRoot: '/tmp' } })).toThrow()
  })
  it('Given 候选/媒体导入 When 缺任务身份或媒体身份不匹配 Then 拒绝', () => {
    expect(() => parseVisualProductionCommand({ method: 'propose', input: { sessionId: 's', productionId: 'p', baseRevision: 1, draft: draft(), summary: '候选' } })).toThrow()
    expect(() => parseVisualProductionCommand({ method: 'importMedia', input: { sessionId: 's', productionId: 'p', reference: { assetId: 'm', revision: 1, hash: 'bad', mediaKind: 'image' } } })).toThrow()
  })
  it('Given 超预算正文 When 保存 Then 拒绝无界复制', () => {
    expect(() => parseVisualProductionDraft({ ...draft(), brief: '长'.repeat(16001) })).toThrow()
  })
})
