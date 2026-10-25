import { describe, expect, it } from 'bun:test'
import { parseVisualProductionCommand, parseVisualProductionDraft, parseVisualProductionRelativePath, parseVisualProductionMediaExecution, VISUAL_PRODUCTION_READ_METHODS } from './visual-production-validation'
import type { VisualCandidateReviewInput, VisualProductionDraft } from './visual-production'

/** 最小真实作品，供边界测试独立修改。 */
const draft = (): VisualProductionDraft => ({ title: '第一支影片', kind: 'film', brief: '', ratio: '16:9', fps: 24, voice: '', music: '', episodes: [{ id: 'ep1', title: '第一集' }], assets: [{ id: 'a1', name: '主角', type: '角色', description: '', locked: false, mediaId: null }], shots: [{ id: 's1', episodeId: 'ep1', title: '开场', duration: 5, scene: '', motion: '', dialogue: '', assetIds: ['a1'], mediaId: null }] })

it('Given 自动采用与多图请求 When 解析 Then 写权限独立且拒绝重复、越界与伪造系统字段', () => {
  /** 自动采用只接收作品身份，调用者不能指定跳过检查的候选或输出数量。 */
  const target = { sessionId: 'session', productionId: 'production' }
  expect(parseVisualProductionCommand({ method: 'autoAdoptShots', input: target }).method).toBe('autoAdoptShots')
  expect(VISUAL_PRODUCTION_READ_METHODS).not.toContain('autoAdoptShots')
  expect(() => parseVisualProductionCommand({ method: 'autoAdoptShots', input: { ...target, candidateId: 'candidate' } })).toThrow()
  /** 单批最多十六张，各身份必须互异且仍不能指定 adopted 状态。 */
  const input = { ...target, baseRevision: 1, jobId: 'job', shotId: 'shot', mediaId: 'primary', summary: '多图' }
  for (const alternativeMediaIds of [['primary'], ['second', 'second'], Array.from({ length: 16 }, (_, index) => `media${index}`)]) expect(() => parseVisualProductionCommand({ method: 'proposeShot', input: { ...input, alternativeMediaIds } })).toThrow()
  expect(() => parseVisualProductionCommand({ method: 'proposeShot', input: { ...input, status: 'adopted' } })).toThrow()
})

it('Given 新旧媒体执行回执 When 解析真实输出数 Then 兼容缺省并拒绝无效数量', () => {
  /** 回执数量来自宿主，旧记录没有此字段时仍可正常读取。 */
  const receipt = { runId: 'run', engine: 'model', name: '模型', kind: 'image', source: { type: 'model', modelRef: 'image' }, parameters: {}, referenceAssets: [], phase: 'succeeded', createdAt: 1 }
  expect(parseVisualProductionMediaExecution(receipt).outputCount).toBeUndefined()
  expect(parseVisualProductionMediaExecution({ ...receipt, outputCount: 2 }).outputCount).toBe(2)
  for (const outputCount of [-1, 1.5, 501, '2']) expect(() => parseVisualProductionMediaExecution({ ...receipt, outputCount })).toThrow()
})

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

it('Given 制作闭环命令 When 解析 Then 校验固定版本、任务和阶段且拒绝额外字段', () => {
  const base = { sessionId: 'session', productionId: 'production', baseRevision: 1, jobId: 'job' }
  for (const stage of ['preparing', 'generating', 'reviewing']) expect(parseVisualProductionCommand({ method: 'updateJob', input: { ...base, stage } }).method).toBe('updateJob')
  expect(() => parseVisualProductionCommand({ method: 'updateJob', input: { ...base, stage: 'completed' } })).toThrow()
  for (const method of ['referenceMedia', 'proposeShot'] as const) {
    const input = { ...base, mediaId: 'media', ...(method === 'proposeShot' ? { shotId: 'shot', summary: '只替换输出' } : {}) }
    expect(parseVisualProductionCommand({ method, input }).method).toBe(method)
    expect(() => parseVisualProductionCommand({ method, input: { ...input, baseRevision: 0 } })).toThrow()
    expect(() => parseVisualProductionCommand({ method, input: { ...input, jobId: '' } })).toThrow()
    expect(() => parseVisualProductionCommand({ method, input: { ...input, path: '/tmp/media' } })).toThrow()
  }
})

it('Given 合法外部媒体身份与 128 个参数 When 保存制作配置 Then 接受点号工作流和点号冒号参数但不放宽影像身份', () => {
  const entries = [{ id: 'entry', name: '工作流', kind: 'image', source: { type: 'workflow' as const, connectionId: 'comfy.local', workflowId: 'workflow.v2', workflowRevision: 2 }, parameters: Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`node.${index}:seed`, index])) }]
  const input = { sessionId: 'session', productionId: 'production', expectedRevision: 0, entries, defaults: { image: 'entry' } }
  const parsed = parseVisualProductionCommand({ method: 'saveMediaConfiguration', input })
  expect(parsed.method).toBe('saveMediaConfiguration')
  if (parsed.method !== 'saveMediaConfiguration') throw new Error('错误命令')
  expect(parsed.input.entries[0]?.source).toEqual(entries[0]!.source)
  expect(Object.keys(parsed.input.entries[0]!.parameters)).toHaveLength(128)
  expect(() => parseVisualProductionCommand({ method: 'saveMediaConfiguration', input: { ...input, productionId: 'production.with.dot' } })).toThrow()
  expect(() => parseVisualProductionCommand({ method: 'saveMediaConfiguration', input: { ...input, entries: [{ ...entries[0], parameters: { constructor: 'bad' } }] } })).toThrow()
})

it('Given 媒体资产使用合法命名空间身份 When 导入引用 Then 保留外部身份且仍拒绝路径', () => {
  const reference = { assetId: 'asset.provider:output-1', revision: 1, hash: 'a'.repeat(64), mediaKind: 'image' }
  const input = { sessionId: 'session', productionId: 'production', reference }
  const result = parseVisualProductionCommand({ method: 'importMedia', input })
  expect(result.method).toBe('importMedia')
  if (result.method !== 'importMedia') throw new Error('错误命令')
  expect(result.input.reference.assetId).toBe(reference.assetId)
  expect(() => parseVisualProductionCommand({ method: 'importMedia', input: { ...input, reference: { ...reference, assetId: '../output' } } })).toThrow()
})

it('Given 服务授权与精确工作流 When 校验授权 Then 单向允许同服务工作流且回执不能只写服务', async () => {
  const { visualProductionMediaSourceAllows } = await import('./visual-production-media')
  const { parseVisualProductionMediaExecution } = await import('./visual-production-validation')
  const connection = { type: 'connection' as const, connectionId: 'comfy' }
  const workflow = { type: 'workflow' as const, connectionId: 'comfy', workflowId: 'flow', workflowRevision: 1 }
  expect(visualProductionMediaSourceAllows(connection, workflow)).toBe(true)
  expect(visualProductionMediaSourceAllows(workflow, connection)).toBe(false)
  expect(visualProductionMediaSourceAllows(workflow, { ...workflow, workflowRevision: 2 })).toBe(false)
  expect(visualProductionMediaSourceAllows(connection, { ...workflow, connectionId: 'other' })).toBe(false)
  expect(() => parseVisualProductionMediaExecution({ runId: 'run', engine: 'workflow', name: '错误服务回执', kind: 'image', source: connection, parameters: {}, referenceAssets: [], phase: 'prepared', createdAt: 1 })).toThrow()
  expect(() => parseVisualProductionCommand({ method: 'resolveMediaWorkflow', input: { sessionId: 'session', productionId: 'production', source: connection, kind: 'image' } })).toThrow()
})


it('Given 新旧镜头 When 解析声音设计 Then 保留独立字段并拒绝无效或超长文本', () => {
  /** 旧作品无字段时保持缺省，显式声音设计复制为独立对象。 */
  const input = draft()
  expect(parseVisualProductionDraft(input).shots[0]!.soundDesign).toBeUndefined()
  input.shots[0]!.soundDesign = { effects: '雨声', music: '轻柔钢琴' }
  expect(parseVisualProductionDraft(input).shots[0]!.soundDesign).toEqual(input.shots[0]!.soundDesign)
  expect(parseVisualProductionDraft(input).shots[0]!.soundDesign).not.toBe(input.shots[0]!.soundDesign)
  for (const soundDesign of [null, { effects: 1, music: '' }, { effects: '' }, { effects: '', music: '声'.repeat(8001) }, { effects: '', music: '', unknown: '' }]) {
    expect(() => parseVisualProductionDraft({ ...input, shots: [{ ...input.shots[0], soundDesign }] })).toThrow()
  }
})

it('Given Agent 已设计镜头生成方式 When 保存 Then 保留首尾帧和转场依据并兼容旧镜头', () => {
  /** 旧镜头可以没有生成计划，避免打开旧作品时被迫补造制作决定。 */
  const legacy = draft()
  expect(parseVisualProductionDraft(legacy).shots[0]!.videoPlan).toBeUndefined()

  /** 显式首尾帧计划引用镜头已经绑定的图片资产，并保留入场转场。 */
  const planned = draft()
  planned.shots[0]!.assetIds = ['a1', 'a2']
  planned.assets.push({ id: 'a2', name: '尾帧', type: '场景', description: '', locked: false, mediaId: null })
  planned.shots[0]!.videoPlan = {
    mode: 'first-last-frame',
    firstFrameAssetId: 'a1',
    lastFrameAssetId: 'a2',
    transitionIn: 'match-cut',
    rationale: '连续动作在同一空间内完成，使用首尾帧约束终点。',
  }
  const parsed = parseVisualProductionDraft(planned)
  expect(parsed.shots[0]!.videoPlan).toEqual(planned.shots[0]!.videoPlan)
  expect(parsed.shots[0]!.videoPlan).not.toBe(planned.shots[0]!.videoPlan)

  /** 图生视频可省略首帧身份，表示使用当前已采用画面。 */
  const adoptedImage = draft()
  adoptedImage.shots[0]!.videoPlan = {
    mode: 'image-to-video',
    firstFrameAssetId: null,
    lastFrameAssetId: null,
    transitionIn: 'hard-cut',
    rationale: '当前已采用画面就是唯一起点。',
  }
  expect(parseVisualProductionDraft(adoptedImage).shots[0]!.videoPlan?.mode).toBe('image-to-video')
})

it('Given 镜头生成方式与素材或转场不一致 When 保存 Then 在生成前拒绝无效计划', () => {
  const invalidPlans = [
    { mode: 'first-last-frame', firstFrameAssetId: null, lastFrameAssetId: null, transitionIn: 'hard-cut', rationale: '缺少尾帧' },
    { mode: 'position', firstFrameAssetId: null, lastFrameAssetId: null, transitionIn: 'hard-cut', rationale: '未知方式' },
    { mode: 'text-to-video', firstFrameAssetId: 'a1', lastFrameAssetId: null, transitionIn: 'hard-cut', rationale: '文生视频不能带帧' },
    { mode: 'image-to-video', firstFrameAssetId: 'a1', lastFrameAssetId: 'a1', transitionIn: 'hard-cut', rationale: '首尾相同' },
    { mode: 'first-last-frame', firstFrameAssetId: 'a1', lastFrameAssetId: 'missing', transitionIn: 'hard-cut', rationale: '尾帧不存在' },
    { mode: 'image-to-video', firstFrameAssetId: null, lastFrameAssetId: null, transitionIn: 'cut', rationale: '未知转场' },
    { mode: 'image-to-video', firstFrameAssetId: null, lastFrameAssetId: null, transitionIn: 'hard-cut', rationale: '' },
    { mode: 'image-to-video', firstFrameAssetId: null, lastFrameAssetId: null, transitionIn: 'hard-cut', rationale: '依据', extra: true },
  ]
  for (const videoPlan of invalidPlans) {
    const input = draft()
    input.shots[0]!.videoPlan = videoPlan as never
    expect(() => parseVisualProductionDraft(input)).toThrow()
  }

  /** 首尾帧资产只有在镜头引用范围内才允许参与制作。 */
  const unbound = draft()
  unbound.assets.push({ id: 'a2', name: '未绑定尾帧', type: '场景', description: '', locked: false, mediaId: null })
  unbound.shots[0]!.videoPlan = {
    mode: 'first-last-frame',
    firstFrameAssetId: null,
    lastFrameAssetId: 'a2',
    transitionIn: 'hard-cut',
    rationale: '尾帧尚未加入镜头引用。',
  }
  expect(() => parseVisualProductionDraft(unbound)).toThrow()
})

it('Given 复杂动作需要中间锚点和声音接续 When 保存 Then 保留衔接合同并兼容旧镜头', () => {
  /** 旧镜头没有衔接字段时仍可读取，生产门禁只在视频阶段要求补齐。 */
  const legacy = draft()
  expect(parseVisualProductionDraft(legacy).shots[0]!.continuityPlan).toBeUndefined()

  /** 锚点只允许引用本镜资产；声音接续与画面生成方式分开保存。 */
  const planned = draft()
  planned.assets.push({ id: 'a2', name: '起身尾帧', type: '场景', description: '', locked: false, mediaId: null })
  planned.shots[0]!.assetIds = ['a1', 'a2']
  planned.shots[0]!.continuityPlan = {
    entryState: '角色右手扶住桌沿',
    exitState: '角色站直并保持持物',
    anchors: [
      { phase: 'start', state: '右手接触桌沿', assetId: 'a1' },
      { phase: 'contact', state: '手掌承重', assetId: null },
      { phase: 'exit', state: '人物完成起身', assetId: 'a2' },
    ],
    audioTransition: 'prelap',
    rationale: '接触声先入，动作跨切点保持连续。',
  }
  const parsed = parseVisualProductionDraft(planned)
  expect(parsed.shots[0]!.continuityPlan).toEqual(planned.shots[0]!.continuityPlan)
  expect(parsed.shots[0]!.continuityPlan).not.toBe(planned.shots[0]!.continuityPlan)

  const invalidPlans = [
    { entryState: '', exitState: '终点', anchors: [], audioTransition: 'hard-cut', rationale: '依据' },
    { entryState: '起点', exitState: '', anchors: [], audioTransition: 'hard-cut', rationale: '依据' },
    { entryState: '起点', exitState: '终点', anchors: [], audioTransition: 'cut', rationale: '依据' },
    { entryState: '起点', exitState: '终点', anchors: [{ phase: 'middle', state: '中间', assetId: null }], audioTransition: 'hard-cut', rationale: '依据' },
    { entryState: '起点', exitState: '终点', anchors: [{ phase: 'contact', state: '接触', assetId: 'missing' }], audioTransition: 'hard-cut', rationale: '依据' },
    { entryState: '起点', exitState: '终点', anchors: [{ phase: 'contact', state: '接触', assetId: null }, { phase: 'contact', state: '再次接触', assetId: null }], audioTransition: 'hard-cut', rationale: '依据' },
    { entryState: '起点', exitState: '终点', anchors: [{ phase: 'contact', state: '接触', assetId: 'a1' }, { phase: 'result', state: '结果', assetId: 'a1' }], audioTransition: 'hard-cut', rationale: '依据' },
  ]
  for (const continuityPlan of invalidPlans) {
    const input = draft()
    input.shots[0]!.continuityPlan = continuityPlan as never
    expect(() => parseVisualProductionDraft(input)).toThrow()
  }
})

it('Given 视频候选审核 When 解析保存请求 Then 保留三项门禁、问题时间点和未检查范围', () => {
  /** 审核记录由宿主补充会话和时间，调用方只提交有界结论。 */
  const review: VisualCandidateReviewInput = {
    technical: 'passed',
    motion: 'warning',
    continuity: 'pending',
    conclusion: '动作主体完整，转场处仍有轻微方向偏差。',
    unchecked: ['未听取完整音轨', '仅检查了抽帧'],
    issues: [{ gate: 'motion', severity: 'warning', message: '切点前角色向左移动过多', atSeconds: 4.2 }],
  }
  const input = { sessionId: 'session', productionId: 'production', baseRevision: 1, candidateId: 'candidate', review }
  const parsed = parseVisualProductionCommand({ method: 'reviewCandidate', input })
  expect(parsed.method).toBe('reviewCandidate')
  if (parsed.method !== 'reviewCandidate') throw new Error('错误命令')
  expect(parsed.input.review).toEqual(review)

  for (const invalid of [
    { ...review, technical: 'unknown' },
    { ...review, motion: 'excellent' },
    { ...review, conclusion: '' },
    { ...review, unchecked: Array.from({ length: 17 }, () => '未检查') },
    { ...review, issues: [{ gate: 'audio', severity: 'warning', message: '错误门禁', atSeconds: 1 }] },
    { ...review, issues: [{ gate: 'motion', severity: 'error', message: '', atSeconds: 1 }] },
    { ...review, issues: [{ gate: 'motion', severity: 'warning', message: '越界时间', atSeconds: 601 }] },
    { ...review, extra: true },
  ]) expect(() => parseVisualProductionCommand({ method: 'reviewCandidate', input: { ...input, review: invalid } })).toThrow()
})

it('Given ComfyUI 视频任务 When 保存工作流发现结果 Then 保留扫描游标和精确选择身份', () => {
  const base = { sessionId: 'session', productionId: 'production', baseRevision: 2, jobId: 'job' }
  const scanned = parseVisualProductionCommand({ method: 'recordWorkflowDiscovery', input: { ...base, discovery: {
    status: 'candidates', connectionId: 'comfy.local', mediaKind: 'video', candidateCount: 2, blockedCount: 0,
    nextOffset: null, snapshotId: 'snapshot-1', checkedAt: 1,
  } } })
  expect(scanned.method).toBe('recordWorkflowDiscovery')
  if (scanned.method === 'recordWorkflowDiscovery') expect(scanned.input.discovery).toMatchObject({ status: 'candidates', candidateCount: 2, nextOffset: null })

  const selected = parseVisualProductionCommand({ method: 'recordWorkflowDiscovery', input: { ...base, discovery: {
    status: 'selected', connectionId: 'comfy.local', mediaKind: 'video', candidateCount: 1, blockedCount: 0,
    nextOffset: null, selectedWorkflow: { workflowId: 'workflow', workflowRevision: 2, contentHash: 'a'.repeat(64) },
  } } })
  expect(selected.method).toBe('recordWorkflowDiscovery')
  if (selected.method === 'recordWorkflowDiscovery') expect(selected.input.discovery.selectedWorkflow?.contentHash).toBe('a'.repeat(64))

  for (const discovery of [
    { status: 'selected', connectionId: 'comfy.local', mediaKind: 'video', candidateCount: 0, blockedCount: 0, nextOffset: null },
    { status: 'candidates', connectionId: '../bad', mediaKind: 'video', candidateCount: 1, blockedCount: 0, nextOffset: null },
    { status: 'scanning', connectionId: 'comfy.local', mediaKind: 'video', candidateCount: 1, blockedCount: 0, nextOffset: -1 },
    { status: 'candidates', connectionId: 'comfy.local', mediaKind: 'video', candidateCount: 1, blockedCount: 0, nextOffset: null, extra: true },
  ]) expect(() => parseVisualProductionCommand({ method: 'recordWorkflowDiscovery', input: { ...base, discovery } })).toThrow()
})

it('Given 整集剧本与镜头映射 When 保存候选 Then 保留叙事节拍并拒绝跨集或额外字段', () => {
  /** 剧本节拍只保存上游叙事意图，镜头字段继续负责逐帧制作。 */
  const source = draft()
  const script = {
    logline: '刑警借证物复核争取重查。',
    audiencePromise: '观众看到证据逻辑推翻草率定罪。',
    hook: '刑场上醒来。',
    turningPoint: '断刀与刀尖无法吻合。',
    payoff: '县令暂停行刑并叫出沈警官。',
    targetDurationSeconds: 5,
    productionNotes: '全部镜头保持同一人物、空间与证物状态。',
    beats: [{
      id: 'beat-1', title: '开场钩子', purpose: 'hook', dramaticQuestion: '他为什么在刑场？',
      synopsis: '沈砚在刑场醒来。', visualAction: '从眼部下摇到绑绳。', dialogue: '“这不是库房……”',
      sound: '人群低语与木击。', continuity: '左颧骨浅擦伤，双腕绑于身前。', shotIds: ['s1'],
    }],
  }
  const withScript = { ...source, episodes: [{ ...source.episodes[0]!, script }] }
  expect(parseVisualProductionDraft(withScript).episodes[0]?.script?.beats[0]).toMatchObject({ purpose: 'hook', shotIds: ['s1'] })
  const input = { sessionId: 'session', productionId: 'production', baseRevision: 1, jobId: 'job', episodeId: 'ep1', script, summary: '整理整集剧本' }
  const parsed = parseVisualProductionCommand({ method: 'proposeScript', input })
  expect(parsed.method).toBe('proposeScript')
  expect(() => parseVisualProductionDraft({
    ...withScript,
    episodes: [
      { ...withScript.episodes[0]!, script: { ...script, beats: [{ ...script.beats[0]!, shotIds: ['missing-shot'] }] } },
      { id: 'ep2', title: '第二集' },
    ],
  })).toThrow('剧本节拍引用')
  expect(() => parseVisualProductionCommand({ method: 'proposeScript', input: { ...input, script: { ...script, extra: true } } })).toThrow()
})
