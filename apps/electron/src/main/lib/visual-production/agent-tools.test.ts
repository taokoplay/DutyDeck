import { describe, expect, test } from 'bun:test'
import { buildVisualProductionAgentTools, VISUAL_PRODUCTION_AGENT_TOOL_NAMES } from './agent-tools'
import type { VisualProductionResults } from '@dutydeck/shared'
import { parseVisualProductionDraft } from '@dutydeck/shared'

describe('Given 主 Agent 影像工具', () => {
  test('When 注册作品候选工具 Then brief 明确为简介且说明剧本与镜头的填写位置', () => {
    /** 使用真实注册结果检查模型收到的字段说明，而非界面标签。 */
    const tools = buildVisualProductionAgentTools({ sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess() {}, async execute<M extends keyof VisualProductionResults>(): Promise<VisualProductionResults[M]> { return largeSnapshot() as unknown as VisualProductionResults[M] } })
    /** 整作品候选是 Agent 填写 brief 的实际入口。 */
    const propose = tools.find(tool => tool.name === 'visual_production_propose')!
    /** 仅检查可序列化 schema，确保说明实际发送给模型。 */
    const parameters = JSON.parse(JSON.stringify(propose.parameters)) as { properties: { draft: { properties: { brief: { description?: string } } } } }
    expect(parameters.properties.draft.properties.brief.description).toContain('作品简介')
    expect(parameters.properties.draft.properties.brief.description).toContain('episodes[].script')
    expect(parameters.properties.draft.properties.brief.description).toContain('shots[]')
    /** 模型提交剧本的实际入口应能识别规则与评审依据的落盘位置。 */
    const script = tools.find(tool => tool.name === 'visual_production_propose_script')!
    /** 检查经过序列化后真正发送给模型的字段描述。 */
    const scriptParameters = JSON.parse(JSON.stringify(script.parameters)) as { properties: { script: { properties: { productionNotes: { description?: string }; hook: { description?: string } } } } }
    expect(scriptParameters.properties.script.properties.productionNotes.description).toContain('角色知情范围')
    expect(scriptParameters.properties.script.properties.hook.description).toContain('时间窗')
  })

  test('When 注册工具 Then 提供受控候选采纳但不提供整作品直接保存且写操作检查权限', async () => {
    const writes: boolean[] = []
    const tools = buildVisualProductionAgentTools({ sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess: write => { writes.push(write) }, async execute<M extends keyof VisualProductionResults>(): Promise<VisualProductionResults[M]> { return largeSnapshot() as unknown as VisualProductionResults[M] } })
    expect(tools.map(tool => tool.name).sort()).toEqual([...VISUAL_PRODUCTION_AGENT_TOOL_NAMES].filter(name => !['visual_production_open_context', 'visual_production_inspect_media', 'visual_production_record_observation', 'visual_production_close_context'].includes(name)).sort())
    expect(tools.some(tool => tool.name === 'visual_production_adopt_candidate')).toBe(true)
    expect(tools.some(tool => tool.name.includes('save'))).toBe(false)
    const create = tools.find(tool => tool.name === 'visual_production_create')!
    await create.execute('call', { title: '作品', kind: 'film' }, new AbortController().signal, undefined, {} as never)
    expect(writes).toEqual([true])
    await expect(create.execute('call', { title: '作品', kind: 'film', sessionId: 'other' }, new AbortController().signal, undefined, {} as never)).rejects.toThrow('INVALID_INPUT')
    const reference = tools.find(tool => tool.name === 'visual_production_reference_media')!
    expect(reference.description).toContain('inputs.reference')
    expect(reference.description).toContain('kind: "asset"')
  })

  test('When 用户明确授权采用精确候选 Then 只传递候选身份和当前正式版本', async () => {
    const calls: unknown[] = []
    const writes: boolean[] = []
    const snapshot = largeSnapshot()
    snapshot.candidates[0]!.status = 'adopted'
    /** 采用回执无须重复与本次变更无关的作品长描述和历史候选。 */
    snapshot.document.brief = '不应重复的作品正文'.repeat(10_000)
    const tools = buildVisualProductionAgentTools({
      sessionId: 'session',
      sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'],
      assertAccess(write) { writes.push(write) },
      execute: (async (method, input) => { calls.push({ method, input }); return snapshot }) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'],
    })
    const adopt = tools.find(tool => tool.name === 'visual_production_adopt_candidate')!
    const result = await adopt.execute('call', { productionId: 'production', baseRevision: 2, candidateId: 'candidate' }, undefined, undefined, {} as never)

    expect(calls).toEqual([{ method: 'adopt', input: { sessionId: 'session', productionId: 'production', baseRevision: 2, candidateId: 'candidate' } }])
    expect(writes).toEqual([true])
    expect(result.details).toMatchObject({ production: { revision: 1 }, candidates: [{ id: 'candidate', status: 'adopted' }] })
    /** 只拼接文本块，保持工具结果的图片联合类型边界。 */
    const responseText = result.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('')
    expect(responseText.length).toBeLessThan(1_024)
    expect(responseText).not.toContain('不应重复的作品正文')
    await expect(adopt.execute('call', { productionId: 'production', baseRevision: 2, candidateId: 'candidate', draft: {} }, undefined, undefined, {} as never)).rejects.toThrow('INVALID_INPUT')
  })

  test('When 视频生成缺少镜头计划 Then 单工具原子写入首尾帧且只回传目标镜头', async () => {
    const calls: unknown[] = []
    const snapshot = largeSnapshot()
    const videoPlan = { mode: 'first-last-frame' as const, firstFrameAssetId: null, lastFrameAssetId: 'tail', transitionIn: 'hard-cut' as const, rationale: '白光吞没后接入下一镜。' }
    const continuityPlan = { entryState: '手掌贴合盘面。', exitState: '画面全白。', anchors: [], audioTransition: 'carry-over' as const, rationale: '声音延续到下一镜。' }
    snapshot.document.shots[0]!.assetIds = ['tail']
    snapshot.document.shots[0]!.videoPlan = videoPlan
    snapshot.document.shots[0]!.continuityPlan = continuityPlan
    const tools = buildVisualProductionAgentTools({
      sessionId: 'session',
      sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'],
      assertAccess() {},
      execute: (async (method, input) => { calls.push({ method, input }); return snapshot }) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'],
    })
    const update = tools.find(tool => tool.name === 'visual_production_update_shot_plan')!
    const result = await update.execute('call', {
      productionId: 'production', baseRevision: 1, shotId: 'shot0', videoPlan, continuityPlan,
      references: [{ assetId: 'tail', mediaId: 'tail-media', name: '全白尾帧', type: '场景', description: '约束最终过曝状态。' }],
    }, undefined, undefined, {} as never)
    expect(calls).toEqual([{ method: 'updateShotPlan', input: {
      sessionId: 'session', productionId: 'production', baseRevision: 1, shotId: 'shot0', videoPlan, continuityPlan,
      references: [{ assetId: 'tail', mediaId: 'tail-media', name: '全白尾帧', type: '场景', description: '约束最终过曝状态。' }],
    } }])
    expect(result.details).toMatchObject({ productionId: 'production', revision: 1, shot: { id: 'shot0', videoPlan } })
    expect(JSON.stringify(result.details)).not.toContain('画'.repeat(100))
  })

  test('When 读取并提出时间线修改 Then 只传结构化时间线且候选不直接采用', async () => {
    const calls: unknown[] = []
    const timeline = { schemaVersion: 1 as const, id: 'timeline', productionId: 'production', episodeId: 'episode', revision: 1, baseProductionRevision: 1, tracks: [{ id: 'video', kind: 'video' as const, clips: [{ id: 'clip', source: { type: 'shot-media' as const, shotId: 'shot', mediaId: 'media', mediaHash: 'a'.repeat(64), shotOutputVersion: 1 }, start: 0, duration: 2, sourceIn: 0, sourceOut: 2, label: '开场' }] }], duration: 2, createdAt: 1, updatedAt: 1 }
    const tools = buildVisualProductionAgentTools({ sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess() {}, execute: (async (method, input) => {
      calls.push({ method, input })
      if (method === 'loadTimeline') return { timeline, needsReplacementClipIds: [], candidates: [], exportJobs: [] }
      return { id: 'candidate', baseRevision: 1, timeline, operations: [{ type: 'trimClip', trackId: 'video', clipId: 'clip', sourceIn: 0, sourceOut: 1 }], summary: '缩短开场', status: 'ready', sessionId: 'session', createdAt: 1 }
    }) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'] })
    const read = tools.find(tool => tool.name === 'visual_production_read_timeline')!
    const readResult = await read.execute('call', { productionId: 'production', episodeId: 'episode' }, undefined, undefined, {} as never)
    expect(JSON.stringify(readResult.details)).toContain('timeline')
    const propose = tools.find(tool => tool.name === 'visual_production_propose_timeline_edit')!
    expect(JSON.stringify(propose.parameters)).toContain('replaceClipSource')
    expect(JSON.stringify(propose.parameters)).toContain('insertAudioClip')
    const proposeResult = await propose.execute('call', { productionId: 'production', episodeId: 'episode', expectedRevision: 1, operations: [{ type: 'trimClip', trackId: 'video', clipId: 'clip', sourceIn: 0, sourceOut: 1 }], summary: '缩短开场' }, undefined, undefined, {} as never)
    expect(calls[0]).toEqual({ method: 'loadTimeline', input: { sessionId: 'session', productionId: 'production', episodeId: 'episode' } })
    expect(calls[1]).toEqual({ method: 'proposeTimelineEdit', input: { sessionId: 'session', productionId: 'production', episodeId: 'episode', expectedRevision: 1, operations: [{ type: 'trimClip', trackId: 'video', clipId: 'clip', sourceIn: 0, sourceOut: 1 }], summary: '缩短开场' } })
    expect(JSON.stringify(proposeResult.details)).not.toContain('mediaHash')
    expect(proposeResult.details).toMatchObject({ id: 'candidate', status: 'ready', summary: '缩短开场' })
  })

  test('When Agent 粗剪并精确采用时间线 Then 透传两个正式版本且写回执不重复完整片段', async () => {
    const calls: unknown[] = []
    const writes: boolean[] = []
    const timeline = { schemaVersion: 1 as const, id: 'timeline', productionId: 'production', episodeId: 'episode', revision: 2, baseProductionRevision: 7, tracks: [{ id: 'video', kind: 'video' as const, clips: [{ id: 'clip', source: { type: 'shot-media' as const, shotId: 'shot', mediaId: 'media', mediaHash: 'a'.repeat(64), shotOutputVersion: 1 }, start: 0, duration: 2, sourceIn: 0, sourceOut: 2, label: '开场' }] }], duration: 2, createdAt: 1, updatedAt: 2 }
    const snapshot = { timeline, needsReplacementClipIds: [], candidates: [], exportJobs: [] }
    const tools = buildVisualProductionAgentTools({
      sessionId: 'session',
      sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'],
      assertAccess(write) { writes.push(write) },
      execute: (async (method, input) => { calls.push({ method, input }); return snapshot }) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'],
    })
    const rough = await tools.find(tool => tool.name === 'visual_production_create_rough_cut')!.execute(
      'call', { productionId: 'production', episodeId: 'episode', baseProductionRevision: 7 }, undefined, undefined, {} as never,
    )
    const adopted = await tools.find(tool => tool.name === 'visual_production_adopt_timeline_edit')!.execute(
      'call', { productionId: 'production', episodeId: 'episode', candidateId: 'candidate', expectedRevision: 2 }, undefined, undefined, {} as never,
    )

    expect(calls).toEqual([
      { method: 'createRoughCut', input: { sessionId: 'session', productionId: 'production', episodeId: 'episode', baseProductionRevision: 7 } },
      { method: 'adoptTimelineEdit', input: { sessionId: 'session', productionId: 'production', episodeId: 'episode', candidateId: 'candidate', expectedRevision: 2 } },
    ])
    expect(writes).toEqual([true, true])
    for (const result of [rough, adopted]) {
      expect(result.details).toMatchObject({ timeline: { revision: 2, baseProductionRevision: 7, tracks: [{ id: 'video', kind: 'video', clipCount: 1 }] }, needsReplacementClipIds: [] })
      expect(JSON.stringify(result.details)).not.toContain('mediaHash')
      expect(JSON.stringify(result.details)).not.toContain('"clips"')
    }
  })

  test('When Agent 请求原生候选预览 Then 注入会话并保留冻结版本候选和hash回执', async () => {
    /** 捕获真实工具边界，确认预览作为写操作注册且不要求采用候选。 */
    const calls: unknown[] = []
    const writes: boolean[] = []
    const input = { productionId: 'production', baseRevision: 7, episodeId: 'episode', expectedTimelineRevision: 4, candidateIds: ['candidate'], range: { start: 0, end: 10 }, settings: { ratio: '9:16', fps: 24, includeVoice: true, includeMusic: false, includeCaptions: false } }
    const job = { id: 'preview', timelineRevision: 4, sourceHashes: ['a'.repeat(64)], preview: { productionRevision: 7, candidateIds: input.candidateIds, range: input.range } }
    const tools = buildVisualProductionAgentTools({ sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess(write) { writes.push(write) }, execute: (async (method, data) => { calls.push({ method, input: data }); return job }) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'] })
    const tool = tools.find(item => item.name === 'visual_production_request_preview')
    expect(tool).toBeDefined()
    const result = await tool!.execute('call', input, undefined, undefined, {} as never)
    expect(calls).toEqual([{ method: 'requestPreview', input: { ...input, sessionId: 'session' } }])
    expect(writes).toEqual([true])
    expect(result.details).toEqual(job)
    /** 模型侧与宿主侧共同拒绝范围越界、重复候选和会话伪造，均不得执行。 */
    for (const invalid of [{ ...input, candidateIds: [] }, { ...input, candidateIds: ['candidate', 'candidate'] }, { ...input, range: { start: 0, end: 61 } }, { ...input, sessionId: 'other' }]) {
      await expect(tool!.execute('invalid', invalid, undefined, undefined, {} as never)).rejects.toThrow()
    }
    expect(calls).toHaveLength(1)
  })

  test('When Agent 请求、读取并取消成片导出 Then 透传精确设置且读取不申请写权限', async () => {
    const calls: unknown[] = []
    const writes: boolean[] = []
    const settings = { ratio: '16:9', fps: 24, includeVoice: true, includeMusic: true, includeCaptions: false }
    const job = { id: 'export-1', productionId: 'production', episodeId: 'episode', timelineRevision: 4, sourceHashes: ['a'.repeat(64)], settings, status: 'queued' as const, createdAt: 1, updatedAt: 1 }
    const tools = buildVisualProductionAgentTools({
      sessionId: 'session',
      sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'],
      assertAccess(write) { writes.push(write) },
      execute: (async (method, input) => {
        calls.push({ method, input })
        if (method === 'listExportJobs') return [job]
        if (method === 'cancelExport') return { ...job, status: 'cancelled', updatedAt: 2 }
        return job
      }) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'],
    })

    const requested = await tools.find(tool => tool.name === 'visual_production_request_export')!.execute(
      'call', { productionId: 'production', episodeId: 'episode', expectedTimelineRevision: 4, settings }, undefined, undefined, {} as never,
    )
    const listed = await tools.find(tool => tool.name === 'visual_production_list_export_jobs')!.execute(
      'call', { productionId: 'production', episodeId: 'episode' }, undefined, undefined, {} as never,
    )
    const cancelled = await tools.find(tool => tool.name === 'visual_production_cancel_export')!.execute(
      'call', { productionId: 'production', episodeId: 'episode', exportJobId: 'export-1' }, undefined, undefined, {} as never,
    )

    expect(calls).toEqual([
      { method: 'requestExport', input: { sessionId: 'session', productionId: 'production', episodeId: 'episode', expectedTimelineRevision: 4, settings } },
      { method: 'listExportJobs', input: { sessionId: 'session', productionId: 'production', episodeId: 'episode' } },
      { method: 'cancelExport', input: { sessionId: 'session', productionId: 'production', episodeId: 'episode', exportJobId: 'export-1' } },
    ])
    expect(writes).toEqual([true, false, true])
    expect(requested.details).toMatchObject({ id: 'export-1', status: 'queued', timelineRevision: 4 })
    expect(listed.details).toEqual([job])
    expect(cancelled.details).toMatchObject({ id: 'export-1', status: 'cancelled' })
  })

  test('When 提交单镜头多个输出 Then 将替选媒体身份完整透传并保留待采用', async () => {
    const calls: unknown[] = []
    const tools = buildVisualProductionAgentTools({ sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess() {}, execute: (async (method, input) => {
      calls.push({ method, input })
      return { id: 'candidate-multi', baseRevision: 5, status: 'ready', jobId: 'job', summary: '多图待选择' }
    }) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'] })
    const propose = tools.find(tool => tool.name === 'visual_production_propose_shot')!
    const result = await propose.execute('call', { productionId: 'production', baseRevision: 5, jobId: 'job', shotId: 'shot', mediaId: 'media-main', alternativeMediaIds: ['media-alt-1', 'media-alt-2'], summary: '多图待选择' }, undefined, undefined, {} as never)
    expect(calls).toEqual([{ method: 'proposeShot', input: { sessionId: 'session', productionId: 'production', baseRevision: 5, jobId: 'job', shotId: 'shot', mediaId: 'media-main', alternativeMediaIds: ['media-alt-1', 'media-alt-2'], summary: '多图待选择' } }])
    expect(result.details).toMatchObject({ status: 'ready', id: 'candidate-multi' })
  })

  test('When 提交单镜头唯一输出 Then 返回自动采用状态与正式版本', async () => {
    const tools = buildVisualProductionAgentTools({ sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess() {}, execute: (async () => ({ id: 'candidate-single', baseRevision: 5, status: 'adopted', adoptedRevision: 6, jobId: 'job', summary: '唯一图自动采用' })) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'] })
    const propose = tools.find(tool => tool.name === 'visual_production_propose_shot')!
    const result = await propose.execute('call', { productionId: 'production', baseRevision: 5, jobId: 'job', shotId: 'shot', mediaId: 'media-main', summary: '唯一图自动采用' }, undefined, undefined, {} as never)
    expect(result.details).toMatchObject({ status: 'adopted', adoptedRevision: 6 })
  })

  test('When 提交视频候选审核 Then 透传三项门禁、问题和未检查范围', async () => {
    const calls: unknown[] = []
    const tools = buildVisualProductionAgentTools({ sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess() {}, execute: (async (method, input) => {
      calls.push({ method, input })
      return { ...largeSnapshot().candidates[0]!, reviewRequired: true }
    }) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'] })
    const review = { technical: 'passed' as const, motion: 'passed' as const, continuity: 'warning' as const, audio: 'pending' as const, conclusion: '轻微停留偏长，声音待实际听验', unchecked: ['未听取完整音轨'], issues: [{ gate: 'continuity' as const, severity: 'warning' as const, message: '切点偏迟', atSeconds: 3.2 }, { gate: 'audio' as const, severity: 'warning' as const, message: '仅有技术证据，不能判断声线' }] }
    const result = await tools.find(tool => tool.name === 'visual_production_review_candidate')!.execute('call', { productionId: 'production', baseRevision: 1, candidateId: 'candidate', review }, undefined, undefined, {} as never)
    expect(calls).toEqual([{ method: 'reviewCandidate', input: { sessionId: 'session', productionId: 'production', baseRevision: 1, candidateId: 'candidate', review } }])
    expect(result.details).toMatchObject({ reviewRequired: true })
  })

  test('When 完整扫描后没有语义匹配 Then 保存可审计的 no-match 且由宿主补可信时间', async () => {
    const calls: unknown[] = []
    const tools = buildVisualProductionAgentTools({ sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess() {}, execute: (async (method, input) => {
      calls.push({ method, input })
      return {
        id: 'job', sessionId: 'session', baseRevision: 1, mediaKind: 'video', instruction: '生成', status: 'running', createdAt: 1,
        workflowDiscovery: input && typeof input === 'object' && 'discovery' in input ? input.discovery : undefined,
      }
    }) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'] })
    const tool = tools.find(item => item.name === 'visual_production_record_workflow_discovery')!
    const input = {
      productionId: 'production', baseRevision: 1, jobId: 'job', status: 'no-match' as const,
      connectionId: 'comfy.local', mediaKind: 'video' as const, candidateCount: 2, blockedCount: 0,
      nextOffset: null, snapshotId: 'snapshot-1', message: '两个候选均为单图输入，无法满足首尾帧约束',
    }
    const result = await tool.execute('call', input, undefined, undefined, {} as never)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'recordWorkflowDiscovery',
      input: {
        productionId: 'production', baseRevision: 1, jobId: 'job', sessionId: 'session',
        discovery: {
          status: 'no-match', connectionId: 'comfy.local', mediaKind: 'video',
          candidateCount: 2, blockedCount: 0, nextOffset: null,
          snapshotId: 'snapshot-1', message: input.message, checkedAt: expect.any(Number),
        },
      },
    })
    expect(result.details).toMatchObject({ jobId: 'job', workflowDiscovery: { status: 'no-match', message: input.message } })
  })

  test('When Agent 读取并提交整集剧本 Then 使用独立分页读取且只提交结构化节拍', async () => {
    const calls: unknown[] = []
    const snapshot = largeSnapshot()
    const episodeId = snapshot.document.episodes[0]!.id
    const shotId = snapshot.document.shots[0]!.id
    const script = {
      logline: '刑警在刑场醒来。', audiencePromise: '用证物逻辑争取重查。', hook: '醒来即在刑场。',
      turningPoint: '断口无法吻合。', payoff: '县令暂停行刑。', targetDurationSeconds: 5,
      productionNotes: '人物、空间与道具连续性固定。',
      beats: [{ id: 'beat-1', title: '醒来', purpose: 'hook' as const, dramaticQuestion: '这是哪里？', synopsis: '主角醒来。', visualAction: '眼部下摇到绑绳。', dialogue: '内心声。', sound: '木击。', continuity: '双腕绑于身前。', shotIds: [shotId] }],
    }
    snapshot.document.episodes[0]!.script = script
    const tools = buildVisualProductionAgentTools({ sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess() {}, execute: (async (method, input) => {
      calls.push({ method, input })
      if (method === 'load') return snapshot
      return { id: 'script-candidate', jobId: 'job', status: 'ready', baseRevision: 1, summary: '整集剧本', draft: snapshot.document, createdAt: 1 }
    }) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'] })
    const read = await tools.find(tool => tool.name === 'visual_production_read_script')!.execute('call', { productionId: 'production', episodeId, offset: 0, limit: 5 }, undefined, undefined, {} as never)
    expect(read.details).toMatchObject({ productionId: 'production', script: { logline: '刑警在刑场醒来。' }, beats: [{ id: 'beat-1', shots: [{ id: shotId }] }], nextOffset: null })
    const proposed = await tools.find(tool => tool.name === 'visual_production_propose_script')!.execute('call', { productionId: 'production', baseRevision: 1, jobId: 'job', episodeId, script, summary: '整集剧本' }, undefined, undefined, {} as never)
    expect(calls[1]).toMatchObject({ method: 'proposeScript', input: { sessionId: 'session', episodeId, script } })
    expect(proposed.details).toMatchObject({ id: 'script-candidate', status: 'ready' })
  })
})

/** 构造大型正式内容与候选，证明工具不会重复输出整个历史草稿。 */
function largeSnapshot(): import('@dutydeck/shared').VisualProductionSnapshot {
  const document = { schemaVersion: 1 as const, id: 'production', revision: 1, createdAt: 1, updatedAt: 1, title: '作品', kind: 'film' as const, brief: '', ratio: '16:9', fps: 24, voice: '', music: '', episodes: [{ id: 'episode', title: '第一集' }], assets: [], shots: Array.from({ length: 12 }, (_, index) => ({ id: `shot${index}`, episodeId: 'episode', title: '镜头', duration: 5, scene: '画'.repeat(7000), motion: '', dialogue: '', assetIds: [], mediaId: null })) }
  return { document, media: [], assetVersions: {}, shotStates: {}, jobs: [], candidates: [{ id: 'candidate', baseRevision: 1, jobId: 'job', createdAt: 1, status: 'ready', summary: '候选', draft: document }] }
}

test('Given 大型作品与候选 When Agent默认读取 Then 仅返回有界概览不重复候选正文', async () => {
  const snapshot = largeSnapshot()
  const tools = buildVisualProductionAgentTools({ sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess() {}, execute: (async () => snapshot) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'] })
  const result = await tools.find(tool => tool.name === 'visual_production_read')!.execute('call', { productionId: 'production' }, undefined, undefined, {} as never)
  const text = result.content.find(item => item.type === 'text')!
  expect(text.type === 'text' && text.text.length).toBeLessThanOrEqual(49152)
  expect(JSON.stringify(result.details)).not.toContain('画'.repeat(100))
})

test('Given 大型镜头集合 When Agent分页读取 Then 返回真实条目与下一页并遵守预算', async () => {
  const snapshot = largeSnapshot()
  const tools = buildVisualProductionAgentTools({ sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess() {}, execute: (async () => snapshot) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'] })
  const result = await tools.find(tool => tool.name === 'visual_production_read')!.execute('call', { productionId: 'production', section: 'shots', offset: 0, limit: 12 }, undefined, undefined, {} as never)
  const details = result.details as { items: unknown[]; nextOffset: number }
  expect(details.items.length).toBeGreaterThan(0)
  expect(details.nextOffset).toBe(details.items.length)
  expect(JSON.stringify(result.details).length).toBeLessThanOrEqual(49152)
})

test('Given 多镜头作品 When 精确读取镜头 Then 只返回目标和已绑定资产并保留正式版本', async () => {
  /** 有意在其他镜头写入特征文本，检查该文本不会进入工具响应。 */
  const snapshot = largeSnapshot()
  snapshot.document.shots[0]!.scene = '无关镜头正文'
  /** 全局长正文不应拉长目标镜头的默认文本游标。 */
  snapshot.document.brief = '全局创作目标'.repeat(2000)
  snapshot.document.voice = '全局配音'
  snapshot.document.music = '全局音乐'
  snapshot.document.shots[2]!.assetIds = ['actor']
  snapshot.document.assets = [{ id: 'actor', name: '角色', type: '角色', locked: true, description: '固定外观', mediaId: null }, { id: 'other', name: '其他资产', type: '道具', locked: false, description: '不要读取', mediaId: null }]
  snapshot.assetVersions.actor = 2
  snapshot.media = ['image', 'video', 'audio'].map(kind => ({ id: kind, kind: kind as 'image' | 'video' | 'audio', name: kind, mime: 'application/octet-stream', hash: 'a'.repeat(64), byteSize: 1, createdAt: 1 }))
  snapshot.document.shots[2]!.outputs = { image: 'image', video: 'video', audio: 'audio' }
  const calls: unknown[] = []
  const tools = buildVisualProductionAgentTools({ sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess() {}, execute: (async (method, input) => { calls.push({ method, input }); return snapshot }) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'] })
  const tool = tools.find(item => item.name === 'visual_production_read_shot')
  expect(tool).toBeDefined()
  const result = await tool!.execute('call', { productionId: 'production', shotId: 'shot2' }, undefined, undefined, {} as never)
  expect(calls).toEqual([{ method: 'load', input: { sessionId: 'session', productionId: 'production' } }])
  expect(result.details).toMatchObject({ productionId: 'production', revision: 1, shot: { id: 'shot2' }, assets: [{ id: 'actor', version: 2, locked: true }] })
  expect(result.details).toMatchObject({ productionTextIncluded: false, textPage: { total: 7000, nextOffset: null }, guidance: expect.stringContaining('includeProductionText=true') })
  expect((result.details as { settings: unknown }).settings).toEqual({ title: '作品', kind: 'film', ratio: '16:9', fps: 24 })
  expect(JSON.stringify(result.details)).not.toContain('全局创作目标')
  expect((result.details as { media: Array<{ id: string }> }).media.map(item => item.id)).toEqual(['image', 'video', 'audio'])
  expect(JSON.stringify(result.details)).not.toContain('无关镜头正文')
  expect(JSON.stringify(result.details)).not.toContain('不要读取')
  await expect(tool!.execute('call', { productionId: 'production', shotId: 'absent' }, undefined, undefined, {} as never)).rejects.toThrow('镜头不存在')
})

test('Given 单镜头候选工具 When 提交 Then 仅透传目标输出并拒绝附带整片草稿', async () => {
  /** 用窄执行器记录传入参数，确保模型无法借新工具修改场景或其他镜头。 */
  const calls: unknown[] = []
  const writes: boolean[] = []
  const tools = buildVisualProductionAgentTools({ sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess(write) { writes.push(write) }, execute: (async (method, input) => { calls.push({ method, input }); return { ...largeSnapshot().candidates[0]!, draft: largeSnapshot().document } }) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'] })
  const tool = tools.find(item => item.name === 'visual_production_propose_shot')
  expect(tool).toBeDefined()
  const input = { productionId: 'production', baseRevision: 1, jobId: 'job', shotId: 'shot2', mediaId: 'media', summary: '更新第三镜头' }
  const result = await tool!.execute('call', input, undefined, undefined, {} as never)
  expect(calls).toEqual([{ method: 'proposeShot', input: { ...input, sessionId: 'session' } }])
  expect(writes).toEqual([true])
  expect(JSON.stringify(result.details)).not.toContain('画'.repeat(100))
  await expect(tool!.execute('call', { ...input, draft: {} }, undefined, undefined, {} as never)).rejects.toThrow('INVALID_INPUT')
})

test.each(['普通文本', 'JSON转义文本'])('Given 合法最大镜头与200个长资产身份（%s） When 分页读取 Then 每页有界且可完整还原所有约束', async format => {
  /** 合法单条镜头足以超过常规列表分页预算，必须能沿引用游标续读。 */
  const snapshot = largeSnapshot()
  snapshot.document.assets = Array.from({ length: 200 }, (_, index) => ({ id: `asset${index}`.padEnd(128, 'x'), name: `资产${index}`, type: '角色', locked: true, description: '资产约束', mediaId: null }))
  snapshot.document.shots = [{ ...snapshot.document.shots[0]!, scene: (format === 'JSON转义文本' ? '\u0001' : '景').repeat(8000), motion: (format === 'JSON转义文本' ? '\u0002' : '动').repeat(8000), dialogue: (format === 'JSON转义文本' ? '\n' : '话').repeat(8000), soundDesign: { effects: '雨'.repeat(8000), music: '乐'.repeat(8000) }, assetIds: snapshot.document.assets.map(asset => asset.id) }]
  snapshot.document.brief = '目标'.repeat(8000)
  snapshot.document.voice = '声'.repeat(4000)
  snapshot.document.music = '乐'.repeat(4000)
  const { schemaVersion: _schema, id: _id, revision: _revision, createdAt: _created, updatedAt: _updated, ...draft } = snapshot.document
  expect(() => parseVisualProductionDraft(draft)).not.toThrow()
  const tools = buildVisualProductionAgentTools({ sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess() {}, execute: (async () => snapshot) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'] })
  const tool = tools.find(item => item.name === 'visual_production_read_shot')!
  const ids: string[] = []
  let offset: number | null = 0
  do {
    /** 每一引用页先完成长文本续读，正文、设定和资产描述逐字段还原。 */
    let textOffset: number | null = 0
    let nextReference: number | null = null
    const restored = { effects: '', shotMusic: '', scene: '', motion: '', dialogue: '', brief: '', voice: '', music: '' }
    const descriptions = new Map<string, string>()
    do {
      const result = await tool.execute('call', { productionId: 'production', shotId: 'shot0', referenceOffset: offset, referenceLimit: 20, textOffset, includeProductionText: true }, undefined, undefined, {} as never)
      expect(result.details).toMatchObject({ productionTextIncluded: true })
      const page = result.details as { shot: typeof snapshot.document.shots[number]; settings: { brief: string; voice: string; music: string }; referencePage: { nextOffset: number | null }; textPage: { nextOffset: number | null }; assets: Array<{ id: string; description: string }> }
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(49152)
      expect(page.shot.assetIds).toEqual(page.assets.map(asset => asset.id))
      if (textOffset === 0) ids.push(...page.assets.map(asset => asset.id))
      else expect(page.referencePage.nextOffset).toBe(nextReference)
      restored.effects += page.shot.soundDesign!.effects
      restored.shotMusic += page.shot.soundDesign!.music
      for (const field of ['scene', 'motion', 'dialogue'] as const) restored[field] += page.shot[field]
      for (const field of ['brief', 'voice', 'music'] as const) restored[field] += page.settings[field]
      for (const asset of page.assets) descriptions.set(asset.id, (descriptions.get(asset.id) ?? '') + asset.description)
      if (page.textPage.nextOffset !== null) expect(page.textPage.nextOffset).toBeGreaterThan(textOffset)
      textOffset = page.textPage.nextOffset
      nextReference = page.referencePage.nextOffset
    } while (textOffset !== null)
    expect(restored).toEqual({ effects: draft.shots[0]!.soundDesign!.effects, shotMusic: draft.shots[0]!.soundDesign!.music, scene: draft.shots[0]!.scene, motion: draft.shots[0]!.motion, dialogue: draft.shots[0]!.dialogue, brief: draft.brief, voice: draft.voice, music: draft.music })
    for (const [id, description] of descriptions) expect(description).toBe(draft.assets.find(asset => asset.id === id)!.description)
    if (nextReference !== null) expect(nextReference).toBeGreaterThan(offset)
    offset = nextReference
  } while (offset !== null)
  expect(ids).toEqual(draft.shots[0]!.assetIds)
})

test('Given 已保存制作配置 When Agent读取 Then 返回分页启用范围、默认与参数且不允许写配置', async () => {
  /** 创作正文很大时，制作配置仍有独立的有界读取入口。 */
  const snapshot = largeSnapshot()
  snapshot.mediaConfiguration = { revision: 2, entries: [{ id: 'source', name: '图片模型', kind: 'image', source: { type: 'model', modelRef: 'media:image:openai-images:profile:model' }, parameters: { size: '1536x1024' } }], defaults: { image: 'source' } }
  const calls: unknown[] = []
  const tools = buildVisualProductionAgentTools({ sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess(write) { expect(write).toBe(false) }, execute: (async (method, input) => { calls.push({ method, input }); return snapshot }) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'] })
  const result = await tools.find(tool => tool.name === 'visual_production_read_media_configuration')!.execute('call', { productionId: 'production', offset: 0, limit: 1 }, undefined, undefined, {} as never)
  expect(result.details).toMatchObject({ revision: 2, inherited: false, defaults: { image: 'source' }, entries: [{ id: 'source', parameters: { size: '1536x1024' } }], total: 1, nextOffset: null })
  expect(calls).toEqual([{ method: 'load', input: { sessionId: 'session', productionId: 'production' } }])
  expect(JSON.stringify(result.details)).not.toContain('画'.repeat(100))
  expect(tools.some(tool => tool.name.includes('save_media'))).toBe(false)
})

test('Given 大型冻结配置 When 创建或更新任务 Then 回执有界且可按原任务读取冻结参数', async () => {
  /** 任务配置刻意超过单次回执预算，模拟多模型与复杂工作流同时启用。 */
  const snapshot = largeSnapshot()
  const frozen = { revision: 2, defaults: { image: 'source0' }, entries: Array.from({ length: 32 }, (_, index) => ({ id: `source${index}`, name: `模型${index}`, kind: 'image' as const, source: { type: 'model' as const, modelRef: `ref${index}` }, parameters: { prompt: '冻结参数'.repeat(600) } })) }
  /** 当前配置已变化，读取旧任务必须保留旧 revision，不能悄悄退回当前配置。 */
  snapshot.mediaConfiguration = { revision: 3, defaults: {}, entries: [] }
  const job = { id: 'frozen-job', sessionId: 'session', baseRevision: 1, shotId: 'shot0', mediaKind: 'image' as const, instruction: '仅生成一个锚点', status: 'running' as const, stage: 'preparing' as const, createdAt: 1, mediaConfiguration: frozen }
  snapshot.jobs = [job, { ...job, id: 'other-job', sessionId: 'other' }]
  const calls: unknown[] = []
  const tools = buildVisualProductionAgentTools({ sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess() {}, execute: (async (method, input) => { calls.push({ method, input }); return method === 'load' ? snapshot : job }) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'] })
  for (const [name, input] of [
    ['visual_production_begin_job', { productionId: 'production', baseRevision: 1, shotId: 'shot0', mediaKind: 'image', instruction: '仅生成一个锚点' }],
    ['visual_production_update_job', { productionId: 'production', baseRevision: 1, jobId: job.id, stage: 'generating' }],
  ] as const) {
    const result = await tools.find(tool => tool.name === name)!.execute('call', input, undefined, undefined, {} as never)
    expect(result.details).toMatchObject({ id: job.id, mediaConfiguration: { revision: 2, defaults: { image: 'source0' }, entryCount: 32 } })
    expect(JSON.stringify(result.details).length).toBeLessThan(2_000)
    expect(JSON.stringify(result.details)).not.toContain('冻结参数')
  }
  const read = tools.find(tool => tool.name === 'visual_production_read_media_configuration')!
  const result = await read.execute('call', { productionId: 'production', jobId: job.id, offset: 1, limit: 1 }, undefined, undefined, {} as never)
  expect(result.details).toMatchObject({ jobId: job.id, revision: 2, inherited: false, total: 32, entries: [frozen.entries[1]], nextOffset: 2 })
  expect(calls.at(-1)).toEqual({ method: 'load', input: { sessionId: 'session', productionId: 'production' } })
  await expect(read.execute('call', { productionId: 'production', jobId: 'other-job' }, undefined, undefined, {} as never)).rejects.toThrow('任务不存在或不属于当前会话')
  await expect(read.execute('call', { productionId: 'production', jobId: 'missing' }, undefined, undefined, {} as never)).rejects.toThrow('任务不存在或不属于当前会话')
  snapshot.jobs[0] = { ...job, mediaConfiguration: undefined }
  const inherited = await read.execute('call', { productionId: 'production', jobId: job.id }, undefined, undefined, {} as never)
  expect(inherited.details).toMatchObject({ inherited: true, total: 0, entries: [] })
})

test('Given 大目录 When Agent分页 Then 返回能力与真实参考限制', async () => {
  /** 目录分页不把工具分页字段混入IPC严格信封。 */
  const options = Array.from({ length: 4 }, (_, index) => ({ id: `model${index}`, name: `模型${index}`, kind: 'image', source: { type: 'model', modelRef: `ref${index}` }, parameters: {}, available: true, constraints: { maxImageReferences: 1, parameters: [] } }))
  const calls: unknown[] = []
  const tools = buildVisualProductionAgentTools({ sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess() {}, execute: (async (method, input) => { calls.push({ method, input }); return options }) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'] })
  const result = await tools.find(tool => tool.name === 'visual_production_media_catalog')!.execute('call', { productionId: 'production', offset: 1, limit: 2 }, undefined, undefined, {} as never)
  expect(result.details).toMatchObject({ entries: [{ id: 'model1', constraints: { maxImageReferences: 1 } }, { id: 'model2' }], total: 4, nextOffset: 3 })
  expect(calls).toEqual([{ method: 'mediaCatalog', input: { sessionId: 'session', productionId: 'production' } }])
})
