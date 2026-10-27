import { describe, expect, it } from 'bun:test'
import { getBuiltinAgentModulePrompt } from '@dutydeck/shared'
import type { VisualEpisodeScript, VisualProductionSnapshot, VisualShot } from '@dutydeck/shared'
import { buildVisualScriptOverview, buildVisualScriptPrompt } from './visual-script-model'

/** 构造一集两镜作品，便于检查剧本到分镜的完整映射。 */
function fixture(script?: VisualEpisodeScript): VisualProductionSnapshot {
  const shots: VisualShot[] = [1, 2, 3].map(index => ({
    id: `shot-${index}`, episodeId: 'episode', title: `镜头 ${index}`, duration: 4,
    scene: '人物完成一个清楚动作。', motion: '从动作起点推进至终点。', dialogue: '一句有目的的台词。',
    soundDesign: { effects: '环境声。', music: '克制低频。' },
    continuityPlan: { entryState: '动作起点。', exitState: '动作终点。', anchors: [], audioTransition: 'hard-cut', rationale: '保持动作连续。' },
    videoPlan: { mode: 'image-to-video', firstFrameAssetId: null, lastFrameAssetId: null, transitionIn: 'hard-cut', rationale: '保持动作连续。' },
    assetIds: ['hero'], mediaId: `image-shot-${index}`,
    outputs: { image: `image-shot-${index}`, video: null, audio: null },
  }))
  return {
    document: {
      schemaVersion: 1, id: 'production', revision: 2, createdAt: 1, updatedAt: 2,
      title: '测试影片', kind: 'film', brief: '悬疑短剧。', ratio: '9:16', fps: 24, voice: '低声', music: '低频',
      episodes: [{ id: 'episode', title: '第一集', ...(script ? { script } : {}) }],
      assets: [{ id: 'hero', name: '主角', type: '角色', description: '灰色囚衣', locked: true, mediaId: 'hero-image' }],
      shots,
    },
    media: [
      { id: 'hero-image', name: '主角参考', hash: 'a'.repeat(64), mime: 'image/png', kind: 'image', byteSize: 1, createdAt: 1 },
      ...shots.map(shot => ({ id: shot.outputs!.image!, name: shot.id, hash: shot.id === 'shot-1' ? 'b'.repeat(64) : shot.id === 'shot-2' ? 'c'.repeat(64) : 'd'.repeat(64), mime: 'image/png' as const, kind: 'image' as const, byteSize: 1, createdAt: 1 })),
    ],
    assetVersions: { hero: 1 }, shotStates: {}, candidates: [], jobs: [],
  }
}

/** 完整剧本至少覆盖钩子、转折、结果和两个可分镜节拍。 */
function script(): VisualEpisodeScript {
  return {
    logline: '刑警在刑场用断刀疑点争取重查。', audiencePromise: '观众看见证据推翻草率判断。',
    hook: '主角睁眼已在刑场。', turningPoint: '两件证物拼不成一把刀。', payoff: '县令暂停行刑。',
    targetDurationSeconds: 12, productionNotes: '人物、空间、道具与视线连续。',
    beats: [
      { id: 'beat-1', title: '醒来', purpose: 'hook', dramaticQuestion: '这是哪里？', synopsis: '主角醒来。', visualAction: '眼部下摇到绑绳。', dialogue: '内心声。', sound: '木击。', continuity: '双腕绑于身前。', shotIds: ['shot-1'] },
      { id: 'beat-2', title: '转折', purpose: 'turn', dramaticQuestion: '证物真的是一把刀吗？', synopsis: '断口不吻合。', visualAction: '微距展示两次对齐。', dialogue: '请求重查。', sound: '金属轻触。', continuity: '断口几何不变化。', shotIds: ['shot-2'] },
      { id: 'beat-3', title: '结果', purpose: 'resolution', dramaticQuestion: '他会获得重查机会吗？', synopsis: '县令暂停行刑。', visualAction: '顾衡压掌下令。', dialogue: '停刑。', sound: '人群低语。', continuity: '顾衡离席后座位保持空。', shotIds: ['shot-3'] },
    ],
  }
}

describe('剧本到整集拍摄流程', () => {
  it('Given 尚无剧本 When 计算准备度 Then 明确标出需要从现有镜头反推', () => {
    const overview = buildVisualScriptOverview(fixture(), 'episode')
    expect(overview.status).toBe('missing')
    expect(overview.stages[0]).toMatchObject({ id: 'script', status: 'missing' })
    expect(overview.issues[0]).toContain('尚无结构化剧本')
  })

  it('Given 完整剧本和两镜映射 When 计算准备度 Then 剧本分镜资产与生成阶段就绪', () => {
    const overview = buildVisualScriptOverview(fixture(script()), 'episode')
    expect(overview).toMatchObject({ status: 'ready', beatCount: 3, mappedShotCount: 3, totalShotCount: 3, shotDurationSeconds: 12 })
    expect(overview.stages.filter(stage => stage.status === 'ready').map(stage => stage.id)).toEqual(['script', 'storyboard', 'continuity', 'assets', 'image', 'video', 'audio'])
  })

  it('Given 剧本节拍未映射镜头 When 计算准备度 Then 保留结构但阻止进入完整生成', () => {
    const incomplete = script()
    incomplete.beats[1]!.shotIds = []
    const overview = buildVisualScriptOverview(fixture(incomplete), 'episode')
    expect(overview.status).toBe('incomplete')
    expect(overview.issues.some(issue => issue.includes('未归属'))).toBe(true)
    expect(overview.issues.some(issue => issue.includes('没有映射'))).toBe(true)
  })

  it('Given 当前作品 When 生成 Agent 要求 Then 绑定正式版本、镜头映射和视频风险检查', () => {
    const snapshot = fixture()
    const prompt = buildVisualScriptPrompt(snapshot.document, 'episode')
    expect(prompt).toContain('production')
    expect(prompt).toContain('proposeScript')
    expect(prompt).toContain('3 个镜头')
    expect(prompt).toContain('人物身份与符号漂移')
    expect(prompt).toContain('动作中间态未定义')
  })

  it('Given 用户从脚本页发起重构 When 生成请求 Then 包含创作评审规则且无效集数不生成请求', () => {
    /** 脚本入口也必须携带规则，不能只依赖用户记住补充提示。 */
    const document = fixture().document
    const prompt = buildVisualScriptPrompt(document, 'episode')
    expect(prompt).toContain('需求→字段→镜头→验收')
    expect(prompt).toContain('角色知情范围')
    expect(prompt).toContain('剪辑时长')
    /** 按钮只携带任务摘要；完整创作规则由模块注入一次，避免重复占用上下文。 */
    const context = `${getBuiltinAgentModulePrompt('visual-production.system.v1')}\n${prompt}`
    expect(context.split('<visual_creation>').length - 1).toBe(1)
    expect(buildVisualScriptPrompt(document, 'missing')).toBeNull()
  })
})
