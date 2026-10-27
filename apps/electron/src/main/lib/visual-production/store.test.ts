import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VisualEditingExportJob, VisualMedia, VisualProductionDraft } from '@dutydeck/shared'
import { VisualProductionService } from './store'
import type { VisualLockedAssetApprovalRequest, VisualProductionServiceDependencies } from './store'
/** 隔离测试项目，不读取用户数据。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
/** 从正式文档取出允许编辑的字段。 */
function editable(document: VisualProductionDraft): VisualProductionDraft {
  const { title, kind, brief, ratio, fps, voice, music, episodes, assets, shots } = document
  return { title, kind, brief, ratio, fps, voice, music, episodes, assets, shots }
}
/** 创建独立服务及首个作品。 */
async function fixture(dependencies: Partial<Pick<VisualProductionServiceDependencies, 'authorizeLockedAssetChanges'>> = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'visual-production-')); roots.push(projectRoot)
  const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot, ...dependencies })
  const snapshot = await service.invoke('create', { sessionId: 'session', title: '测试作品', kind: 'film' })
  const target = { sessionId: 'session', productionId: snapshot.document.id }
  return { service, snapshot, target, projectRoot }
}

/** 建立含一个锁定角色和一个普通资产的整作品制作任务，供精确授权回归复用。 */
async function lockedAssetFixture(
  authorizeLockedAssetChanges?: (request: VisualLockedAssetApprovalRequest, signal?: AbortSignal) => Promise<boolean>,
) {
  const context = await fixture(authorizeLockedAssetChanges ? { authorizeLockedAssetChanges } : {})
  const draft: VisualProductionDraft = {
    ...editable(context.snapshot.document),
    assets: [
      { id: 'actor', name: '主角', type: '角色', description: '锁定的银发造型', locked: true, mediaId: null },
      { id: 'prop', name: '雨伞', type: '道具', description: '普通道具', locked: false, mediaId: null },
    ],
  }
  const initial = await context.service.invoke('save', { ...context.target, baseRevision: 1, draft })
  const job = await context.service.invoke('beginJob', {
    ...context.target, baseRevision: initial.document.revision, instruction: '调整角色外观',
  })
  return { ...context, draft, job, revision: initial.document.revision }
}
describe('Given 独立影像作品', () => {
  test('When 请求原生候选预览 Then 校验正式基线并传递完整快照与命令到剪辑服务', async () => {
    /** 用局部剪辑端口捕获路由，避免本测试启动真实编码器。 */
    const { service, target } = await fixture()
    const calls: unknown[] = []
    const input = { ...target, baseRevision: 1, episodeId: 'episode', expectedTimelineRevision: 2, candidateIds: ['candidate'], range: { start: 0, end: 5 }, settings: { ratio: '9:16', fps: 24, includeVoice: true, includeMusic: false, includeCaptions: false } }
    const result: VisualEditingExportJob = { id: 'preview', productionId: target.productionId, episodeId: input.episodeId, timelineRevision: 2, settings: input.settings, status: 'completed', createdAt: 1, updatedAt: 1, sourceHashes: ['a'.repeat(64)], preview: { productionRevision: 1, candidateIds: input.candidateIds, range: input.range } }
    Object.defineProperty(service, 'editing', { value: { requestPreview(snapshot: unknown, request: unknown) { calls.push({ snapshot, request }); return result } } })
    expect(await service.invoke('requestPreview', input)).toEqual(result)
    expect(calls).toMatchObject([{ snapshot: { document: { id: target.productionId, revision: 1 } }, request: input }])
    await expect(service.invoke('requestPreview', { ...input, baseRevision: 2 })).rejects.toThrow('CONFLICT')
    expect(calls).toHaveLength(1)
  })
  test('When 保存正式设定 Then 递增版本且拒绝旧基线', async () => {
    const { service, snapshot, target } = await fixture()
    const saved = await service.invoke('save', { ...target, baseRevision: 1, draft: { ...editable(snapshot.document), brief: '新目标' } })
    expect(saved.document.revision).toBe(2)
    await expect(service.invoke('save', { ...target, baseRevision: 1, draft: editable(snapshot.document) })).rejects.toThrow('CONFLICT')
  })
  test('When 取消任务 Then 迟到候选不能登记', async () => {
    const { service, snapshot, target } = await fixture()
    const job = await service.invoke('beginJob', { ...target, baseRevision: 1, instruction: '制作' })
    await service.invoke('cancelJob', { ...target, jobId: job.id })
    await expect(service.invoke('propose', { ...target, baseRevision: 1, jobId: job.id, draft: editable(snapshot.document), summary: '候选' })).rejects.toThrow()
    expect((await service.invoke('load', target)).candidates).toHaveLength(0)
  })
  test('When 登记和采纳候选 Then 采纳前正式文档不变且仅采纳递增版本', async () => {
    const { service, snapshot, target } = await fixture()
    const job = await service.invoke('beginJob', { ...target, baseRevision: 1, instruction: '修改目标' })
    const candidate = await service.invoke('propose', { ...target, baseRevision: 1, jobId: job.id, draft: { ...editable(snapshot.document), brief: '候选目标' }, summary: '候选' })
    expect((await service.invoke('load', target)).document.brief).toBe('')
    const adopted = await service.invoke('adopt', { ...target, baseRevision: 1, candidateId: candidate.id })
    expect(adopted.document.brief).toBe('候选目标')
    expect(adopted.document.revision).toBe(2)
    expect(adopted.candidates[0]?.status).toBe('adopted')
  })
})

describe('Given 独立声音审核门禁', () => {
  test.each(['true', true] as const)('When 持久化声音标记为 %s 且缺少总门禁 Then 拒绝损坏索引', async reviewAudioRequired => {
    /** 在隔离夹具中模拟旧磁盘记录损坏，不能隐式降级为无需审核。 */
    const { service, snapshot, target, projectRoot } = await fixture()
    const job = await service.invoke('beginJob', { ...target, baseRevision: 1, instruction: '调整设定' })
    await service.invoke('propose', { ...target, baseRevision: 1, jobId: job.id, draft: { ...editable(snapshot.document), brief: '候选' }, summary: '设定候选' })
    const path = join(projectRoot, '.dutydeck', 'visual-production', 'projects', target.productionId, 'snapshot.json')
    const disk = JSON.parse(readFileSync(path, 'utf8'))
    disk.candidates[0].reviewAudioRequired = reviewAudioRequired
    writeFileSync(path, JSON.stringify(disk))
    await expect(service.invoke('load', target)).rejects.toThrow('候选声音审核门禁损坏')
  })
  test.each([undefined, 'pending', 'failed', 'passed', 'warning'] as const)('When 声音审核为 %s Then 只有完成听验才允许采用', async audio => {
    /** 最小音频签名用于门禁测试，不替代真实听验。 */
    const { service, snapshot, target, projectRoot } = await fixture()
    writeFileSync(join(projectRoot, 'voice.mp3'), Buffer.from('ID3test-audio'))
    const media = await service.invoke('importFile', { ...target, relativePath: 'voice.mp3' })
    const shot = { id: 'shot', episodeId: snapshot.document.episodes[0]!.id, title: '配音', duration: 4, scene: '', motion: '', dialogue: '醒来', assetIds: [], mediaId: null }
    const baseline = await service.invoke('save', { ...target, baseRevision: 1, draft: { ...editable(snapshot.document), shots: [shot] } })
    const job = await service.invoke('beginJob', { ...target, baseRevision: 2, instruction: '配音', shotId: shot.id, mediaKind: 'audio' })
    const candidate = await service.invoke('proposeShot', { ...target, baseRevision: 2, jobId: job.id, shotId: shot.id, mediaId: media.id, summary: '独立配音' })
    expect(candidate).toMatchObject({ reviewRequired: true, reviewAudioRequired: true, status: 'ready' })
    await expect(service.invoke('adopt', { ...target, baseRevision: 2, candidateId: candidate.id })).rejects.toThrow()
    await service.invoke('reviewCandidate', { ...target, baseRevision: 2, candidateId: candidate.id, review: { technical: 'passed', motion: 'passed', continuity: 'passed', ...(audio ? { audio } : {}), conclusion: '声音审核', unchecked: [], issues: [] } })
    if (audio === 'passed' || audio === 'warning') {
      const adopted = await service.invoke('adopt', { ...target, baseRevision: 2, candidateId: candidate.id })
      expect(adopted.document.shots[0]?.outputs?.audio).toBe(media.id)
    } else {
      await expect(service.invoke('adopt', { ...target, baseRevision: 2, candidateId: candidate.id })).rejects.toThrow()
      expect((await service.invoke('load', target)).document).toEqual(baseline.document)
    }
  })
})

describe('Given 视频候选审核门禁', () => {
  test('When 新影片候选未经审核 Then 记录三方意见后才允许采用', async () => {
    const { service, snapshot, target, projectRoot } = await fixture()
    /** 构造最小可登记的图片与 MP4；这里验证持久化和门禁，不调用解码器。 */
    writeFileSync(join(projectRoot, 'frame.png'), Buffer.from('89504e470d0a1a0a00000000', 'hex'))
    writeFileSync(join(projectRoot, 'clip.mp4'), Buffer.from('0000ftypisom0000'))
    const image = await service.invoke('importFile', { ...target, relativePath: 'frame.png' })
    const video = await service.invoke('importFile', { ...target, relativePath: 'clip.mp4' })
    const shot = { id: 'shot', episodeId: snapshot.document.episodes[0]!.id, title: '镜头', duration: 4, scene: '', motion: '', dialogue: '', assetIds: [], mediaId: image.id }
    await service.invoke('save', { ...target, baseRevision: 1, draft: { ...editable(snapshot.document), shots: [shot] } })
    const job = await service.invoke('beginJob', { ...target, baseRevision: 2, instruction: '制作影片', shotId: shot.id })
    const candidate = await service.invoke('proposeShot', { ...target, baseRevision: 2, jobId: job.id, shotId: shot.id, mediaId: video.id, summary: '首版影片' })
    expect(candidate.reviewRequired).toBe(true)
    expect((await service.invoke('load', target)).jobs[0]?.stage).toBe('reviewing')
    await expect(service.invoke('adopt', { ...target, baseRevision: 2, candidateId: candidate.id })).rejects.toThrow('候选需先完成视频审核')

    /** 审核结论保存分项状态、可定位问题和未检查范围。 */
    const reviewed = await service.invoke('reviewCandidate', {
      ...target, baseRevision: 2, candidateId: candidate.id,
      review: { technical: 'passed', motion: 'passed', continuity: 'warning', conclusion: '主体动作完整，切点需在剪辑时缩短。', unchecked: ['未听取完整音轨'], issues: [{ gate: 'continuity', severity: 'warning', message: '尾段停留略长', atSeconds: 3.4 }] },
    })
    expect(reviewed.review).toMatchObject({ sessionId: 'session', technical: 'passed', motion: 'passed', continuity: 'warning', issues: [{ atSeconds: 3.4 }] })
    const adopted = await service.invoke('adopt', { ...target, baseRevision: 2, candidateId: candidate.id })
    expect(adopted.document.shots[0]!.outputs?.video).toBe(video.id)
  })

  test('When 技术审核失败 Then 即使画面可播放也不能采用', async () => {
    const { service, target, projectRoot } = await fixture()
    /** 技术硬门失败保留候选证据，不把它迁移到正式作品。 */
    writeFileSync(join(projectRoot, 'frame.png'), Buffer.from('89504e470d0a1a0a00000000', 'hex'))
    writeFileSync(join(projectRoot, 'clip.mp4'), Buffer.from('0000ftypisom0000'))
    const image = await service.invoke('importFile', { ...target, relativePath: 'frame.png' })
    const video = await service.invoke('importFile', { ...target, relativePath: 'clip.mp4' })
    const current = await service.invoke('load', target)
    const shot = { id: 'shot', episodeId: current.document.episodes[0]!.id, title: '镜头', duration: 4, scene: '', motion: '', dialogue: '', assetIds: [], mediaId: image.id }
    await service.invoke('save', { ...target, baseRevision: 1, draft: { ...editable(current.document), shots: [shot] } })
    const job = await service.invoke('beginJob', { ...target, baseRevision: 2, instruction: '制作影片', shotId: shot.id })
    const candidate = await service.invoke('proposeShot', { ...target, baseRevision: 2, jobId: job.id, shotId: shot.id, mediaId: video.id, summary: '损坏影片' })
    await service.invoke('reviewCandidate', { ...target, baseRevision: 2, candidateId: candidate.id, review: { technical: 'failed', motion: 'pending', continuity: 'pending', conclusion: '文件无法完整解码。', unchecked: ['未做内容审核'], issues: [{ gate: 'technical', severity: 'error', message: '尾部解码失败', atSeconds: 2.1 }] } })
    await expect(service.invoke('adopt', { ...target, baseRevision: 2, candidateId: candidate.id })).rejects.toThrow('视频审核存在失败项')
  })

  /** 分别验证内容门禁失败与 error 问题均独立阻断采用，技术通过不能覆盖内容缺失。 */
  test.each([
    { gate: 'motion', status: 'failed', withError: false },
    { gate: 'continuity', status: 'failed', withError: false },
    { gate: 'motion', status: 'warning', withError: true },
    { gate: 'audio', status: 'failed', withError: false },
    { gate: 'audio', status: 'warning', withError: true },
  ] as const)('When $gate=$status 且 withError=$withError Then 拒绝采用并保留正式内容', async ({ gate, status, withError }) => {
    const { service, target, projectRoot } = await fixture()
    /** 最小容器只验证内容审核状态的持久化与采用门禁，不代替真实解码测试。 */
    writeFileSync(join(projectRoot, 'frame.png'), Buffer.from('89504e470d0a1a0a00000000', 'hex'))
    writeFileSync(join(projectRoot, 'clip.mp4'), Buffer.from('0000ftypisom0000'))
    const image = await service.invoke('importFile', { ...target, relativePath: 'frame.png' })
    const video = await service.invoke('importFile', { ...target, relativePath: 'clip.mp4' })
    const current = await service.invoke('load', target)
    /** 必需内容来自用户视角和连续性约束，不由宿主解析自然语言推断。 */
    const shot = { id: 'shot', episodeId: current.document.episodes[0]!.id, title: '镜头', duration: 4, scene: '第一人称看见身前绑腕', motion: '睁眼后低头看手', dialogue: '', assetIds: [], mediaId: image.id }
    const baseline = await service.invoke('save', { ...target, baseRevision: 1, draft: { ...editable(current.document), shots: [shot] } })
    const job = await service.invoke('beginJob', { ...target, baseRevision: 2, instruction: '制作影片', shotId: shot.id })
    const candidate = await service.invoke('proposeShot', { ...target, baseRevision: 2, jobId: job.id, shotId: shot.id, mediaId: video.id, summary: '缺少必需内容的候选' })
    await service.invoke('reviewCandidate', {
      ...target, baseRevision: 2, candidateId: candidate.id,
      review: { technical: 'passed', motion: 'passed', continuity: 'passed', [gate]: status, conclusion: '实际视角或绑腕状态不符合必需内容。', unchecked: ['未听验'], issues: withError ? [{ gate, severity: 'error', message: '缺少必需的真实第一人称视角。' }] : [] },
    })
    await expect(service.invoke('adopt', { ...target, baseRevision: 2, candidateId: candidate.id })).rejects.toThrow('视频审核存在失败项')
    const after = await service.invoke('load', target)
    expect(after.document).toEqual(baseline.document)
    expect(after.shotStates).toEqual(baseline.shotStates)
    expect(after.candidates.find(item => item.id === candidate.id)?.status).toBe('ready')
  })
})

describe('Given ComfyUI 视频工作流发现', () => {
  test('When 视频任务选择服务器 When 发现并选定工作流 Then 写入任务状态供预检核对', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'visual-workflow-discovery-')); roots.push(projectRoot)
    const service = new VisualProductionService({
      workspaceId: 'workspace', projectRoot,
      listMediaOptions: async () => [{ id: 'comfy-video', name: '芯火服务', kind: 'video', source: { type: 'connection', connectionId: 'comfy.local' }, parameters: {}, available: true, constraints: {} }],
    })
    const created = await service.invoke('create', { sessionId: 'session', title: '工作流任务', kind: 'film' })
    const target = { sessionId: 'session', productionId: created.document.id }
    await service.invoke('saveMediaConfiguration', {
      ...target, expectedRevision: 0,
      entries: [{ id: 'comfy-video', name: '芯火服务', kind: 'video', source: { type: 'connection', connectionId: 'comfy.local' }, parameters: {} }],
      defaults: { video: 'comfy-video' },
    })
    const job = await service.invoke('beginJob', { ...target, baseRevision: 1, instruction: '制作首尾帧视频', mediaKind: 'video' })
    expect(job.workflowDiscovery).toMatchObject({ status: 'required', connectionId: 'comfy.local', mediaKind: 'video', nextOffset: null })

    const discovered = await service.invoke('recordWorkflowDiscovery', { ...target, baseRevision: 1, jobId: job.id, discovery: {
      status: 'candidates', connectionId: 'comfy.local', mediaKind: 'video', candidateCount: 2, blockedCount: 0,
      nextOffset: null, snapshotId: 'snapshot-1', checkedAt: 10,
    } })
    expect(discovered.workflowDiscovery).toMatchObject({ status: 'candidates', candidateCount: 2, snapshotId: 'snapshot-1' })

    await expect(service.invoke('recordWorkflowDiscovery', { ...target, baseRevision: 1, jobId: job.id, discovery: {
      status: 'no-match', connectionId: 'comfy.local', mediaKind: 'audio', candidateCount: 0, blockedCount: 0,
      nextOffset: null, checkedAt: 11, message: '错误类别不能覆盖视频任务',
    } })).rejects.toThrow('媒体类别')
    await expect(service.invoke('recordWorkflowDiscovery', { ...target, baseRevision: 1, jobId: job.id, discovery: {
      status: 'no-match', connectionId: 'comfy.local', mediaKind: 'video', candidateCount: 0, blockedCount: 0,
      nextOffset: 4, snapshotId: 'snapshot-1', checkedAt: 11, message: '错误地在扫描未结束时宣称无匹配',
    } })).rejects.toThrow('完整目录')

    const selected = await service.invoke('recordWorkflowDiscovery', { ...target, baseRevision: 1, jobId: job.id, discovery: {
      status: 'selected', connectionId: 'comfy.local', mediaKind: 'video', candidateCount: 2, blockedCount: 0,
      nextOffset: null, checkedAt: 11,
      selectedWorkflow: { workflowId: 'workflow', workflowRevision: 3, contentHash: 'a'.repeat(64) },
    } })
    expect(selected.workflowDiscovery?.selectedWorkflow).toEqual({ workflowId: 'workflow', workflowRevision: 3, contentHash: 'a'.repeat(64) })
  })
})

describe('Given 集级结构化剧本', () => {
  test('When 整作品任务提交剧本候选 Then 正式内容在采用前不变且映射镜头保留', async () => {
    const { service, snapshot, target } = await fixture()
    const episode = snapshot.document.episodes[0]!
    const shot = { id: 'script-shot', episodeId: episode.id, title: '开场', duration: 5, scene: '人物醒来。', motion: '眼部下摇。', dialogue: '内心声。', assetIds: [], mediaId: null }
    await service.invoke('save', { ...target, baseRevision: snapshot.document.revision, draft: { ...editable(snapshot.document), shots: [shot] } })
    const current = await service.invoke('load', target)
    const job = await service.invoke('beginJob', { ...target, baseRevision: current.document.revision, instruction: '整理整集剧本' })
    const script = {
      logline: '刑警借证物复核争取重查。', audiencePromise: '观众看见证据逻辑推翻草率判断。',
      hook: '刑场醒来。', turningPoint: '证物无法吻合。', payoff: '案件被要求重查。',
      targetDurationSeconds: shot.duration, productionNotes: '人物、空间、道具和视线保持连续。',
      beats: [{
        id: 'beat-1', title: '开场钩子', purpose: 'hook' as const, dramaticQuestion: '他为什么在刑场？',
        synopsis: '主角在刑场醒来并观察处境。', visualAction: '眼部下摇到绑绳。', dialogue: '内心声一句。',
        sound: '人群低语与一次木击。', continuity: '双腕绑于身前，左颧骨浅擦伤。', shotIds: [shot.id],
      }],
    }
    const candidate = await service.invoke('proposeScript', { ...target, baseRevision: current.document.revision, jobId: job.id, episodeId: episode.id, script, summary: '结构化整集剧本' })
    expect(candidate.status).toBe('ready')
    expect((await service.invoke('load', target)).document.episodes[0]?.script).toBeUndefined()
    const adopted = await service.invoke('adopt', { ...target, baseRevision: current.document.revision, candidateId: candidate.id })
    expect(adopted.document.episodes[0]?.script?.beats[0]).toMatchObject({ purpose: 'hook', shotIds: [shot.id] })
  })
  test('When 单镜头任务提交整集剧本 Then 拒绝越过制作边界', async () => {
    const { service, snapshot, target } = await fixture()
    const episode = snapshot.document.episodes[0]!
    const shot = { id: 'script-shot', episodeId: episode.id, title: '开场', duration: 5, scene: '人物醒来。', motion: '眼部下摇。', dialogue: '内心声。', assetIds: [], mediaId: null }
    await service.invoke('save', { ...target, baseRevision: snapshot.document.revision, draft: { ...editable(snapshot.document), shots: [shot] } })
    const job = await service.invoke('beginJob', { ...target, baseRevision: 2, instruction: '只修改单镜', shotId: shot.id })
    await expect(service.invoke('proposeScript', { ...target, baseRevision: 2, jobId: job.id, episodeId: episode.id, script: {
      logline: '', audiencePromise: '', hook: '', turningPoint: '', payoff: '', targetDurationSeconds: 0, productionNotes: '', beats: [],
    }, summary: '越界' })).rejects.toThrow('单镜头')
  })
})

describe('Given 资产与镜头制作依赖', () => {
  test('When 单镜头任务修改范围外内容 Then 拒绝候选且不登记', async () => {
    const { service, snapshot, target } = await fixture()
    const draft = { ...editable(snapshot.document), assets: [{ id: 'asset', name: '角色', type: '角色' as const, description: '原描述', locked: true, mediaId: null }], shots: [{ id: 'shot', episodeId: snapshot.document.episodes[0]!.id, title: '镜头', duration: 5, scene: '场景', motion: '', dialogue: '', assetIds: ['asset'], mediaId: null }] }
    await service.invoke('save', { ...target, baseRevision: 1, draft })
    const job = await service.invoke('beginJob', { ...target, baseRevision: 2, instruction: '制作', shotId: 'shot' })
    await expect(service.invoke('propose', { ...target, baseRevision: 2, jobId: job.id, draft: { ...draft, brief: '越界修改' }, summary: '修改' })).rejects.toThrow('单镜头')
    await expect(service.invoke('propose', { ...target, sessionId: 'other', baseRevision: 2, jobId: job.id, draft, summary: '修改' })).rejects.toThrow('会话')
    expect((await service.invoke('load', target)).candidates).toHaveLength(0)
  })
  test('Given 锁定角色候选 When 提交 Then 候选可待审且正式版本保持不变', async () => {
    const { service, target, draft, job, revision } = await lockedAssetFixture()
    const candidate = await service.invoke('propose', {
      ...target, baseRevision: revision, jobId: job.id,
      draft: { ...draft, assets: draft.assets.map(asset => asset.id === 'actor' ? { ...asset, description: '解锁为黑发造型' } : asset) },
      summary: '修改锁定角色',
    })
    const current = await service.invoke('load', target)
    expect(candidate.status).toBe('ready')
    expect(current.document.revision).toBe(revision)
    expect(current.document.assets.find(asset => asset.id === 'actor')?.description).toBe('锁定的银发造型')
  })
  test('Given 锁定角色变更 When 宿主未提供授权入口 Then 拒绝正式采用且 revision 不变', async () => {
    const { service, target, draft, job, revision } = await lockedAssetFixture()
    const candidate = await service.invoke('propose', {
      ...target, baseRevision: revision, jobId: job.id,
      draft: { ...draft, assets: draft.assets.map(asset => asset.id === 'actor' ? { ...asset, description: '候选黑发' } : asset) },
      summary: '修改锁定角色',
    })
    await expect(service.invoke('adopt', { ...target, baseRevision: revision, candidateId: candidate.id }))
      .rejects.toThrow('需要用户授权')
    const current = await service.invoke('load', target)
    expect(current.document.revision).toBe(revision)
    expect(current.document.assets.find(asset => asset.id === 'actor')?.description).toBe('锁定的银发造型')
  })
  test('Given 用户拒绝锁定角色变更 When 采用 Then 只保留候选且不写正式作品', async () => {
    const requests: VisualLockedAssetApprovalRequest[] = []
    const { service, target, draft, job, revision } = await lockedAssetFixture(async request => {
      requests.push(request)
      return false
    })
    const candidate = await service.invoke('propose', {
      ...target, baseRevision: revision, jobId: job.id,
      draft: { ...draft, assets: draft.assets.map(asset => asset.id === 'actor' ? { ...asset, description: '候选黑发' } : asset) },
      summary: '修改锁定角色',
    })
    await expect(service.invoke('adopt', { ...target, baseRevision: revision, candidateId: candidate.id }))
      .rejects.toThrow('LOCKED_ASSET_DENIED')
    expect(requests).toEqual([{
      sessionId: 'session', productionId: target.productionId, candidateId: candidate.id,
      revision, action: 'adopt',
      changes: [{ assetId: 'actor', name: '主角', fields: [{ field: '描述', before: '锁定的银发造型', after: '候选黑发' }] }],
    }])
    const current = await service.invoke('load', target)
    expect(current.document.revision).toBe(revision)
    expect(current.candidates.find(item => item.id === candidate.id)?.status).toBe('ready')
  })
  test('Given 用户批准精确锁定变更 When 采用 Then 只修改该字段并推进一次正式版本', async () => {
    const requests: VisualLockedAssetApprovalRequest[] = []
    const { service, target, draft, job, revision } = await lockedAssetFixture(async request => {
      requests.push(request)
      return true
    })
    const candidate = await service.invoke('propose', {
      ...target, baseRevision: revision, jobId: job.id,
      draft: { ...draft, assets: draft.assets.map(asset => asset.id === 'actor' ? { ...asset, description: '批准的银发造型' } : asset) },
      summary: '修改锁定角色',
    })
    const adopted = await service.invoke('adopt', { ...target, baseRevision: revision, candidateId: candidate.id })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.changes[0]?.fields).toEqual([{ field: '描述', before: '锁定的银发造型', after: '批准的银发造型' }])
    expect(JSON.stringify(requests[0])).not.toContain('雨伞')
    expect(adopted.document.revision).toBe(revision + 1)
    expect(adopted.document.assets.find(asset => asset.id === 'actor')?.description).toBe('批准的银发造型')
    expect(adopted.document.assets.find(asset => asset.id === 'prop')?.description).toBe('普通道具')
  })
  test('Given 候选审批期间正式文件被替换 When 迟到批准返回 Then CAS 拒绝覆盖新正式版本', async () => {
    const { service, target, draft, job, revision, projectRoot } = await lockedAssetFixture(async () => {
      const path = join(projectRoot, '.dutydeck', 'visual-production', 'projects', target.productionId, 'snapshot.json')
      const external = JSON.parse(readFileSync(path, 'utf8'))
      external.document.brief = '审批期间的外部正式修改'
      writeFileSync(path, JSON.stringify(external))
      return true
    })
    const candidate = await service.invoke('propose', {
      ...target, baseRevision: revision, jobId: job.id,
      draft: { ...draft, assets: draft.assets.map(asset => asset.id === 'actor' ? { ...asset, description: '不能覆盖外部修改' } : asset) },
      summary: '修改锁定角色',
    })
    await expect(service.invoke('adopt', { ...target, baseRevision: revision, candidateId: candidate.id }))
      .rejects.toThrow()
    const disk = JSON.parse(readFileSync(join(projectRoot, '.dutydeck', 'visual-production', 'projects', target.productionId, 'snapshot.json'), 'utf8'))
    expect(disk.document.brief).toBe('审批期间的外部正式修改')
    expect(disk.document.assets.find((asset: { id: string }) => asset.id === 'actor').description).toBe('锁定的银发造型')
  })
  test('Given 授权等待已取消 When 回调错误地批准 Then 仍拒绝正式写入', async () => {
    const controller = new AbortController()
    const { service, target, draft, job, revision } = await lockedAssetFixture(async () => {
      controller.abort(new Error('用户停止运行'))
      return true
    })
    const candidate = await service.invoke('propose', {
      ...target, baseRevision: revision, jobId: job.id,
      draft: { ...draft, assets: draft.assets.map(asset => asset.id === 'actor' ? { ...asset, description: '取消后的迟到修改' } : asset) },
      summary: '修改锁定角色',
    })
    await expect(service.invoke('adopt', { ...target, baseRevision: revision, candidateId: candidate.id }, controller.signal))
      .rejects.toThrow()
    expect((await service.invoke('load', target)).document.revision).toBe(revision)
  })
  test('Given 只修改非锁定资产 When 采用 Then 不请求锁定授权', async () => {
    const requests: VisualLockedAssetApprovalRequest[] = []
    const { service, target, draft, job, revision } = await lockedAssetFixture(async request => {
      requests.push(request)
      return false
    })
    const candidate = await service.invoke('propose', {
      ...target, baseRevision: revision, jobId: job.id,
      draft: { ...draft, assets: draft.assets.map(asset => asset.id === 'prop' ? { ...asset, description: '改成红伞' } : asset) },
      summary: '修改普通道具',
    })
    const adopted = await service.invoke('adopt', { ...target, baseRevision: revision, candidateId: candidate.id })
    expect(requests).toHaveLength(0)
    expect(adopted.document.assets.find(asset => asset.id === 'prop')?.description).toBe('改成红伞')
  })
  test('When 正式版本更新 Then 旧候选和运行任务失效', async () => {
    const { service, snapshot, target } = await fixture()
    const job = await service.invoke('beginJob', { ...target, baseRevision: 1, instruction: '制作' })
    const pending = await service.invoke('beginJob', { ...target, baseRevision: 1, instruction: '并行制作' })
    const candidate = await service.invoke('propose', { ...target, baseRevision: 1, jobId: job.id, draft: editable(snapshot.document), summary: '候选' })
    const saved = await service.invoke('save', { ...target, baseRevision: 1, draft: { ...editable(snapshot.document), brief: '新设定' } })
    expect(saved.candidates[0]?.status).toBe('stale')
    expect(saved.jobs.find(item => item.id === pending.id)?.status).toBe('interrupted')
    await expect(service.invoke('adopt', { ...target, baseRevision: 2, candidateId: candidate.id })).rejects.toThrow()
  })
})


describe('Given 作品独立媒体与受管文件', () => {
  test('When 导入媒体后来源删除 Then 副本仍可读取且正式版本不变', async () => {
    const { service, snapshot, target, projectRoot } = await fixture()
    const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex')
    writeFileSync(join(projectRoot, 'image.png'), bytes)
    const media = await service.invoke('importFile', { ...target, relativePath: 'image.png' })
    rmSync(join(projectRoot, 'image.png'))
    expect(Buffer.from((await service.invoke('mediaContent', { ...target, mediaId: media.id })).bytes)).toEqual(bytes)
    expect((await service.invoke('load', target)).document.revision).toBe(1)
    const draft = { ...editable(snapshot.document), assets: [{ id: 'asset', name: '产品', type: '产品', description: '第一版', locked: false, mediaId: media.id }], shots: [{ id: 'shot', episodeId: snapshot.document.episodes[0]!.id, title: '镜头', duration: 4, scene: '', motion: '', dialogue: '', assetIds: ['asset'], mediaId: media.id }] }
    const initial = await service.invoke('save', { ...target, baseRevision: 1, draft })
    expect(initial.shotStates.shot).toEqual({ revision: 1, outputVersion: 1, needsUpdate: false })
    const changed = await service.invoke('save', { ...target, baseRevision: 2, draft: { ...draft, assets: [{ ...draft.assets[0]!, description: '第二版' }] } })
    expect(changed.shotStates.shot?.needsUpdate).toBe(true)
    expect(changed.document.shots[0]?.mediaId).toBe(media.id)
    expect(changed.assetVersions.asset).toBe(2)
  })
  test('When 读取链接或越界来源 Then 拒绝且不登记媒体', async () => {
    const { service, target, projectRoot } = await fixture()
    writeFileSync(join(projectRoot, 'image.png'), Buffer.from('89504e470d0a1a0a00000000', 'hex'))
    symlinkSync(join(projectRoot, 'image.png'), join(projectRoot, 'linked.png'))
    await expect(service.invoke('importFile', { ...target, relativePath: 'linked.png' })).rejects.toThrow()
    await expect(service.invoke('importFile', { ...target, relativePath: '../image.png' })).rejects.toThrow()
    expect((await service.invoke('load', target)).media).toHaveLength(0)
  })
  test('When 快照损坏 Then 报错而不静默重置', async () => {
    const { service, target, projectRoot } = await fixture()
    writeFileSync(join(projectRoot, '.dutydeck', 'visual-production', 'projects', target.productionId, 'snapshot.json'), '{broken')
    await expect(service.invoke('load', target)).rejects.toThrow()
    await expect(service.invoke('list', { sessionId: 'session' })).rejects.toThrow()
  })
})


test('Given 损坏任务索引 When 读取作品 Then 拒绝不可信运行状态', async () => {
  const { service, target, projectRoot } = await fixture()
  const path = join(projectRoot, '.dutydeck', 'visual-production', 'projects', target.productionId, 'snapshot.json')
  const snapshot = JSON.parse(readFileSync(path, 'utf8'))
  snapshot.jobs = [{ id: 'job', sessionId: 'session', status: 'running', baseRevision: -1 }]
  writeFileSync(path, JSON.stringify(snapshot))
  await expect(service.invoke('load', target)).rejects.toThrow('任务索引损坏')
})

test('Given 工作流发现身份被改坏 When 读取作品 Then 拒绝伪造的精确选择', async () => {
  const { service, target, projectRoot } = await fixture()
  const path = join(projectRoot, '.dutydeck', 'visual-production', 'projects', target.productionId, 'snapshot.json')
  const snapshot = JSON.parse(readFileSync(path, 'utf8'))
  snapshot.jobs = [{
    id: 'job', sessionId: 'session', status: 'running', baseRevision: 1, mediaKind: 'video',
    instruction: '生成', createdAt: 1,
    workflowDiscovery: {
      status: 'selected', connectionId: 'comfy.local', mediaKind: 'video', candidateCount: 1,
      blockedCount: 0, nextOffset: null,
      selectedWorkflow: { workflowId: 'workflow', workflowRevision: 2, contentHash: 'forged' },
    },
  }]
  writeFileSync(path, JSON.stringify(snapshot))
  await expect(service.invoke('load', target)).rejects.toThrow('工作流发现索引损坏')
})

test('Given 同一版本两个客户端 When 同时保存 Then 只允许一次正式提交', async () => {
  const { service, snapshot, target } = await fixture()
  const outcomes = await Promise.allSettled([
    service.invoke('save', { ...target, baseRevision: 1, draft: { ...editable(snapshot.document), brief: 'A' } }),
    service.invoke('save', { ...target, baseRevision: 1, draft: { ...editable(snapshot.document), brief: 'B' } }),
  ])
  expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1)
  expect((await service.invoke('load', target)).document.revision).toBe(2)
})

test('Given 单镜头任务 When 通过候选重排目标镜头 Then 拒绝范围外顺序变化', async () => {
  const { service, snapshot, target } = await fixture()
  const shot = { id: 'shot1', episodeId: snapshot.document.episodes[0]!.id, title: '镜头', duration: 4, scene: '', motion: '', dialogue: '', assetIds: [], mediaId: null }
  const draft = { ...editable(snapshot.document), shots: [shot, { ...shot, id: 'shot2' }] }
  await service.invoke('save', { ...target, baseRevision: 1, draft })
  const job = await service.invoke('beginJob', { ...target, baseRevision: 2, instruction: '修改镜头', shotId: 'shot1' })
  await expect(service.invoke('propose', { ...target, baseRevision: 2, jobId: job.id, draft: { ...draft, shots: [...draft.shots].reverse() }, summary: '重排' })).rejects.toThrow('单镜头')
})

test('Given 已导入音频 When 将音频作为正式镜头画面 Then 拒绝引用', async () => {
  const { service, snapshot, target, projectRoot } = await fixture()
  writeFileSync(join(projectRoot, 'voice.wav'), Buffer.from('RIFF0000WAVE0000'))
  const media = await service.invoke('importFile', { ...target, relativePath: 'voice.wav' })
  const shot = { id: 'shot', episodeId: snapshot.document.episodes[0]!.id, title: '镜头', duration: 4, scene: '', motion: '', dialogue: '', assetIds: [], mediaId: media.id }
  await expect(service.invoke('save', { ...target, baseRevision: 1, draft: { ...editable(snapshot.document), shots: [shot] } })).rejects.toThrow('镜头媒体')
})

test('Given 图片作品与视频素材 When 将视频作为图片输出 Then 拒绝引用', async () => {
  const { service, snapshot, target, projectRoot } = await fixture()
  writeFileSync(join(projectRoot, 'clip.mp4'), Buffer.from('0000ftypisom0000'))
  const media = await service.invoke('importFile', { ...target, relativePath: 'clip.mp4' })
  const shot = { id: 'shot', episodeId: snapshot.document.episodes[0]!.id, title: '图片', duration: 0, scene: '', motion: '', dialogue: '', assetIds: [], mediaId: media.id }
  await expect(service.invoke('save', { ...target, baseRevision: 1, draft: { ...editable(snapshot.document), kind: 'image', shots: [shot] } })).rejects.toThrow('镜头媒体')
})

test('Given 单镜头任务 When 将目标移动到其他集 Then 拒绝越界候选', async () => {
  const { service, snapshot, target } = await fixture()
  const shot = { id: 'shot', episodeId: snapshot.document.episodes[0]!.id, title: '镜头', duration: 4, scene: '', motion: '', dialogue: '', assetIds: [], mediaId: null }
  const draft = { ...editable(snapshot.document), episodes: [...snapshot.document.episodes, { id: 'episode2', title: '第二集' }], shots: [shot] }
  await service.invoke('save', { ...target, baseRevision: 1, draft })
  const job = await service.invoke('beginJob', { ...target, baseRevision: 2, instruction: '修改镜头', shotId: 'shot' })
  await expect(service.invoke('propose', { ...target, baseRevision: 2, jobId: job.id, draft: { ...draft, shots: [{ ...shot, episodeId: 'episode2' }] }, summary: '跨集' })).rejects.toThrow('单镜头')
})

test('Given 磁盘媒体元数据类型被改坏 When 读取作品 Then 拒绝损坏索引', async () => {
  const { service, target, projectRoot } = await fixture()
  writeFileSync(join(projectRoot, 'image.png'), Buffer.from('89504e470d0a1a0a00000000', 'hex'))
  await service.invoke('importFile', { ...target, relativePath: 'image.png' })
  const path = join(projectRoot, '.dutydeck', 'visual-production', 'projects', target.productionId, 'snapshot.json')
  const snapshot = JSON.parse(readFileSync(path, 'utf8'))
  snapshot.media[0].kind = 'audio'
  writeFileSync(path, JSON.stringify(snapshot))
  await expect(service.invoke('load', target)).rejects.toThrow('媒体索引损坏')
})

test('Given 候选历史达到上限 When 丢弃旧候选后继续生成 Then 裁剪终态并允许继续', async () => {
  const { service, snapshot, target } = await fixture()
  for (let index = 0; index < 33; index++) {
    const job = await service.invoke('beginJob', { ...target, baseRevision: 1, instruction: '生成' })
    const candidate = await service.invoke('propose', { ...target, baseRevision: 1, jobId: job.id, draft: editable(snapshot.document), summary: '候选' })
    await service.invoke('discardCandidate', { ...target, candidateId: candidate.id })
  }
  expect((await service.invoke('load', target)).candidates.length).toBeLessThanOrEqual(32)
})

test('Given 任务历史达到上限 When 已失败后继续发起 Then 裁剪终态并允许继续', async () => {
  const { service, target } = await fixture()
  for (let index = 0; index < 101; index++) {
    const job = await service.invoke('beginJob', { ...target, baseRevision: 1, instruction: '生成' })
    await service.invoke('failJob', { ...target, jobId: job.id, message: '失败' })
  }
  expect((await service.invoke('load', target)).jobs.length).toBeLessThanOrEqual(100)
})

/** 建立三镜头、正式引用与未绑定素材，验证真实范围边界。 */
async function loopFixture() {
  const context = await fixture()
  /** 正式媒体样本用于检验绑定范围与输出替换。 */
  const media: VisualMedia[] = []
  for (let index = 0; index < 4; index++) {
    writeFileSync(join(context.projectRoot, `image${index}.png`), Buffer.concat([Buffer.from('89504e470d0a1a0a00000000', 'hex'), Buffer.from([index])]))
    media.push(await context.service.invoke('importFile', { ...context.target, relativePath: `image${index}.png` }))
  }
  const draft = { ...editable(context.snapshot.document), assets: [{ id: 'asset', name: '产品', type: '产品', description: '', locked: true, mediaId: media[0]!.id }], shots: [1, 2, 3].map(index => ({ id: `shot${index}`, episodeId: context.snapshot.document.episodes[0]!.id, title: `镜头${index}`, duration: 5, scene: '', motion: '', dialogue: '', assetIds: index === 3 ? ['asset'] : [], mediaId: media[index === 3 ? 1 : 2]!.id })) }
  await context.service.invoke('save', { ...context.target, baseRevision: 1, draft })
  const job = await context.service.invoke('beginJob', { ...context.target, baseRevision: 2, instruction: '只重做第三镜头', shotId: 'shot3' })
  return { ...context, media, draft, job }
}

test('Given 第三镜头任务 When 登记替换输出 Then 仅第三镜头候选变化且采纳前正式不变', async () => {
  const { service, target, media, draft, job } = await loopFixture()
  const input = { ...target, baseRevision: 2, jobId: job.id, shotId: 'shot3', mediaId: media[3]!.id, summary: '替换第三镜头' }
  await expect(service.invoke('proposeShot', { ...input, shotId: 'shot2' })).rejects.toThrow()
  await expect(service.invoke('proposeShot', { ...input, mediaId: media[1]!.id })).rejects.toThrow()
  const candidate = await service.invoke('proposeShot', input)
  expect(candidate.draft).toEqual({ ...draft, shots: draft.shots.map(shot => shot.id === 'shot3' ? { ...shot, mediaId: media[3]!.id, outputs: { image: media[3]!.id, video: null, audio: null } } : shot) })
  expect(editable((await service.invoke('load', target)).document)).toEqual(draft)
  const adopted = await service.invoke('adopt', { ...target, baseRevision: 2, candidateId: candidate.id })
  expect(adopted.document.shots).toEqual(candidate.draft.shots)
  await expect(service.invoke('updateJob', { ...target, baseRevision: 3, jobId: job.id, stage: 'generating' })).rejects.toThrow()
})

test('Given 当前运行任务 When 推进阶段 Then 拒绝倒退、跨会话、旧版本和取消后复活', async () => {
  const { service, target, job } = await loopFixture()
  const input = { ...target, baseRevision: 2, jobId: job.id, stage: 'generating' as const }
  expect((await service.invoke('updateJob', input)).stage).toBe('generating')
  await expect(service.invoke('updateJob', { ...input, stage: 'preparing' })).rejects.toThrow()
  await expect(service.invoke('updateJob', { ...input, sessionId: 'other' })).rejects.toThrow()
  await expect(service.invoke('updateJob', { ...input, baseRevision: 1 })).rejects.toThrow()
  await service.invoke('cancelJob', { ...target, jobId: job.id })
  await expect(service.invoke('updateJob', input)).rejects.toThrow()
})

test('Given 镜头参考素材 When 转为媒体工具引用 Then 仅允许目标输出及正式绑定资产', async () => {
  const { projectRoot, target, job, media } = await loopFixture()
  let calls = 0
  const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot, registerReference: async ({ media: item, bytes }) => {
    calls++; expect(bytes.length).toBe(item.byteSize)
    return { assetId: 'registered', revision: 1, hash: item.hash, mediaKind: item.kind }
  } })
  const input = { ...target, baseRevision: 2, jobId: job.id, mediaId: media[0]!.id }
  expect((await service.invoke('referenceMedia', input)).hash).toBe(media[0]!.hash)
  await service.invoke('referenceMedia', { ...input, mediaId: media[1]!.id })
  for (const mediaId of [media[2]!.id, media[3]!.id]) await expect(service.invoke('referenceMedia', { ...input, mediaId })).rejects.toThrow()
  await expect(service.invoke('referenceMedia', { ...input, sessionId: 'other' })).rejects.toThrow()
  await expect(service.invoke('referenceMedia', { ...input, baseRevision: 1 })).rejects.toThrow()
  expect(calls).toBe(2)
  await service.invoke('cancelJob', { ...target, jobId: job.id })
  await expect(service.invoke('referenceMedia', input)).rejects.toThrow()
})

test('Given 登记参考进行中 When 会话失效或宿主返回错误身份 Then 不返回可用引用', async () => {
  const { projectRoot, target, job, media } = await loopFixture()
  let current = true
  const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot, assertCurrent: () => { if (!current) throw new Error('会话失效') }, registerReference: async ({ media: item }) => {
    current = false
    return { assetId: 'registered', revision: 1, hash: item.hash, mediaKind: item.kind }
  } })
  const input = { ...target, baseRevision: 2, jobId: job.id, mediaId: media[0]!.id }
  await expect(service.invoke('referenceMedia', input)).rejects.toThrow('会话失效')
  const mismatched = new VisualProductionService({ workspaceId: 'workspace', projectRoot, registerReference: async () => ({ assetId: 'registered', revision: 1, hash: '0'.repeat(64), mediaKind: 'video' }) })
  await expect(mismatched.invoke('referenceMedia', input)).rejects.toThrow()
})

for (const invalidation of ['cancel', 'revision'] as const) {
  test(`Given 登记参考进行中 When 磁盘任务发生 ${invalidation} Then 迟到引用不能返回`, async () => {
    const { projectRoot, target, job, media } = await loopFixture()
    const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot, registerReference: async ({ media: item }) => {
      /** 模拟锁外进程破坏或恢复替换快照，确保异步返回仍复核最新任务。 */
      const path = join(projectRoot, '.dutydeck', 'visual-production', 'projects', target.productionId, 'snapshot.json')
      const snapshot = JSON.parse(readFileSync(path, 'utf8'))
      if (invalidation === 'cancel') snapshot.jobs[0].status = 'cancelled'
      else snapshot.document.revision++
      writeFileSync(path, JSON.stringify(snapshot))
      return { assetId: 'registered', revision: 1, hash: item.hash, mediaKind: item.kind }
    } })
    await expect(service.invoke('referenceMedia', { ...target, baseRevision: 2, jobId: job.id, mediaId: media[0]!.id })).rejects.toThrow()
  })
}

test('Given 整作品任务 When 转换其他镜头正式媒体 Then 允许但拒绝未绑定素材', async () => {
  const { projectRoot, target, media, service: original } = await loopFixture()
  const job = await original.invoke('beginJob', { ...target, baseRevision: 2, instruction: '整片制作' })
  const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot, registerReference: async ({ media: item }) => ({ assetId: 'registered', revision: 1, hash: item.hash, mediaKind: item.kind }) })
  const input = { ...target, baseRevision: 2, jobId: job.id, mediaId: media[2]!.id }
  expect((await service.invoke('referenceMedia', input)).hash).toBe(media[2]!.hash)
  await expect(service.invoke('referenceMedia', { ...input, mediaId: media[3]!.id })).rejects.toThrow()
  await service.invoke('failJob', { ...target, jobId: job.id, message: '模型失败' })
  await expect(service.invoke('updateJob', { ...target, baseRevision: 2, jobId: job.id, stage: 'generating' })).rejects.toThrow()
})

describe('Given 作品制作配置', () => {
  test('When 保存空范围 Then 独立递增配置版本并冻结到任务且拒绝旧配置版本', async () => {
    const { service, target } = await fixture()
    const saved = await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 0, entries: [], defaults: {} })
    expect(saved.document.revision).toBe(1)
    expect(saved.mediaConfiguration).toEqual({ revision: 1, entries: [], defaults: {} })
    const job = await service.invoke('beginJob', { ...target, baseRevision: 1, instruction: '制作' })
    await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 1, entries: [], defaults: {} })
    expect(job.mediaConfiguration?.revision).toBe(1)
    expect((await service.invoke('load', target)).jobs[0]?.status).toBe('running')
    await expect(service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 0, entries: [], defaults: {} })).rejects.toThrow('CONFLICT')
  })
})

test('Given 制作目录 When 保存支持方案或失效项 Then 校验参数、默认和来源且允许保留失效原项', async () => {
  const { projectRoot, target } = await fixture()
  /** 隔离目录可切换可用性，不探测真实远程服务。 */
  let available = true
  const entry = { id: 'image-default', name: '图片模型', kind: 'image' as const, source: { type: 'model' as const, modelRef: 'profile:model' }, parameters: { size: '1024x1024' } }
  const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot, listMediaOptions: async () => [{ ...entry, available, constraints: { parameters: [{ key: 'size', label: '尺寸', type: 'string', options: ['1024x1024'] }] } }] })
  expect(await service.invoke('mediaCatalog', target)).toHaveLength(1)
  await expect(service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 0, entries: [{ ...entry, parameters: { secret: 'no' } }], defaults: {} })).rejects.toThrow('参数')
  await expect(service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 0, entries: [entry], defaults: { video: entry.id } })).rejects.toThrow('默认')
  await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 0, entries: [entry], defaults: { image: entry.id } })
  available = false
  expect((await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 1, entries: [entry], defaults: {} })).mediaConfiguration?.revision).toBe(2)
  await expect(service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 2, entries: [{ ...entry, name: '修改失效项' }], defaults: {} })).rejects.toThrow('不可用')
})

test('Given 冻结制作配置 When 宿主登记实际执行 Then 同身份幂等更新且拒绝未启用来源、跨会话和伪造字段', async () => {
  const { projectRoot, target } = await fixture()
  /** 模拟宿主可信回执，调用方只能提交运行身份。 */
  let modelRef = 'profile:model'
  let phase = 'prepared'
  const entry = { id: 'image-default', name: '图片模型', kind: 'image' as const, source: { type: 'model' as const, modelRef }, parameters: {} }
  const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot, listMediaOptions: async () => [{ ...entry, available: true, constraints: {} }], readMediaExecution: async (_sessionId, runId, engine) => ({ runId, engine, name: '真实模型', kind: 'image', source: { type: 'model', modelRef }, parameters: {}, referenceAssets: [], phase, createdAt: 1 }) })
  await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 0, entries: [entry], defaults: {} })
  const job = await service.invoke('beginJob', { ...target, baseRevision: 1, instruction: '生成' })
  const request = { ...target, baseRevision: 1, jobId: job.id, runId: 'run', engine: 'model' as const }
  expect((await service.invoke('recordMediaExecution', request)).mediaExecutions?.[0]?.entryId).toBe(entry.id)
  phase = 'completed'
  expect((await service.invoke('recordMediaExecution', request)).mediaExecutions).toHaveLength(1)
  expect((await service.invoke('load', target)).jobs[0]?.mediaExecutions?.[0]?.phase).toBe('completed')
  await expect(service.invoke('recordMediaExecution', { ...request, sessionId: 'other' })).rejects.toThrow('会话')
  await expect(service.invoke('recordMediaExecution', { ...request, ...{ prompt: '伪造' } })).rejects.toThrow('字段')
  modelRef = 'unselected'
  await expect(service.invoke('recordMediaExecution', request)).rejects.toThrow('冻结范围')
})


test('Given 制作配置与运行记录 When 导出清单 Then 包含冻结参数和实际执行元数据', async () => {
  const { projectRoot, target } = await fixture()
  const entry = { id: 'model', name: '图片', kind: 'image' as const, source: { type: 'model' as const, modelRef: 'profile:model' }, parameters: { size: 'small' } }
  let available = true
  const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot, listMediaOptions: async () => [{ ...entry, available, constraints: { parameters: [{ key: 'size', label: '尺寸', type: 'string' }] } }], readMediaExecution: async (_sessionId, runId, engine) => ({ runId, engine, name: '图片', kind: 'image', source: entry.source, parameters: { size: 'small' }, referenceAssets: [], phase: 'succeeded', createdAt: 1 }) })
  await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 0, entries: [entry], defaults: { image: entry.id } })
  const job = await service.invoke('beginJob', { ...target, baseRevision: 1, instruction: '生成' })
  await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 1, entries: [{ ...entry, parameters: { size: 'large' } }], defaults: { image: entry.id } })
  available = false
  const saved = await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 2, entries: [{ ...entry, parameters: { size: 'large' } }], defaults: { image: entry.id } })
  expect(saved.jobs[0]?.mediaConfiguration?.entries[0]?.parameters.size).toBe('small')
  expect(saved.mediaConfiguration?.defaults.image).toBe(entry.id)
  await service.invoke('recordMediaExecution', { ...target, baseRevision: 1, jobId: job.id, runId: 'run', engine: 'model' })
  const manifest = JSON.parse((await service.invoke('exportManifest', target)).json)
  expect(manifest.mediaConfiguration.entries[0].parameters.size).toBe('large')
  expect(manifest.jobs[0].mediaExecutions[0].parameters.size).toBe('small')
})

test('Given 作品启用 ComfyUI 服务 When Agent 选择工作流 Then 同服务允许、跨服务拒绝且记录保留精确执行来源', async () => {
  const { projectRoot, target } = await fixture()
  const entry = { id: 'comfy', name: 'Comfy服务', kind: 'image' as const, source: { type: 'connection' as const, connectionId: 'comfy.local' }, parameters: {} }
  let connectionId = 'comfy.local'
  const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot, listMediaOptions: async () => [{ ...entry, available: true, constraints: {} }], readMediaExecution: async (_session, runId, engine) => ({ runId, engine, name: 'Agent选择的工作流', kind: 'image', source: { type: 'workflow', connectionId, workflowId: 'flow', workflowRevision: 3 }, parameters: { seed: 1 }, referenceAssets: [], phase: 'prepared', createdAt: 1 }) })
  await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 0, entries: [entry], defaults: { image: entry.id } })
  const job = await service.invoke('beginJob', { ...target, baseRevision: 1, instruction: 'Agent选择工作流' })
  const request = { ...target, baseRevision: 1, jobId: job.id, runId: 'run', engine: 'workflow' as const }
  const recorded = await service.invoke('recordMediaExecution', request)
  expect(recorded.mediaExecutions?.[0]?.entryId).toBe('comfy')
  expect(recorded.mediaExecutions?.[0]?.source).toMatchObject({ type: 'workflow', workflowId: 'flow', workflowRevision: 3 })
  connectionId = 'other'
  await expect(service.invoke('recordMediaExecution', request)).rejects.toThrow('冻结范围')
  await expect(service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 1, entries: [{ ...entry, parameters: { seed: 3 } }], defaults: {} })).rejects.toThrow()
})

test('Given 旧作品精确工作流配置 When 查询目录 Then 只追加已保存历史版本并支持精确解析', async () => {
  const { projectRoot, target } = await fixture()
  const entry = { id: 'legacy', name: '旧工作流', kind: 'image' as const, source: { type: 'workflow' as const, connectionId: 'comfy', workflowId: 'flow', workflowRevision: 1 }, parameters: { seed: 1 } }
  const resolved: number[] = []
  let available = true
  const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot, listMediaOptions: async () => [], resolveMediaWorkflow: async (source, kind) => { resolved.push(source.workflowRevision); if (!available) throw new Error('removed'); return { ...entry, source, kind, available: true, constraints: { parameters: [{ key: 'seed', label: '种子', type: 'number' }] } } } })
  expect(await service.invoke('mediaCatalog', target)).toEqual([])
  await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 0, entries: [entry], defaults: {} })
  expect((await service.invoke('mediaCatalog', target))[0]?.source).toEqual(entry.source)
  const option = await service.invoke('resolveMediaWorkflow', { ...target, source: { ...entry.source, workflowRevision: 2 }, kind: 'image' })
  expect(option.source).toMatchObject({ workflowRevision: 2 })
  expect(resolved).toEqual([1, 1, 2])
  available = false
  const invalid = await service.invoke('mediaCatalog', target)
  expect(invalid[0]?.id).toBe(entry.id)
  expect(invalid[0]?.available).toBe(false)
  await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 1, entries: [entry], defaults: {} })
})

test('Given 同时保存服务和精确工作流 When 登记执行 Then 优先匹配精确方案且拒绝未授权输出类别', async () => {
  const { projectRoot, target } = await fixture()
  const connection = { id: 'connection', name: '服务', kind: 'image' as const, source: { type: 'connection' as const, connectionId: 'comfy' }, parameters: {} }
  const workflow = { id: 'workflow', name: '精确工作流', kind: 'image' as const, source: { type: 'workflow' as const, connectionId: 'comfy', workflowId: 'flow', workflowRevision: 1 }, parameters: {} }
  let kind: 'image' | 'video' = 'image'
  const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot, listMediaOptions: async () => [{ ...connection, available: true, constraints: {} }], resolveMediaWorkflow: async (source, outputKind) => ({ ...workflow, source, kind: outputKind, available: true, constraints: {} }), readMediaExecution: async (_session, runId, engine) => ({ runId, engine, name: '实际运行', kind, source: workflow.source, parameters: {}, referenceAssets: [], phase: 'prepared', createdAt: 1 }) })
  await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 0, entries: [connection, workflow], defaults: {} })
  const job = await service.invoke('beginJob', { ...target, baseRevision: 1, instruction: '生成' })
  const request = { ...target, baseRevision: 1, jobId: job.id, runId: 'run', engine: 'workflow' as const }
  expect((await service.invoke('recordMediaExecution', request)).mediaExecutions?.[0]?.entryId).toBe(workflow.id)
  kind = 'video'
  await expect(service.invoke('recordMediaExecution', request)).rejects.toThrow('冻结范围')
})


test('Given 已有画面的旧镜头 When 保存并采用声音设计候选 Then 持久化声音且标记需更新并保留输出', async () => {
  /** 在隔离项目导入图片，证明声音变化不会替换已有画面。 */
  const { service, snapshot, target, projectRoot } = await fixture()
  writeFileSync(join(projectRoot, 'image.png'), Buffer.from('89504e470d0a1a0a00000000', 'hex'))
  const media = await service.invoke('importFile', { ...target, relativePath: 'image.png' })
  const draft: VisualProductionDraft = { ...editable(snapshot.document), shots: [{ id: 'sound-shot', episodeId: snapshot.document.episodes[0]!.id, title: '镜头', duration: 4, scene: '', motion: '', dialogue: '对白', assetIds: [], mediaId: media.id }] }
  const initial = await service.invoke('save', { ...target, baseRevision: 1, draft })
  expect(initial.shotStates['sound-shot']!.needsUpdate).toBe(false)
  expect(initial.document.shots[0]!.soundDesign).toBeUndefined()
  /** 环境声与配乐作为制作设定持久化，不改变输出版本。 */
  draft.shots[0]!.soundDesign = { effects: '雨声', music: '钢琴' }
  const saved = await service.invoke('save', { ...target, baseRevision: 2, draft })
  expect(saved.shotStates['sound-shot']).toEqual({ revision: 2, outputVersion: 1, needsUpdate: true })
  expect((await service.invoke('load', target)).document.shots[0]!.soundDesign).toEqual(draft.shots[0]!.soundDesign)
  const job = await service.invoke('beginJob', { ...target, baseRevision: 3, instruction: '修改配乐', shotId: 'sound-shot' })
  draft.shots[0]!.soundDesign = { effects: '雨声', music: '弦乐' }
  const candidate = await service.invoke('propose', { ...target, baseRevision: 3, jobId: job.id, draft, summary: '声音候选' })
  expect(candidate.status).toBe('ready')
  expect((await service.invoke('load', target)).candidates[0]!.draft.shots[0]!.soundDesign).toEqual(draft.shots[0]!.soundDesign)
  const adopted = await service.invoke('adopt', { ...target, baseRevision: 3, candidateId: candidate.id })
  expect(adopted.document.shots[0]!.soundDesign).toEqual(draft.shots[0]!.soundDesign)
  expect(adopted.document.shots[0]!.mediaId).toBe(media.id)
  expect(adopted.shotStates['sound-shot']).toEqual({ revision: 3, outputVersion: 1, needsUpdate: true })
})
