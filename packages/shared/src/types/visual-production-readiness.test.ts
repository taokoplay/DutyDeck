import { describe, expect, it } from 'bun:test'
import { assessVisualEpisodeProductionReadiness } from './visual-production-readiness'
import type { VisualProductionSnapshot, VisualShot } from './visual-production'

/** 构造两镜作品，覆盖剧本、资产、视频计划、衔接合同和声音五个门。 */
function fixture(options: { videoPlan: boolean; continuityPlan: boolean; soundDesign: boolean }): VisualProductionSnapshot {
  const shots: VisualShot[] = ['s1', 's2'].map(id => ({
    id, episodeId: 'episode', title: id, duration: 4, scene: '画面', motion: '动作', dialogue: '台词',
    assetIds: ['hero'], mediaId: null,
    outputs: { image: `image-${id}`, video: null, audio: null },
    ...(options.soundDesign ? { soundDesign: { effects: '环境声', music: '配乐' } } : {}),
    ...(options.continuityPlan ? { continuityPlan: { entryState: '动作起点', exitState: '动作终点', anchors: [], audioTransition: 'hard-cut' as const, rationale: '保持动作连续' } } : {}),
    ...(options.videoPlan ? { videoPlan: { mode: 'image-to-video' as const, firstFrameAssetId: null, lastFrameAssetId: null, transitionIn: 'hard-cut' as const, rationale: '从当前画面开始' } } : {}),
  }))
  return {
    document: {
      schemaVersion: 1, id: 'production', revision: 2, createdAt: 1, updatedAt: 2,
      title: '作品', kind: 'film', brief: '', ratio: '16:9', fps: 24, voice: '', music: '',
      episodes: [{
        id: 'episode', title: '第一集',
        script: {
          logline: '故事', audiencePromise: '承诺', hook: '钩子', turningPoint: '转折', payoff: '结果',
          targetDurationSeconds: 8, productionNotes: '',
          beats: [
            { id: 'b1', title: '钩子', purpose: 'hook', dramaticQuestion: '', synopsis: '', visualAction: '', dialogue: '', sound: '', continuity: '', shotIds: ['s1'] },
            { id: 'b2', title: '结果', purpose: 'resolution', dramaticQuestion: '', synopsis: '', visualAction: '', dialogue: '', sound: '', continuity: '', shotIds: ['s2'] },
          ],
        },
      }],
      assets: [{ id: 'hero', name: '主角', type: '角色', description: '', locked: true, mediaId: 'hero-media' }],
      shots,
    },
    media: [
      { id: 'hero-media', name: '主角', hash: 'a'.repeat(64), mime: 'image/png', kind: 'image', byteSize: 1, createdAt: 1 },
      ...shots.flatMap(shot => shot.outputs?.image ? [{ id: shot.outputs.image, name: shot.id, hash: 'b'.repeat(64), mime: 'image/png' as const, kind: 'image' as const, byteSize: 1, createdAt: 1 }] : []),
    ],
    assetVersions: { hero: 1 }, shotStates: {}, candidates: [], jobs: [],
  }
}

describe('影像生产准备度', () => {
  it('Given 剧本映射完整但视频和声音未设计 When 审核 Then 阻断视频与声音阶段', () => {
    const readiness = assessVisualEpisodeProductionReadiness(fixture({ videoPlan: false, continuityPlan: false, soundDesign: false }), 'episode')
    expect(readiness.script.status).toBe('ready')
    expect(readiness.image.status).toBe('ready')
    expect(readiness.video).toMatchObject({ status: 'blocked', readyShotCount: 0, blockerCodes: ['VIDEO_PLAN_MISSING', 'CONTINUITY_PLAN_MISSING'] })
    expect(readiness.audio).toMatchObject({ status: 'blocked', readyShotCount: 0, blockerCodes: ['SOUND_DESIGN_MISSING'] })
  })

  it('Given 视频计划、衔接合同与声音设计齐备 When 审核 Then 四个阶段全部就绪', () => {
    const readiness = assessVisualEpisodeProductionReadiness(fixture({ videoPlan: true, continuityPlan: true, soundDesign: true }), 'episode')
    expect([readiness.script.status, readiness.image.status, readiness.video.status, readiness.audio.status]).toEqual(['ready', 'ready', 'ready', 'ready'])
  })

  it('Given 只有生成方式但缺少衔接合同 When 审核 Then 阻断视频阶段', () => {
    const readiness = assessVisualEpisodeProductionReadiness(fixture({ videoPlan: true, continuityPlan: false, soundDesign: true }), 'episode')
    expect(readiness.video).toMatchObject({ status: 'blocked', readyShotCount: 0, blockerCodes: ['CONTINUITY_PLAN_MISSING'] })
  })
})
