import { describe, expect, it } from 'bun:test'
import type { VisualProductionDocument } from '@proma/shared'
import { buildVisualRelationGraph, getVisualRelationFocus } from './visual-relation-graph'

/** 两集共用同一角色，另有未引用资产与空集数，覆盖真实制作的共享和孤立对象。 */
function fixture(): VisualProductionDocument {
  return {
    schemaVersion: 1, id: 'production', revision: 1, createdAt: 1, updatedAt: 1,
    title: '刑场初醒', kind: 'comic', brief: '', ratio: '9:16', fps: 24, voice: '', music: '',
    episodes: [{ id: 'ep1', title: '第 1 集' }, { id: 'ep2', title: '第 2 集' }, { id: 'empty', title: '待制作' }],
    assets: [{ id: 'shared', name: '沈砚', type: '角色', description: '', locked: true, mediaId: null }, { id: 'unused', name: '古镜', type: '道具', description: '', locked: false, mediaId: null }],
    shots: [
      { id: 's1', title: '醒来', episodeId: 'ep1', assetIds: ['shared'], mediaId: null, duration: 3, scene: '', motion: '', dialogue: '' },
      { id: 's2', title: '重查', episodeId: 'ep2', assetIds: ['shared'], mediaId: 'frame', duration: 3, scene: '', motion: '', dialogue: '' },
    ],
  }
}

describe('影像关系画布的正式数据投影', () => {
  it('Given 两集共用角色 When 查看全部 Then 资产只出现一次且每个镜头只连接真实资产与所属集数', () => {
    /** 保存原始输入，证明浏览关系不会修改正式内容。 */
    const document = fixture()
    const before = JSON.stringify(document)
    const graph = buildVisualRelationGraph(document, {}, null)
    expect(graph.nodes.filter(node => node.id === 'asset:shared')).toHaveLength(1)
    expect(graph.nodes).toHaveLength(7)
    expect(new Set(graph.edges.map(edge => `${edge.source}->${edge.target}`))).toEqual(new Set(['asset:shared->shot:s1', 'asset:shared->shot:s2', 'shot:s1->episode:ep1', 'shot:s2->episode:ep2']))
    expect(graph.nodes.find(node => node.id === 'asset:unused')?.data.status).toBe('尚未引用')
    expect(graph.nodes.find(node => node.id === 'episode:empty')?.data.status).toBe('0 个镜头')
    expect(JSON.stringify(document)).toBe(before)
  })

  it('Given 未生成与过期画面均 needsUpdate When 展示状态 Then 未生成不会被误标为待更新', () => {
    const graph = buildVisualRelationGraph(fixture(), { s1: { revision: 1, outputVersion: 0, needsUpdate: true }, s2: { revision: 2, outputVersion: 1, needsUpdate: true } }, null)
    expect(graph.nodes.find(node => node.id === 'shot:s1')?.data).toMatchObject({ status: '未生成', needsUpdate: false })
    expect(graph.nodes.find(node => node.id === 'shot:s2')?.data).toMatchObject({ status: '待更新', needsUpdate: true })
    expect(buildVisualRelationGraph(fixture(), {}, null).nodes.find(node => node.id === 'shot:s2')?.data.status).toBe('已采用')
  })

  it('Given 共享资产与多集 When 筛选一集 Then 保留该集引用但不混入另一集镜头', () => {
    const graph = buildVisualRelationGraph(fixture(), {}, 'ep2')
    expect(new Set(graph.nodes.map(node => node.id))).toEqual(new Set(['asset:shared', 'shot:s2', 'episode:ep2']))
    expect(graph.edges).toHaveLength(2)
    expect(graph.nodes.find(node => node.id === 'asset:shared')?.data.status).toBe('1 个引用 · 已锁定')
    expect(buildVisualRelationGraph(fixture(), {}, 'empty').nodes.map(node => node.id)).toEqual(['episode:empty'])
  })

  it('Given 共享资产跨两集 When 选中集数或镜头 Then 高亮不沿共享资产扩散到另一集', () => {
    const graph = buildVisualRelationGraph(fixture(), {}, null)
    expect(getVisualRelationFocus(graph, 'episode:ep1')).toEqual(new Set(['episode:ep1', 'shot:s1', 'asset:shared']))
    expect(getVisualRelationFocus(graph, 'shot:s1')).toEqual(new Set(['episode:ep1', 'shot:s1', 'asset:shared']))
    expect(getVisualRelationFocus(graph, 'asset:shared')).toEqual(new Set(['asset:shared', 'shot:s1', 'shot:s2', 'episode:ep1', 'episode:ep2']))
    expect(getVisualRelationFocus({ ...graph, edges: [...graph.edges].reverse() }, 'asset:shared')).toEqual(getVisualRelationFocus(graph, 'asset:shared'))
    expect(getVisualRelationFocus(graph, 'deleted')).toBeNull()
  })

  it('Given 空作品或缺失引用 When 构造关系 Then 不产生虚构节点或悬空连线', () => {
    const document = fixture()
    document.shots[0]!.assetIds = ['shared', 'shared', 'missing']
    const graph = buildVisualRelationGraph(document, {}, null)
    expect(graph.edges).toHaveLength(4)
    expect(graph.edges.every(edge => graph.nodes.some(node => node.id === edge.source) && graph.nodes.some(node => node.id === edge.target))).toBe(true)
    expect(buildVisualRelationGraph({ ...document, assets: [], episodes: [], shots: [] }, {}, null)).toEqual({ nodes: [], edges: [] })
  })

  it('Given 各类别使用相同业务 ID When 构造画布 Then 节点身份不冲突且同列布局不重叠', () => {
    const document = fixture()
    document.assets[0]!.id = 's1'
    document.shots[0]!.assetIds = ['s1']
    const graph = buildVisualRelationGraph(document, {}, null)
    expect(new Set(graph.nodes.map(node => node.id)).size).toBe(graph.nodes.length)
    expect(new Set(graph.nodes.map(node => `${node.position.x}:${node.position.y}`)).size).toBe(graph.nodes.length)
  })
})
