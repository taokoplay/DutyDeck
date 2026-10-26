import { afterEach, describe, expect, it } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InteractionDesignService } from './store'
import { InteractionSourceService, interactionHash } from './source-service'
import { writeJsonFileAtomic } from '../safe-file'
import { parsePrototypeDraft } from '@dutydeck/shared'
import type { PrototypeCandidate, PrototypeDocument } from '@dutydeck/shared'

/** 测试独立目录，禁止触碰真实项目数据。 */
const roots: string[] = []
/** 创建隔离工作区服务。 */
function setup(): { root: string; service: InteractionDesignService } {
  /** 临时项目根。 */
  const root = mkdtempSync(join(tmpdir(), 'interaction-store-'))
  roots.push(root)
  return { root, service: new InteractionDesignService({ workspaceId: 'workspace', projectRoot: root }) }
}
/** 每例删除自己创建的隔离项目。 */
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
/** 统一的测试会话。 */
const sessionId = 'session'
/** 比较旧合同页面正文时忽略新增的页面独立版本元数据。 */
function withoutPageRevisions<T extends { pageRevision?: number }>(pages: T[]): Array<Omit<T, 'pageRevision'>> {
  return pages.map(({ pageRevision: _pageRevision, ...page }) => page)
}

/** 将现有合法模块复制成历史模块夹具，只重写身份和一页正文。 */
function clonePrototype(root: string, source: PrototypeDocument, id: string, name: string, html: string): void {
  /** 正式模块目录；复制后所有不可变内容仍属于隔离测试项目。 */
  const sourceDirectory = join(root, '.dutydeck', 'interaction-design', 'prototypes', source.id)
  const targetDirectory = join(root, '.dutydeck', 'interaction-design', 'prototypes', id)
  cpSync(sourceDirectory, targetDirectory, { recursive: true })
  /** head 身份必须与目标目录一致，避免服务把历史夹具误判为篡改。 */
  const headPath = join(targetDirectory, 'head.json')
  const head = JSON.parse(readFileSync(headPath, 'utf8')) as { prototypeId: string }
  head.prototypeId = id
  writeJsonFileAtomic(headPath, head)
  /** 版本元数据不保存 HTML，新增正文通过内容 hash 接回不可变内容目录。 */
  const legacy = structuredClone(source)
  legacy.id = id
  legacy.name = name
  legacy.pages[0] = { ...legacy.pages[0]!, name, html }
  const contentHash = interactionHash(html)
  writeJsonFileAtomic(join(targetDirectory, 'contents', `${contentHash}.json`), { html })
  const revisionPath = join(targetDirectory, 'revisions', `${source.revision}.json`)
  const stored = JSON.parse(readFileSync(revisionPath, 'utf8')) as { hash: string; document: { id: string; name: string; pages: Array<{ name: string; contentHash: string }> } }
  stored.document.id = id
  stored.document.name = name
  stored.document.pages[0]!.name = name
  stored.document.pages[0]!.contentHash = contentHash
  stored.hash = interactionHash(JSON.stringify([legacy.id, legacy.revision, legacy.createdAt, legacy.updatedAt, parsePrototypeDraft(legacy)]))
  writeJsonFileAtomic(revisionPath, stored)
}

/** 项目还原任务的完整规划，测试正文只关注任务边界而不伪造源码字节。 */
function restorePlan() {
  return {
    schemaVersion: 1 as const,
    summary: '按业务路由拆分页面',
    groups: [{ id: 'main', name: '核心导航' }],
    pages: [
      { id: 'home', name: '首页', groupId: 'main', role: '核心入口', entry: true, states: [], evidence: [] },
      { id: 'parking', name: '停车记录', groupId: 'main', role: '记录列表', states: [], evidence: [] },
    ],
    entryPageId: 'home',
    flows: [],
    unresolved: [],
  }
}

describe('交互设计版本与候选', () => {
  it('Given 两个页面各有独立候选 When 分别按页面基线自动采纳 Then 其他页面版本和候选不被全局版本变化拖 stale', async () => {
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '双页面', platform: 'mobile' })
    const base = { ...first.document, pages: [...first.document.pages, { id: 'detail', groupId: 'main', name: '详情', html: '<h1>详情</h1>' }] }
    const saved = await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: base, summary: '增加详情页' })
    const homeCandidate = await service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 2, draft: { ...saved.document, pages: saved.document.pages.map(page => page.id === 'home' ? { ...page, html: '<h1>新首页</h1>' } : page) }, summary: '更新首页' })
    const detailCandidate = await service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 2, draft: { ...saved.document, pages: saved.document.pages.map(page => page.id === 'detail' ? { ...page, html: '<h1>新详情</h1>' } : page) }, summary: '更新详情' })
    const homeRevision = saved.document.pages.find(page => page.id === 'home')?.pageRevision ?? 1
    const detailRevision = saved.document.pages.find(page => page.id === 'detail')?.pageRevision ?? 1
    const home = await service.invoke('adoptPage', { sessionId, prototypeId: first.document.id, candidateId: homeCandidate.id, pageId: 'home', baseRevision: 2, basePageRevision: homeRevision })
    expect(home.document.revision).toBe(3)
    expect(home.document.pages.find(page => page.id === 'home')?.pageRevision).toBe(homeRevision + 1)
    expect(home.document.pages.find(page => page.id === 'detail')?.pageRevision).toBe(detailRevision)
    const detail = await service.invoke('adoptPage', { sessionId, prototypeId: first.document.id, candidateId: detailCandidate.id, pageId: 'detail', baseRevision: 2, basePageRevision: detailRevision })
    expect(detail.document.pages.find(page => page.id === 'home')?.html).toBe('<h1>新首页</h1>')
    expect(detail.document.pages.find(page => page.id === 'detail')?.html).toBe('<h1>新详情</h1>')
    expect(detail.candidates.find(candidate => candidate.id === detailCandidate.id)?.status).toBe('adopted')
  })

  it('Given 页面候选与正式版本 When 请求页面对比 Then 只返回目标页正文和状态/素材/流程差异', async () => {
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '对比', platform: 'mobile' })
    const candidate = await service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: { ...first.document, pages: first.document.pages.map(page => ({ ...page, html: '<h1 data-prototype-element="title">新版</h1>', states: [{ id: 'empty', name: '空态', html: '<p>无数据</p>' }] })) }, summary: '更新首页状态' })
    const comparison = await service.invoke('comparePage', { sessionId, prototypeId: first.document.id, pageId: 'home', left: { revision: 1 }, right: { candidateId: candidate.id } })
    expect(comparison.defaultHtml.changed).toBe(true)
    expect(comparison.states.added).toEqual(['empty'])
    expect(comparison.right.html).toContain('新版')
    expect(JSON.stringify(comparison)).not.toContain('当前项目其他页面')
  })

  it('Given 目录已有同路由页面 When Agent 候选新增页面 Then 宿主要求复用已有pageId', async () => {
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '重复页', platform: 'mobile' })
    const routed = await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: { ...first.document, pages: first.document.pages.map(page => ({ ...page, route: '/' })) }, summary: '记录首页路由' })
    const draft = { ...routed.document, pages: [...routed.document.pages, { id: 'duplicate', groupId: 'main', name: '另一个首页', route: '/', html: '<h1>重复</h1>' }] }
    await expect(service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 2, draft, summary: '错误新增首页' })).rejects.toThrow('复用 pageId=home')
  })
  it('Given 附加状态脚本截断 When 提交候选 Then 拒绝并定位页面和状态且不推进版本', async () => {
    /** 独立测试服务与初始文档。 */
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '家具', platform: 'mobile' })
    /** 模拟模型在脚本中途耗尽输出的附加状态。 */
    const draft = { ...first.document, pages: first.document.pages.map(page => ({ ...page, name: '家具工作台', states: [{ id: 'selected', name: '选中部件', html: '<script>const selected = ' }] })) }
    await expect(service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft, summary: '生成状态' })).rejects.toThrow('家具工作台 / 选中部件')
    expect((await service.invoke('load', { sessionId, prototypeId: first.document.id })).document.revision).toBe(1)
  })

  it('Given 默认页面存在未导入图片 When 保存 Then 拒绝失效相对资源', async () => {
    /** 独立测试服务与初始文档。 */
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '家具', platform: 'mobile' })
    /** 图片路径没有经过项目资产导入。 */
    const draft = { ...first.document, pages: first.document.pages.map(page => ({ ...page, html: '<img src="assets/cabinet.png">' })) }
    await expect(service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft, summary: '保存' })).rejects.toThrow('离线')
  })

  it('Given 旧版合法哈希候选包含失效资源 When 读取和采纳 Then 允许读取修复但拒绝发布', async () => {
    /** 隔离目录及服务。 */
    const { root, service } = setup()
    const first = await service.invoke('create', { sessionId, name: '家具', platform: 'mobile' })
    const candidate = await service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '旧候选' })
    /** 模拟旧版本已保存且正文身份一致的候选，并非篡改检测测试。 */
    const path = join(root, '.dutydeck', 'interaction-design', 'prototypes', first.document.id, 'candidates', `${candidate.id}.json`)
    const stored = JSON.parse(readFileSync(path, 'utf8')) as PrototypeCandidate & { draftHash: string }
    stored.draft.pages[0]!.html = '<img src="assets/cabinet.png">'
    stored.draftHash = interactionHash(JSON.stringify(parsePrototypeDraft(stored.draft)))
    writeFileSync(path, JSON.stringify(stored))
    expect((await service.invoke('getCandidate', { sessionId, prototypeId: first.document.id, candidateId: candidate.id })).draft.pages[0]!.html).toContain('assets/cabinet.png')
    await expect(service.invoke('adopt', { sessionId, prototypeId: first.document.id, baseRevision: 1, candidateId: candidate.id })).rejects.toThrow('离线')
    expect((await service.invoke('load', { sessionId, prototypeId: first.document.id })).document.revision).toBe(1)
  })

  it('Given 旧版本坏状态 When 修改其他正文并采纳 Then 保留旧状态且检查报告缺陷但拒绝新增坏正文', async () => {
    /** 隔离项目及合法版本，随后只在夹具中还原历史坏内容。 */
    const { root, service } = setup()
    const first = await service.invoke('create', { sessionId, name: '家具', platform: 'mobile' })
    const saved = await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, summary: '状态', draft: { ...first.document, pages: first.document.pages.map(page => ({ ...page, name: '工作台', states: [{ id: 'selected', name: '选中部件', html: '<p>部件</p>' }] })) } })
    /** 模拟旧版存储合法身份与损坏语义同时存在，而不是破坏文件校验。 */
    const document = structuredClone(saved.document)
    document.pages[0]!.states![0]!.html = '<img src="assets/cabinet.png">'
    const directory = join(root, '.dutydeck', 'interaction-design', 'prototypes', document.id)
    const versionPath = join(directory, 'revisions', '2.json')
    const stored = JSON.parse(readFileSync(versionPath, 'utf8')) as { hash: string; document: { pages: Array<{ states: Array<{ contentHash: string }> }> } }
    const contentHash = interactionHash(document.pages[0]!.states![0]!.html)
    writeFileSync(join(directory, 'contents', `${contentHash}.json`), JSON.stringify({ html: document.pages[0]!.states![0]!.html }))
    stored.document.pages[0]!.states[0]!.contentHash = contentHash
    stored.hash = interactionHash(JSON.stringify([document.id, document.revision, document.createdAt, document.updatedAt, parsePrototypeDraft(document)]))
    writeFileSync(versionPath, JSON.stringify(stored))
    expect((await service.invoke('load', { sessionId, prototypeId: document.id })).document).toEqual(document)
    /** 诊断旧内容不阻断读取或不相关页面编辑。 */
    const check = await service.invoke('validate', { sessionId, prototypeId: document.id, revision: 2 })
    expect(check.issues.join('\n')).toContain('工作台 / 选中部件')
    const draft = { ...document, pages: document.pages.map(page => ({ ...page, html: '<h1>新的默认正文</h1>' })) }
    const candidate = await service.invoke('propose', { sessionId, prototypeId: document.id, baseRevision: 2, draft, summary: '只改默认正文' })
    const adopted = await service.invoke('adopt', { sessionId, prototypeId: document.id, baseRevision: 2, candidateId: candidate.id })
    expect(adopted.document.pages[0]!.states![0]!.html).toContain('assets/cabinet.png')
    /** 元数据更新同样不应要求用户修复无关旧状态。 */
    const renamed = await service.invoke('save', { sessionId, prototypeId: document.id, baseRevision: 3, draft: { ...adopted.document, name: '交互设计' }, summary: '改名称' })
    await expect(service.invoke('propose', { sessionId, prototypeId: document.id, baseRevision: 4, draft: { ...renamed.document, pages: renamed.document.pages.map(page => ({ ...page, states: [{ id: 'selected', name: '选中部件', html: '<img src="assets/other.png">' }] })) }, summary: '仍然坏的状态' })).rejects.toThrow('离线')
  })

  it('Given 项目还原任务缺少页面规划 When 开始生成 Then 宿主拒绝进入生成阶段', async () => {
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '车本本', platform: 'mobile' })
    await expect(service.invoke('beginJob', {
      sessionId, prototypeId: first.document.id, baseRevision: 1,
      instruction: '根据现有项目拆分多页面', mode: 'project-restore',
      pageManifest: [{ id: 'home', name: '首页' }, { id: 'parking', name: '停车记录' }],
    })).rejects.toThrow('页面规划')
  })

  it.each([undefined, 'page-edit', 'design'] as const)('Given 固定首页任务模式为 %s When 根据源码还原页面并采纳 Then 不要求整项目页面清单', async (mode) => {
    /** 隔离服务，mode 覆盖自动推断与显式指定的单页任务。 */
    const { service } = setup()
    /** 已有首页及固定调用基线。 */
    const first = await service.invoke('create', { sessionId, name: '首页原型', platform: 'mobile' })
    /** 本轮读写始终针对同一原型的 v1。 */
    const base = { sessionId, prototypeId: first.document.id, baseRevision: 1 }
    /** 指令含还原关键词，但任务仅允许修改首页。 */
    const job = await service.invoke('beginJob', { ...base, pageId: 'home', mode, instruction: '根据源码还原首页页面，其他业务页面不在范围' })
    /** 保留页面、目录与流程身份，只更换目标正文。 */
    const draft = { ...first.document, pages: first.document.pages.map(page => ({ ...page, html: '<h1>还原后的首页</h1>' })) }
    /** 新候选应在正式版本不变时成功提交。 */
    const candidate = await service.invoke('propose', { ...base, jobId: job.id, draft, summary: '还原首页' })
    expect(candidate.status).toBe('ready')
    expect((await service.invoke('load', base)).document.revision).toBe(1)
    /** 用户采纳后才推进正式版本。 */
    const adopted = await service.invoke('adopt', { ...base, candidateId: candidate.id })
    expect(adopted.document.revision).toBe(2)
    expect(withoutPageRevisions(adopted.document.pages)).toEqual(withoutPageRevisions(draft.pages))
    expect(adopted.candidates.find(value => value.id === candidate.id)?.status).toBe('adopted')
  })

  it('Given 缺少模式和规划的旧首页候选 When 采纳 Then 沿用固定单页范围且不重生成正文', async () => {
    /** 隔离目录用于构造升级前的任务记录。 */
    const { root, service } = setup()
    /** 旧候选基于现有首页。 */
    const first = await service.invoke('create', { sessionId, name: '旧首页', platform: 'mobile' })
    /** 统一调用归属与基线。 */
    const base = { sessionId, prototypeId: first.document.id, baseRevision: 1 }
    /** 先以不触发误判的指令创建有效候选。 */
    const job = await service.invoke('beginJob', { ...base, pageId: 'home', instruction: '调整首页' })
    /** 既有候选正文必须原样保留。 */
    const draft = { ...first.document, pages: first.document.pages.map(page => ({ ...page, html: '<h1>已生成的首页</h1>' })) }
    /** 模拟旧版本成功生成且仍待采纳的候选。 */
    const candidate = await service.invoke('propose', { ...base, jobId: job.id, draft, summary: '旧首页候选' })
    /** 旧合同没有 mode、plan 或 pageManifest，仅以 pageId 固定范围。 */
    const { mode: _mode, ...legacyJob } = job
    writeJsonFileAtomic(join(root, '.dutydeck', 'interaction-design', 'prototypes', first.document.id, 'jobs', `${job.id}.json`), {
      ...legacyJob, status: 'candidate', instruction: '继续已确认的首页还原任务，页面仅 home，不修改其他页面',
    })
    /** 升级后的服务应直接采纳原候选，而非要求用户补造多页规划。 */
    const adopted = await service.invoke('adopt', { ...base, candidateId: candidate.id })
    expect(adopted.document.revision).toBe(2)
    expect(withoutPageRevisions(adopted.document.pages)).toEqual(withoutPageRevisions(draft.pages))
  })

  it('Given 显式整项目还原任务同时指定首页 When 提交缺页候选 Then 仍执行整项目规划校验', async () => {
    /** 隔离服务与已有首页。 */
    const { service } = setup()
    /** 本例只存在首页，无法满足两个业务页面的规划。 */
    const first = await service.invoke('create', { sessionId, name: '还原保护', platform: 'mobile' })
    /** 固定原型身份与版本。 */
    const base = { sessionId, prototypeId: first.document.id, baseRevision: 1 }
    /** pageId 不能覆盖调用方明确声明的整项目还原模式。 */
    const job = await service.invoke('beginJob', { ...base, pageId: 'home', mode: 'project-restore', instruction: '还原项目页面', plan: restorePlan() })
    await expect(service.invoke('propose', { ...base, jobId: job.id, draft: first.document, summary: '缺少规划页面' })).rejects.toThrow('缺少业务页面')
    expect((await service.invoke('load', base)).document.revision).toBe(1)
  })

  it('Given 旧候选未绑定具体页面 When 说明要求还原项目页面 Then 不能绕过整项目规划校验', async () => {
    /** 隔离目录用于构造没有页面边界的旧任务。 */
    const { root, service } = setup()
    /** 已有原型和固定基线。 */
    const first = await service.invoke('create', { sessionId, name: '旧项目任务', platform: 'mobile' })
    /** 固定调用身份。 */
    const base = { sessionId, prototypeId: first.document.id, baseRevision: 1 }
    /** 创建没有 pageId 的任务与旧候选。 */
    const job = await service.invoke('beginJob', { ...base, instruction: '调整原型' })
    /** 已生成的候选不代表自动满足项目还原规划。 */
    const candidate = await service.invoke('propose', { ...base, jobId: job.id, draft: first.document, summary: '旧候选' })
    /** 旧任务没有 mode，也没有可约束候选的单页身份。 */
    const { mode: _mode, ...legacyJob } = job
    writeJsonFileAtomic(join(root, '.dutydeck', 'interaction-design', 'prototypes', first.document.id, 'jobs', `${job.id}.json`), {
      ...legacyJob, status: 'candidate', instruction: '根据现有项目还原业务页面',
    })
    await expect(service.invoke('adopt', { ...base, candidateId: candidate.id })).rejects.toThrow('缺少页面清单')
    expect((await service.invoke('load', base)).document.revision).toBe(1)
  })

  it('Given 完整页面规划 When 候选按规划提交 Then 宿主保留页面分组和状态并生成候选', async () => {
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '车本本', platform: 'mobile' })
    const group = first.document.groups[0]!
    const plan = {
      schemaVersion: 1 as const,
      summary: '核心页面规划',
      groups: [group],
      pages: [
        { id: 'home', name: '首页', groupId: group.id, role: '核心入口', entry: true, defaultStateName: '有数据', states: [{ id: 'empty', name: '无数据' }], evidence: [] },
        { id: 'parking', name: '停车记录', groupId: group.id, role: '记录列表', states: [], evidence: [] },
      ],
      entryPageId: 'home', flows: [], unresolved: [],
    }
    const job = await service.invoke('beginJob', { sessionId, prototypeId: first.document.id, baseRevision: 1, instruction: '根据现有项目拆分多页面', mode: 'project-restore', plan })
    const draft = {
      ...first.document,
      pages: [
        { ...first.document.pages[0]!, id: 'home', name: '首页', groupId: group.id, html: '<h1>首页</h1>', defaultStateName: '有数据', states: [{ id: 'empty', name: '无数据', html: '<p>暂无记录</p>' }] },
        { ...first.document.pages[0]!, id: 'parking', name: '停车记录', groupId: group.id, html: '<h1>停车记录</h1>' },
      ],
      entryPageId: 'home',
    }
    const candidate = await service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, jobId: job.id, draft, summary: '按规划生成' })
    expect(candidate.status).toBe('ready')
    expect((await service.invoke('load', { sessionId, prototypeId: first.document.id })).jobs.find(value => value.id === job.id)?.plan).toEqual(plan)
  })

  it('Given 已冻结页面规划 When 候选新增未规划页面 Then 宿主拒绝越过规划边界', async () => {
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '车本本', platform: 'mobile' })
    const group = first.document.groups[0]!
    const plan = { ...restorePlan(), groups: [group], pages: restorePlan().pages.map(page => ({ ...page, groupId: group.id })) }
    const job = await service.invoke('beginJob', { sessionId, prototypeId: first.document.id, baseRevision: 1, instruction: '根据现有项目拆分多页面', mode: 'project-restore', plan })
    const draft = {
      ...first.document,
      pages: [
        { ...first.document.pages[0]!, id: 'home', name: '首页', groupId: group.id, html: '<h1>首页</h1>' },
        { ...first.document.pages[0]!, id: 'parking', name: '停车记录', groupId: group.id, html: '<h1>停车记录</h1>' },
        { ...first.document.pages[0]!, id: 'settings', name: '设置', groupId: group.id, html: '<h1>设置</h1>' },
      ],
      entryPageId: 'home',
    }
    await expect(service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, jobId: job.id, draft, summary: '越过规划' })).rejects.toThrow('未规划页面')
  })

  it('Given 空项目 When 从页面入口创建 Then 一次生成隐藏空间和用户命名页面', async () => {
    /** 隔离服务。 */
    const { service } = setup()
    const snapshot = await service.invoke('create', { sessionId, name: '欢迎页', pageName: '欢迎页', platform: 'mobile' })
    expect(snapshot.document.name).toBe('交互设计')
    expect(snapshot.document.pages).toHaveLength(1)
    expect(snapshot.document.pages[0]!.name).toBe('欢迎页')
    expect(snapshot.document.entryPageId).toBe(snapshot.document.pages[0]!.id)
  })

  it('Given 项目还原任务 When 候选包含导览页和完整 App 单页 Then 宿主拒绝伪拆分', async () => {
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '车本本', platform: 'mobile' })
    const job = await service.invoke('beginJob', {
      sessionId, prototypeId: first.document.id, baseRevision: 1,
      instruction: '根据现有项目拆分多路由 App', mode: 'project-restore',
      plan: restorePlan(),
    })
    const pseudoSplit = {
      ...first.document,
      pages: [
        { ...first.document.pages[0]!, id: 'guide', name: '首页导航', html: '<h1>页面清单</h1>' },
        { ...first.document.pages[0]!, id: 'full-app', name: '车本本-App交互原型.html', source: { path: '车本本-App交互原型.html', hash: 'a'.repeat(64), kind: 'html' as const }, html: '<nav>首页 记一笔 停车记录 找车 车辆管理 我的</nav>' },
      ],
      entryPageId: 'guide',
    }
    await expect(service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, jobId: job.id, draft: pseudoSplit, summary: '伪拆分' })).rejects.toThrow('页面拆分')
  })

  it('Given 项目还原任务 When 只有一个页面覆盖多个页面清单 Then 宿主拒绝不完整候选', async () => {
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '车本本', platform: 'mobile' })
    const job = await service.invoke('beginJob', {
      sessionId, prototypeId: first.document.id, baseRevision: 1,
      instruction: '根据现有项目拆分多页面', mode: 'project-restore',
      plan: restorePlan(),
    })
    const incomplete = { ...first.document, pages: [{ ...first.document.pages[0]!, id: 'home', name: '首页', html: '<h1>首页、停车记录</h1>' }], entryPageId: 'home' }
    await expect(service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, jobId: job.id, draft: incomplete, summary: '缺页' })).rejects.toThrow('页面拆分')
  })

  it('Given 项目还原任务 When 调用整页 HTML 导入 Then 宿主拒绝绕过页面清单', async () => {
    const { root, service } = setup()
    writeFileSync(join(root, 'standalone.html'), '<h1>独立页面</h1>')
    const first = await service.invoke('create', { sessionId, name: '车本本', platform: 'mobile' })
    const job = await service.invoke('beginJob', {
      sessionId, prototypeId: first.document.id, baseRevision: 1,
      instruction: '根据现有项目拆分多页面', mode: 'project-restore',
      plan: restorePlan(),
    })
    await expect(service.invoke('importHtml', { sessionId, prototypeId: first.document.id, baseRevision: 1, relativePath: 'standalone.html', jobId: job.id })).rejects.toThrow('页面拆分')
  })
  it('Given 项目已有交互模块 When 再次创建 Then 拒绝创建第二个模块', async () => {
    const { service } = setup()
    await service.invoke('create', { sessionId, name: '唯一模块', platform: 'mobile' })
    await expect(service.invoke('create', { sessionId, name: '重复模块', platform: 'desktop' })).rejects.toThrow('已存在')
  })
  it('Given 项目残留多个历史模块 When 列出交互模块 Then 合并为最新模块且页面跳转与合并标记只写一次', async () => {
    /** 项目先创建正式模块，再复制一份合法旧目录模拟升级前数据。 */
    const { root, service } = setup()
    const first = await service.invoke('create', { sessionId, name: '缓存与空间', platform: 'mobile' })
    clonePrototype(root, first.document, 'legacy', '旧模块', '<button data-prototype-page="home">返回旧首页</button>')
    /** 正式模块增加一页，使其更新时间和页面内容都成为合并后的基准。 */
    const canonical = await service.invoke('save', {
      sessionId, prototypeId: first.document.id, baseRevision: 1,
      draft: { ...first.document, pages: [...first.document.pages, { id: 'detail', groupId: 'main', name: '缓存页', html: '<h1>缓存页</h1>' }] },
      summary: '增加缓存页',
    })
    const summaries = await service.invoke('list', { sessionId })
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({ id: first.document.id, pageCount: 3, revision: 3 })
    const merged = await service.invoke('load', { sessionId, prototypeId: first.document.id })
    expect(merged.document.pages.map(page => page.name)).toEqual(expect.arrayContaining(['首页', '缓存页', '旧模块']))
    const legacyPage = merged.document.pages.find(page => page.name === '旧模块')!
    expect(legacyPage.id).not.toBe('home')
    expect(legacyPage.html).toContain(`data-prototype-page="${legacyPage.id}"`)
    /** 第二次列表读取只复用 canonical，不再生成 v4 或重复追加页面。 */
    expect(await service.invoke('list', { sessionId })).toEqual(summaries)
    expect((await service.invoke('load', { sessionId, prototypeId: first.document.id })).document.revision).toBe(3)
    const marker = JSON.parse(readFileSync(join(root, '.dutydeck', 'interaction-design', 'consolidation.json'), 'utf8')) as { canonicalId: string; sourceIds: string[] }
    expect(marker).toMatchObject({ canonicalId: first.document.id, sourceIds: expect.arrayContaining([first.document.id, 'legacy']) })
    expect(readdirSync(join(root, '.dutydeck', 'interaction-design', 'prototypes', first.document.id, 'revisions')).sort()).toEqual(['1.json', '2.json', '3.json'])
    expect(canonical.document.pages).toHaveLength(2)
  })
  it('Given 新项目 When 创建、保存及恢复 Then 只切换当前版本且保留后续历史', async () => {
    /** 隔离服务。 */
    const { root, service } = setup()
    /** 初始快照。 */
    const first = await service.invoke('create', { sessionId, name: '测试原型', platform: 'mobile' })
    /** 完整编辑内容。 */
    const draft = { ...first.document, name: '修改名称' }
    /** 新版本。 */
    const saved = await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft, summary: '改名' })
    expect(saved.document.revision).toBe(2)
    expect((await service.invoke('getVersion', { sessionId, prototypeId: first.document.id, revision: 1 })).name).toBe('测试原型')
    /** 恢复前记录不可变版本文件，恢复只能改 head 指针。 */
    const revisionsDirectory = join(root, '.dutydeck', 'interaction-design', 'prototypes', first.document.id, 'revisions')
    const beforeRestore = readdirSync(revisionsDirectory).sort().map(name => [name, readFileSync(join(revisionsDirectory, name))] as const)
    /** 历史恢复。 */
    const restored = await service.invoke('restore', { sessionId, prototypeId: first.document.id, baseRevision: 2, revision: 1 })
    expect(restored.document.revision).toBe(1)
    expect(restored.document.name).toBe('测试原型')
    expect(restored.versions).toHaveLength(2)
    expect(restored.versions.map(version => version.revision)).toEqual([2, 1])
    expect(readdirSync(revisionsDirectory).sort().map(name => [name, readFileSync(join(revisionsDirectory, name))] as const)).toEqual(beforeRestore)
    expect((await service.invoke('getVersion', { sessionId, prototypeId: first.document.id, revision: 2 })).name).toBe('修改名称')
    /** 从恢复后的旧版本继续保存，必须分配历史最高版本之后的新编号。 */
    const continued = await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: restored.document, summary: '从旧版本继续' })
    expect(continued.document.revision).toBe(3)
    expect(continued.versions.map(version => version.revision)).toEqual([3, 2, 1])
  })
  it('Given 当前版本与历史版本 When 删除历史 Then 只移除目标记录且保留版本高水位', async () => {
    /** 隔离项目目录与服务。 */
    const { root, service } = setup()
    /** 初始版本，用作历史基线。 */
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    /** 第二版，作为中间历史删除目标。 */
    const second = await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: { ...first.document, name: '第二版' }, summary: '第二版' })
    /** 当前第三版，必须保留。 */
    const third = await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 2, draft: { ...second.document, name: '第三版' }, summary: '第三版' })
    /** 临时项目版本目录，用于核对实际文件删除。 */
    const revisionsDirectory = join(root, '.dutydeck', 'interaction-design', 'prototypes', first.document.id, 'revisions')
    await expect(service.invoke('deleteVersion', { sessionId, prototypeId: first.document.id, baseRevision: 2, revision: 1 })).rejects.toThrow('版本已变化')
    await expect(service.invoke('deleteVersion', { sessionId, prototypeId: first.document.id, baseRevision: 3, revision: 9 })).rejects.toThrow('版本不存在')
    /** 删除中间历史后的权威快照。 */
    const deleted = await service.invoke('deleteVersion', { sessionId, prototypeId: first.document.id, baseRevision: 3, revision: 2 })
    expect(deleted.document.revision).toBe(3)
    expect(deleted.versions.map(version => version.revision)).toEqual([3, 1])
    expect(readdirSync(revisionsDirectory).sort()).toEqual(['1.json', '3.json'])
    await expect(service.invoke('getVersion', { sessionId, prototypeId: first.document.id, revision: 2 })).rejects.toThrow('版本不存在')
    await expect(service.invoke('deleteVersion', { sessionId, prototypeId: first.document.id, baseRevision: 3, revision: 2 })).rejects.toThrow('版本不存在')
    await expect(service.invoke('deleteVersion', { sessionId, prototypeId: first.document.id, baseRevision: 3, revision: 3 })).rejects.toThrow('当前版本不能删除')
    /** 删除后继续保存的新版本。 */
    const continued = await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 3, draft: { ...third.document, name: '第四版' }, summary: '第四版' })
    expect(continued.document.revision).toBe(4)
    expect(continued.versions.map(version => version.revision)).toEqual([4, 3, 1])
    /** 恢复到旧版本后的快照。 */
    const restored = await service.invoke('restore', { sessionId, prototypeId: first.document.id, baseRevision: 4, revision: 1 })
    /** 恢复只切换指针，仍存在的较高历史版本可以提交过期候选。 */
    const historicalCandidate = await service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 4, draft: continued.document, summary: '历史基线候选' })
    expect(historicalCandidate.status).toBe('stale')
    /** 删除历史最高版本后的快照。 */
    const deletedHighest = await service.invoke('deleteVersion', { sessionId, prototypeId: first.document.id, baseRevision: 1, revision: 4 })
    expect(restored.document.revision).toBe(1)
    expect(deletedHighest.document.revision).toBe(1)
    expect(deletedHighest.versions.map(version => version.revision)).toEqual([3, 1])
    /** 验证历史最高编号删除后仍不复用的后续版本。 */
    const afterHighestDelete = await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: restored.document, summary: '第五版' })
    expect(afterHighestDelete.document.revision).toBe(5)
  })
  it('Given 开发交接引用历史版本 When 删除 Then 拒绝并保留交接基线', async () => {
    /** 隔离服务及固定交接基线。 */
    const { service } = setup()
    /** 初始版本，用作历史基线。 */
    const first = await service.invoke('create', { sessionId, name: '交接基线', platform: 'mobile' })
    await service.invoke('createHandoff', { sessionId, prototypeId: first.document.id, revision: 1 })
    await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '后续版本' })
    await expect(service.invoke('deleteVersion', { sessionId, prototypeId: first.document.id, baseRevision: 2, revision: 1 })).rejects.toThrow('已用于开发交接')
    expect((await service.invoke('getVersion', { sessionId, prototypeId: first.document.id, revision: 1 })).revision).toBe(1)
  })
  it('Given 运行任务引用历史版本 When 删除及取消后删除 Then 保护运行任务且拒绝已删基线的新候选', async () => {
    /** 隔离服务与运行中的整模块任务。 */
    const { service } = setup()
    /** 初始版本，用作历史基线。 */
    const first = await service.invoke('create', { sessionId, name: '任务基线', platform: 'mobile' })
    /** 引用旧基线的运行任务。 */
    const job = await service.invoke('beginJob', { sessionId, prototypeId: first.document.id, baseRevision: 1, instruction: '生成页面' })
    /** 删除前已保存的候选仍有完整独立正文。 */
    const candidate = await service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '已有候选' })
    await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '后续版本' })
    await expect(service.invoke('deleteVersion', { sessionId, prototypeId: first.document.id, baseRevision: 2, revision: 1 })).rejects.toThrow('运行中的生成任务')
    await service.invoke('cancelJob', { sessionId, prototypeId: first.document.id, jobId: job.id })
    await service.invoke('deleteVersion', { sessionId, prototypeId: first.document.id, baseRevision: 2, revision: 1 })
    await expect(service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '无效基线' })).rejects.toThrow('版本不存在')
    await expect(service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, jobId: job.id, draft: first.document, summary: '迟到回填' })).rejects.toThrow('版本不存在')
    /** 旧候选保留可读但不可直接采纳的事实。 */
    const preserved = await service.invoke('getCandidate', { sessionId, prototypeId: first.document.id, candidateId: candidate.id })
    expect(preserved.status).toBe('stale')
    expect(preserved.draft.pages).toEqual(first.document.pages)
  })
  it('Given 已采纳候选与离线导出 When 删除旧版本 Then 保留采纳幂等与导出正文', async () => {
    /** 隔离服务、采纳版本和独立导出。 */
    const { service } = setup()
    /** 初始版本，用作历史基线。 */
    const first = await service.invoke('create', { sessionId, name: '独立记录', platform: 'mobile' })
    /** 独立保存正文的候选记录。 */
    const candidate = await service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '采纳候选' })
    await service.invoke('adopt', { sessionId, prototypeId: first.document.id, baseRevision: 1, candidateId: candidate.id })
    /** 已导出的离线页面内容。 */
    const delivery = await service.invoke('exportHtml', { sessionId, prototypeId: first.document.id, revision: 2 })
    await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 2, draft: first.document, summary: '后续版本' })
    await service.invoke('deleteVersion', { sessionId, prototypeId: first.document.id, baseRevision: 3, revision: 2 })
    expect(delivery.html).toContain('在主会话描述这个页面的内容和交互。')
    expect((await service.invoke('getCandidate', { sessionId, prototypeId: first.document.id, candidateId: candidate.id })).adoptedRevision).toBe(2)
    expect((await service.invoke('adopt', { sessionId, prototypeId: first.document.id, baseRevision: 1, candidateId: candidate.id })).document.revision).toBe(3)
  })
  it('Given 交接记录被替换为符号链接 When 删除历史版本 Then 拒绝跳过无法验证的引用', async () => {
    /** 隔离项目与交接记录。 */
    const { root, service } = setup()
    /** 初始版本，用作历史基线。 */
    const first = await service.invoke('create', { sessionId, name: '受保护引用', platform: 'mobile' })
    /** 固定版本的开发交接记录。 */
    const handoff = await service.invoke('createHandoff', { sessionId, prototypeId: first.document.id, revision: 1 })
    await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '后续版本' })
    /** 仅在测试临时根内替换为链接，以验证 no-follow 边界。 */
    const path = join(root, '.dutydeck', 'interaction-design', 'prototypes', first.document.id, 'deliveries', `${handoff.id}.handoff.json`)
    /** 测试根内的交接副本，作为符号链接目标。 */
    const target = join(root, 'handoff-copy.json')
    writeFileSync(target, readFileSync(path))
    rmSync(path)
    symlinkSync(target, path)
    await expect(service.invoke('deleteVersion', { sessionId, prototypeId: first.document.id, baseRevision: 2, revision: 1 })).rejects.toThrow()
    expect((await service.invoke('getVersion', { sessionId, prototypeId: first.document.id, revision: 1 })).revision).toBe(1)
  })
  it('Given 固定版本 When 生成开发交接包 Then 带上视口、元素身份、流程和视觉 tokens 且不带本机路径', async () => {
    const { root, service } = setup()
    const first = await service.invoke('create', { sessionId, name: '交接原型', platform: 'desktop' })
    const draft = { ...first.document, groups: [{ id: 'root', name: '产品' }, { id: 'account', name: '账号', parentId: 'root' }], pages: [{ ...first.document.pages[0]!, groupId: 'account', name: '登录', html: '<style>:root{--brand:#123456;--gap:16px}</style><button data-prototype-element="submit">进入</button>' }, { id: 'dashboard', groupId: 'root', name: '首页', html: '<h1 data-prototype-element="title">首页</h1>' }], entryPageId: first.document.pages[0]!.id, flows: [{ id: 'to-home', fromPageId: first.document.pages[0]!.id, elementId: 'submit', targetPageId: 'dashboard' }] }
    await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft, summary: '准备开发交接' })
    const handoff = await service.invoke('createHandoff', { sessionId, prototypeId: first.document.id, revision: 2 })
    expect(handoff.revision).toBe(2)
    expect(handoff.visualContract.viewport).toEqual({ width: 1280, height: 800 })
    expect(handoff.groups.find(group => group.id === 'account')?.path).toBe('产品 / 账号')
    expect(handoff.pages.find(page => page.name === '登录')?.elementIds).toEqual(['submit'])
    expect(handoff.pages.find(page => page.name === '登录')?.flowIds).toEqual(['to-home'])
    expect(handoff.designTokens).toEqual({ '--brand': '#123456', '--gap': '16px' })
    expect(handoff.manifestHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(handoff)).not.toContain(root)
    const deliveryRoot = join(root, '.dutydeck', 'interaction-design', 'prototypes', first.document.id, 'deliveries')
    expect(readdirSync(deliveryRoot).some(name => name.endsWith('.handoff.json'))).toBe(true)
  })
  it('Given 相同基线 When 两次保存 Then 旧写入不能覆盖当前稿', async () => {
    /** 隔离服务及原型。 */
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'desktop' })
    const request = { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '保存' }
    await service.invoke('save', request)
    await expect(service.invoke('save', request)).rejects.toThrow('版本已变化')
  })
  it('Given 候选生成后手动保存 When 采纳旧候选 Then 提示过期并保留用户版本', async () => {
    /** 隔离服务与初始稿。 */
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const request = { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '生成候选' }
    const candidate = await service.invoke('propose', request)
    expect((await service.invoke('load', { sessionId, prototypeId: first.document.id })).document.revision).toBe(1)
    await service.invoke('save', request)
    await expect(service.invoke('adopt', { ...request, candidateId: candidate.id })).rejects.toThrow('过期')
    expect((await service.invoke('getCandidate', { ...request, candidateId: candidate.id })).status).toBe('stale')
  })
  it('Given 候选基于旧版本 When 恢复该版本 Then 候选重新可采纳且恢复本身不新增版本', async () => {
    /** 隔离服务与初始稿。 */
    const { root, service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const request = { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '候选' }
    const candidate = await service.invoke('propose', request)
    await service.invoke('save', request)
    const revisionsDirectory = join(root, '.dutydeck', 'interaction-design', 'prototypes', first.document.id, 'revisions')
    expect(readdirSync(revisionsDirectory).sort()).toEqual(['1.json', '2.json'])
    const restored = await service.invoke('restore', { sessionId, prototypeId: first.document.id, baseRevision: 2, revision: 1 })
    expect(restored.document.revision).toBe(1)
    expect(restored.candidates.find(item => item.id === candidate.id)?.status).toBe('ready')
    expect(readdirSync(revisionsDirectory).sort()).toEqual(['1.json', '2.json'])
  })
  it('Given 可采纳候选 When 重复采纳 Then 只产生一个新版本', async () => {
    /** 隔离服务和候选。 */
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const request = { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '候选' }
    const candidate = await service.invoke('propose', request)
    const adoption = { sessionId, prototypeId: first.document.id, baseRevision: 1, candidateId: candidate.id }
    await service.invoke('adopt', adoption)
    expect((await service.invoke('adopt', adoption)).document.revision).toBe(2)
  })
  it('Given 取消任务 When 迟到候选提交 Then 拒绝回填', async () => {
    /** 隔离任务。 */
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const job = await service.invoke('beginJob', { sessionId, prototypeId: first.document.id, baseRevision: 1, instruction: '修改' })
    await service.invoke('cancelJob', { sessionId, prototypeId: first.document.id, jobId: job.id })
    await expect(service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '迟到', jobId: job.id })).rejects.toThrow('任务已结束')
  })
  it('Given 内容对象被修改 When 读取历史 Then 明确拒绝损坏正文', async () => {
    /** 隔离项目与正式文件。 */
    const { root, service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const contents = join(root, '.dutydeck', 'interaction-design', 'prototypes', first.document.id, 'contents')
    writeFileSync(join(contents, readdirSync(contents)[0]!), JSON.stringify({ html: 'tampered' }))
    await expect(service.invoke('load', { sessionId, prototypeId: first.document.id })).rejects.toThrow('损坏')
  })
})

describe('图片与授权来源', () => {
  it('Given 页面参考图 When 读取固定版本 Then 返回用途与资产哈希且历史不被新版本覆盖', async () => {
    /** 隔离项目与一张可登记图片。 */
    const { root, service } = setup()
    /** 1×1 PNG 只用于验证资产身份与读取链路。 */
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6n8AAAAASUVORK5CYII=', 'base64')
    writeFileSync(join(root, 'reference.png'), png)
    const first = await service.invoke('create', { sessionId, name: '参考图原型', platform: 'mobile' })
    const asset = await service.invoke('importAsset', { sessionId, prototypeId: first.document.id, relativePath: 'reference.png' })
    const pageId = first.document.pages[0]!.id
    const reference = { id: 'reference-1', assetId: asset.id, title: '首页结构', role: 'structure' as const, source: 'Figma', usages: [{ pageId }] }
    const second = await service.invoke('save', {
      sessionId,
      prototypeId: first.document.id,
      baseRevision: 1,
      draft: { ...first.document, references: [reference] },
      summary: '添加参考图',
    })
    const third = await service.invoke('save', {
      sessionId,
      prototypeId: second.document.id,
      baseRevision: 2,
      draft: { ...second.document, references: [{ ...reference, title: '首页视觉参考', role: 'visual' }] },
      summary: '更新参考图用途',
    })
    const revisionTwo = await service.invoke('readReferences', { sessionId, prototypeId: third.document.id, revision: 2, pageId })
    expect(revisionTwo).toHaveLength(1)
    expect(revisionTwo[0]).toMatchObject({ referenceId: 'reference-1', assetId: asset.id, role: 'structure', usages: [{ pageId }] })
    expect(revisionTwo[0]?.asset.hash).toBe(asset.hash)
    expect(revisionTwo[0]).not.toHaveProperty('dataUrl')
    const revisionThree = await service.invoke('readReferences', { sessionId, prototypeId: third.document.id, revision: 3 })
    expect(revisionThree[0]).toMatchObject({ title: '首页视觉参考', role: 'visual' })
  })

  it('Given 参考图指向不存在资产 When 保存 Then 拒绝失效资源引用', async () => {
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    await expect(service.invoke('save', {
      sessionId,
      prototypeId: first.document.id,
      baseRevision: 1,
      draft: {
        ...first.document,
        references: [{ id: 'reference-1', assetId: 'missing-asset', title: '结构', role: 'structure', usages: [{ pageId: first.document.pages[0]!.id }] }],
      },
      summary: '错误参考图',
    })).rejects.toThrow('素材')
  })

  it('Given 同一图片重复导入 When 源文件删除 Then 模块图片与历史仍可读取', async () => {
    /** 隔离图片。 */
    const { root, service } = setup()
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6n8AAAAASUVORK5CYII=', 'base64')
    writeFileSync(join(root, 'image.png'), png)
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const request = { sessionId, prototypeId: first.document.id, relativePath: 'image.png' }
    const a = await service.invoke('importAsset', request)
    const b = await service.invoke('importAsset', request)
    expect(a.id).toBe(b.id)
    rmSync(join(root, 'image.png'))
    expect((await service.invoke('assetContent', { sessionId, prototypeId: first.document.id, assetId: a.id })).dataUrl).toContain(png.toString('base64'))
    expect(readFileSync(join(root, '.dutydeck', 'interaction-design', 'assets', 'blobs', 'sha256', a.hash.slice(0, 2), `${a.hash}.png`))).toEqual(png)
  })
  it('Given 用户拖入图片字节 When 导入 Then 复制到资产库并复用相同内容身份', async () => {
    const { service } = setup()
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6n8AAAAASUVORK5CYII=', 'base64')
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const input = { sessionId, prototypeId: first.document.id, name: 'dragged.png', dataBase64: png.toString('base64') }
    const a = await service.invoke('importAssetData', input)
    const b = await service.invoke('importAssetData', input)
    expect(a.id).toBe(b.id)
    expect(a).toMatchObject({ name: 'dragged.png', mime: 'image/png', byteSize: png.length })
    expect((await service.invoke('assetContent', { sessionId, prototypeId: first.document.id, assetId: a.id })).dataUrl).toContain(png.toString('base64'))
  })
  it('Given 项目秘密和越界路径 When 读取来源 Then 拒绝且不返回正文', async () => {
    /** 隔离来源服务。 */
    const { root } = setup()
    const source = new InteractionSourceService(root)
    writeFileSync(join(root, '.env'), 'API_KEY=abcdefghijk')
    writeFileSync(join(root, 'settings.ts'), 'const api_key = "abcdefghijk"')
    await expect(source.read(['.env'])).rejects.toThrow('敏感')
    await expect(source.read(['../outside.ts'])).rejects.toThrow()
    await expect(source.read(['settings.ts'])).rejects.toThrow('敏感')
  })
  it('Given 正式根是符号链接 When 创建 Then 不在外部目录写入', async () => {
    /** 两个隔离项目。 */
    const { root, service } = setup()
    const outside = setup().root
    symlinkSync(outside, join(root, '.dutydeck'))
    await expect(service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })).rejects.toThrow('不安全')
    expect(readdirSync(outside)).toEqual([])
  })
  it('Given 来源 symlink When 读取 Then 拒绝跟随', async () => {
    /** 独立来源与链接。 */
    const { root } = setup()
    writeFileSync(join(root, 'source.ts'), 'hello')
    symlinkSync(join(root, 'source.ts'), join(root, 'link.ts'))
    await expect(new InteractionSourceService(root).read(['link.ts'])).rejects.toThrow()
  })
  it('Given HTML 和相对 CSS/JS/图片 When 导入 Then 生成可采纳候选而不覆盖当前版本', async () => {
    /** 完整本地依赖闭包。 */
    const { root, service } = setup()
    writeFileSync(join(root, 'page.html'), '<html><head><link href="theme.css" rel="stylesheet"></head><body><img src="image.png"><script src="app.js"></script></body></html>')
    writeFileSync(join(root, 'theme.css'), 'body {color:red}')
    writeFileSync(join(root, 'app.js'), 'document.body.dataset.loaded="yes"')
    writeFileSync(join(root, 'image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6n8AAAAASUVORK5CYII=', 'base64'))
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'desktop' })
    const imported = await service.invoke('importHtml', { sessionId, prototypeId: first.document.id, baseRevision: 1, relativePath: 'page.html' })
    const candidate = await service.invoke('getCandidate', { sessionId, prototypeId: first.document.id, candidateId: imported.id })
    expect(candidate.draft.pages[1]!.html).toContain('prototype-asset:')
    expect(candidate.draft.pages[1]!.html).toContain('<style>body {color:red}</style>')
    expect(candidate.draft.pages[1]!.source?.hash).toBe(interactionHash(readFileSync(join(root, 'page.html'))))
    expect((await service.invoke('load', { sessionId, prototypeId: first.document.id })).document.revision).toBe(1)
  })
})

describe('交付、预算与任务范围', () => {
  it('Given 无模块项目 When 执行只读列表和扫描 Then 不创建正式目录', async () => {
    /** 原始空项目。 */
    const { root, service } = setup()
    expect(await service.invoke('list', { sessionId })).toEqual([])
    expect((await service.invoke('inspectProject', { sessionId })).files).toEqual([])
    expect(readdirSync(root)).toEqual([])
  })
  it('Given 页面级任务 When 候选修改名称或目录 Then 拒绝越过任务范围', async () => {
    /** 页面级生成任务。 */
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const job = await service.invoke('beginJob', { sessionId, prototypeId: first.document.id, baseRevision: 1, pageId: 'home', instruction: '根据源码还原首页页面' })
    await expect(service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, jobId: job.id, draft: { ...first.document, name: '越界改名' }, summary: '改名' })).rejects.toThrow('超出任务页面范围')
    await expect(service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, jobId: job.id, draft: { ...first.document, pages: [...first.document.pages, { ...first.document.pages[0]!, id: 'settings', name: '设置' }] }, summary: '越界新增页面' })).rejects.toThrow('超出任务页面范围')
    await expect(service.invoke('beginJob', { sessionId, prototypeId: first.document.id, baseRevision: 1, pageId: 'missing', instruction: '修改' })).rejects.toThrow('页面不存在')
    expect((await service.invoke('beginJob', { sessionId, prototypeId: first.document.id, baseRevision: 1, pageId: 'home', elementId: 'title', instruction: '修改' })).message).toContain('所属页面')
    await expect(service.invoke('beginJob', { sessionId, prototypeId: first.document.id, baseRevision: 1, pageId: 'home', elementId: 'missing', instruction: '修改' })).rejects.toThrow('元素')
  })
  it('Given 异步图片读取期间授权撤回 When 准备提交 Then 不写入图片或新版本', async () => {
    /** 可切换的测试授权。 */
    let authorized = true
    /** 验证整个异步准备期间持有 lease。 */
    let leased = false
    /** 初始项目根。 */
    const { root } = setup()
    writeFileSync(join(root, 'image.png'), 'placeholder')
    const service = new InteractionDesignService({ workspaceId: 'workspace', projectRoot: root,
      assertCurrent: () => { if (!authorized) throw new Error('授权已撤回') },
      withWriteLease: async effect => { leased = true; try { return await effect() } finally { leased = false } },
      readSourceFile: async () => { expect(leased).toBe(true); authorized = false; return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6n8AAAAASUVORK5CYII=', 'base64') },
    })
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    await expect(service.invoke('importAsset', { sessionId, prototypeId: first.document.id, relativePath: 'image.png' })).rejects.toThrow('授权已撤回')
    expect(readdirSync(join(root, '.dutydeck', 'interaction-design'))).not.toContain('assets')
  })
  it('Given 超预算源码 When 有界读取 Then 明确失败而不返回残缺正文', async () => {
    /** 大型来源。 */
    const { root } = setup()
    writeFileSync(join(root, 'large.ts'), 'a'.repeat(512 * 1024 + 1))
    await expect(new InteractionSourceService(root).read(['large.ts'])).rejects.toThrow('预算')
  })
  it('Given 已导入页面和图片 When 采纳并导出固定历史版本 Then 图片内嵌且不混入后续修改', async () => {
    /** 含图片的静态页面。 */
    const { root, service } = setup()
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6n8AAAAASUVORK5CYII=', 'base64')
    writeFileSync(join(root, 'image.png'), png)
    writeFileSync(join(root, 'page.html'), '<html><body><img src="image.png"></body></html>')
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const candidate = await service.invoke('importHtml', { sessionId, prototypeId: first.document.id, baseRevision: 1, relativePath: 'page.html' })
    const adopted = await service.invoke('adopt', { sessionId, prototypeId: first.document.id, baseRevision: 1, candidateId: candidate.id })
    expect(adopted.document.pages).toHaveLength(2)
    await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 2, draft: { ...adopted.document, name: '后续改名' }, summary: '后续版本' })
    const exported = await service.invoke('exportHtml', { sessionId, prototypeId: first.document.id, revision: 2 })
    expect(exported.revision).toBe(2)
    expect(exported.html).toContain(png.toString('base64'))
    expect(exported.html).not.toContain('后续改名')
    expect(exported.html).not.toContain('prototype-asset:')
    expect((await service.invoke('validate', { sessionId, prototypeId: first.document.id, revision: 2 })).kind).toBe('structure')
  })
})

describe('来源闭包和内容身份', () => {
  it('Given CSS 相对 import 和无引号资源 When 导入 Then 样式与脚本内联并可离线使用', async () => {
    /** 静态页面依赖。 */
    const { root, service } = setup()
    writeFileSync(join(root, 'page.html'), '<link rel=stylesheet href=theme.css><script src=app.js></script>')
    writeFileSync(join(root, 'theme.css'), '@import "base.css"; body{color:red}')
    writeFileSync(join(root, 'base.css'), 'html{background:white}')
    writeFileSync(join(root, 'app.js'), 'document.body.dataset.ready="yes"')
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'desktop' })
    const candidate = await service.invoke('importHtml', { sessionId, prototypeId: first.document.id, baseRevision: 1, relativePath: 'page.html' })
    const loaded = await service.invoke('getCandidate', { sessionId, prototypeId: first.document.id, candidateId: candidate.id })
    expect(loaded.draft.pages[1]!.html).toContain('html{background:white}')
    expect(loaded.draft.pages[1]!.html).toContain('<script>document.body.dataset.ready="yes"</script>')
    expect(loaded.draft.pages[1]!.html).not.toContain('base.css')
  })
  it('Given 可信媒体返回不匹配字节 When 校验引用hash Then 拒绝保存素材', async () => {
    /** 已注册但返回错误内容的测试 reader。 */
    const { root } = setup()
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6n8AAAAASUVORK5CYII=', 'base64')
    const service = new InteractionDesignService({ workspaceId: 'workspace', projectRoot: root, readMediaAsset: async () => png })
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    await expect(service.invoke('importMediaAsset', { sessionId, prototypeId: first.document.id, assetId: 'media', revision: 1, hash: 'a'.repeat(64) })).rejects.toThrow('hash 不匹配')
    expect((await service.invoke('load', { sessionId, prototypeId: first.document.id })).assets).toEqual([])
  })
  it('Given 原型元数据被改写 When 读取版本 Then hash校验拒绝伪造记录', async () => {
    /** 已提交版本元数据。 */
    const { root, service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const path = join(root, '.dutydeck', 'interaction-design', 'prototypes', first.document.id, 'revisions', '1.json')
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { document: { name: string } }
    stored.document.name = '被修改'
    writeFileSync(path, JSON.stringify(stored))
    await expect(service.invoke('getVersion', { sessionId, prototypeId: first.document.id, revision: 1 })).rejects.toThrow('版本内容身份')
  })
})

describe('崩溃残留与采纳二次校验', () => {
  it('Given 未发布的残缺版本 When 加载与下次保存 Then 当前head可读且残留不进入历史', async () => {
    /** 当前有效原型与未提交版本位置。 */
    const { root, service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const revisions = join(root, '.dutydeck', 'interaction-design', 'prototypes', first.document.id, 'revisions')
    writeFileSync(join(revisions, '2.json'), '{broken')
    expect((await service.invoke('load', { sessionId, prototypeId: first.document.id })).document.revision).toBe(1)
    const saved = await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '重试提交' })
    expect(saved.document.revision).toBe(2)
    expect(saved.versions).toHaveLength(2)
  })
  it('Given 内容hash路径存在损坏残留 When 新版本试图复用 Then 不推进head', async () => {
    /** 将新内容的目标对象预置为残缺 JSON。 */
    const { root, service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const html = '<h1>新页面正文</h1>'
    const path = join(root, '.dutydeck', 'interaction-design', 'prototypes', first.document.id, 'contents', `${interactionHash(html)}.json`)
    writeFileSync(path, JSON.stringify({ html: '损坏残留' }))
    const draft = { ...first.document, pages: [{ ...first.document.pages[0]!, html }] }
    await expect(service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft, summary: '新正文' })).rejects.toThrow('内容对象损坏')
    expect((await service.invoke('load', { sessionId, prototypeId: first.document.id })).document.revision).toBe(1)
  })
  it('Given 候选落盘后正文改变 When 采纳 Then 拒绝并保留当前版本', async () => {
    /** 原候选内容及其落盘位置。 */
    const { root, service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const candidate = await service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '候选' })
    const path = join(root, '.dutydeck', 'interaction-design', 'prototypes', first.document.id, 'candidates', `${candidate.id}.json`)
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { draft: { name: string } }
    stored.draft.name = '变更后的候选'
    writeFileSync(path, JSON.stringify(stored))
    await expect(service.invoke('adopt', { sessionId, prototypeId: first.document.id, candidateId: candidate.id, baseRevision: 1 })).rejects.toThrow('候选正文身份')
    expect((await service.invoke('load', { sessionId, prototypeId: first.document.id })).document.revision).toBe(1)
  })
  it('Given 候选写完但任务终态未提交 When 采纳 Then 不把未完成结果发布', async () => {
    /** 模拟候选和任务终态之间的崩溃。 */
    const { root, service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const job = await service.invoke('beginJob', { sessionId, prototypeId: first.document.id, baseRevision: 1, instruction: '改稿' })
    const candidate = await service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '候选', jobId: job.id })
    const path = join(root, '.dutydeck', 'interaction-design', 'prototypes', first.document.id, 'jobs', `${job.id}.json`)
    writeFileSync(path, JSON.stringify(job))
    await expect(service.invoke('adopt', { sessionId, prototypeId: first.document.id, candidateId: candidate.id, baseRevision: 1 })).rejects.toThrow('尚未完成')
    expect((await service.invoke('load', { sessionId, prototypeId: first.document.id })).document.revision).toBe(1)
  })
  it('Given 图片blob残留已损坏且无metadata When 重新导入 Then 不发布损坏素材', async () => {
    /** 模拟 blob 已存在但 metadata 丢失。 */
    const { root, service } = setup()
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6n8AAAAASUVORK5CYII=', 'base64')
    writeFileSync(join(root, 'image.png'), png)
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const request = { sessionId, prototypeId: first.document.id, relativePath: 'image.png' }
    const asset = await service.invoke('importAsset', request)
    const directory = join(root, '.dutydeck', 'interaction-design', 'assets')
    rmSync(join(directory, `${asset.id}.json`))
    writeFileSync(join(directory, 'blobs', 'sha256', asset.hash.slice(0, 2), `${asset.hash}.png`), 'corrupted')
    await expect(service.invoke('importAsset', request)).rejects.toThrow('图片内容对象损坏')
    expect((await service.invoke('load', { sessionId, prototypeId: first.document.id })).assets).toEqual([])
  })
  it('Given 他人会话任务 When 取消或回填 Then 拒绝跨会话改变任务', async () => {
    /** 已绑定会话的任务。 */
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
    const job = await service.invoke('beginJob', { sessionId, prototypeId: first.document.id, baseRevision: 1, instruction: '改稿' })
    await expect(service.invoke('cancelJob', { sessionId: 'other-session', prototypeId: first.document.id, jobId: job.id })).rejects.toThrow('会话不匹配')
    await expect(service.invoke('failJob', { sessionId: 'other-session', prototypeId: first.document.id, jobId: job.id, message: '失败' })).rejects.toThrow('会话不匹配')
    await expect(service.invoke('propose', { sessionId: 'other-session', prototypeId: first.document.id, jobId: job.id, baseRevision: 1, draft: first.document, summary: '回填' })).rejects.toThrow('归属不匹配')
  })
})

it('Given 放弃候选 When 重读与列表展示 Then 校验hash保留但不暴露给调用方', async () => {
  /** 含存储校验字段的候选。 */
  const { root, service } = setup()
  const first = await service.invoke('create', { sessionId, name: '原型', platform: 'mobile' })
  const candidate = await service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: first.document, summary: '候选' })
  await service.invoke('discardCandidate', { sessionId, prototypeId: first.document.id, candidateId: candidate.id })
  const reloaded = await service.invoke('getCandidate', { sessionId, prototypeId: first.document.id, candidateId: candidate.id })
  const snapshot = await service.invoke('load', { sessionId, prototypeId: first.document.id })
  expect(reloaded.status).toBe('discarded')
  expect('draftHash' in reloaded).toBe(false)
  expect('draftHash' in snapshot.candidates[0]!).toBe(false)
  const directory = join(root, '.dutydeck', 'interaction-design', 'prototypes', first.document.id, 'candidates')
  expect(JSON.parse(readFileSync(join(directory, `${candidate.id}.json`), 'utf8')).draftHash).toBeTruthy()
  expect(JSON.parse(readFileSync(join(directory, `${candidate.id}.summary.json`), 'utf8')).draftHash).toBeUndefined()
})

it('Given 唯一项目模块包含大页面且正文损坏 When list Then 仅读摘要而load仍拒绝损坏正文', async () => {
  /** 单模块、大正文的隔离项目。 */
  const { root, service } = setup()
  /** 保存两份接近单页上限的正文。 */
  const first = await service.invoke('create', { sessionId, name: '唯一模块', platform: 'mobile' })
  const draft = { ...first.document, pages: [
    { ...first.document.pages[0]!, html: `<main>${'a'.repeat(400_000)}</main>` },
    { id: 'second', groupId: 'main', name: '第二页', html: `<main>${'b'.repeat(400_000)}</main>` },
  ] }
  await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft, summary: '大页面' })
  /** 删除全部内容文件，任何正文读取都会失败。 */
  const contents = join(root, '.dutydeck', 'interaction-design', 'prototypes', first.document.id, 'contents')
  for (const file of readdirSync(contents)) rmSync(join(contents, file))
  await expect(service.invoke('load', { sessionId, prototypeId: first.document.id })).rejects.toThrow()
  /** 摘要可以展示，但不宣称已经验证正文完整性。 */
  const summaries = await service.invoke('list', { sessionId })
  expect(summaries).toHaveLength(1)
  expect(summaries[0]).toMatchObject({ pageCount: 2, revision: 2, name: '唯一模块' })
})

it('Given 版本元数据累计超预算 When list Then 明确拒绝无界摘要读取', async () => {
  /** 累计元数据预算的隔离项目。 */
  const { root, service } = setup()
  /** 单模块元数据超过列表预算。 */
  const first = await service.invoke('create', { sessionId, name: '唯一模块', platform: 'mobile' })
  const path = join(root, '.dutydeck', 'interaction-design', 'prototypes', first.document.id, 'revisions', '1.json')
  const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  stored.padding = 'x'.repeat(9 * 1024 * 1024)
  writeFileSync(path, JSON.stringify(stored))
  await expect(service.invoke('list', { sessionId })).rejects.toThrow('预算')
})


describe('页面状态持久化', () => {
  it('Given 旧版本与多状态候选 When 采纳再恢复 Then 保留不可变历史并独立去重状态正文', async () => {
    /** 隔离服务与首个旧格式版本。 */
    const { root, service } = setup()
    const first = await service.invoke('create', { sessionId, name: '状态测试', platform: 'mobile' })
    const prototypeId = first.document.id
    const directory = join(root, '.dutydeck', 'interaction-design', 'prototypes', prototypeId)
    const oldBytes = readFileSync(join(directory, 'revisions', '1.json'))
    /** 两个不同状态共享正文，验证内容寻址去重。 */
    const draft = { ...first.document, pages: first.document.pages.map(page => ({ ...page, defaultStateName: '有数据', states: [{ id: 'empty', name: '无数据', html: '<p>暂无记录</p>' }, { id: 'loading', name: '加载中', html: '<p>暂无记录</p>' }] })) }
    const candidate = await service.invoke('propose', { sessionId, prototypeId, baseRevision: 1, draft, summary: '补齐状态' })
    expect((await service.invoke('getCandidate', { sessionId, prototypeId, candidateId: candidate.id })).draft.pages).toEqual(draft.pages)
    const adopted = await service.invoke('adopt', { sessionId, prototypeId, candidateId: candidate.id, baseRevision: 1 })
    expect(withoutPageRevisions(adopted.document.pages)).toEqual(withoutPageRevisions(draft.pages))
    expect(readdirSync(join(directory, 'contents'))).toHaveLength(2)
    expect(readFileSync(join(directory, 'revisions', '2.json'), 'utf8')).not.toContain('<p>暂无记录</p>')
    const restored = await service.invoke('restore', { sessionId, prototypeId, baseRevision: 2, revision: 1 })
    expect(restored.document.pages[0]).not.toHaveProperty('states')
    expect(readFileSync(join(directory, 'revisions', '1.json'))).toEqual(oldBytes)
    expect(withoutPageRevisions((await service.invoke('getVersion', { sessionId, prototypeId, revision: 2 })).pages)).toEqual(withoutPageRevisions(draft.pages))
    /** 状态正文损坏不能静默回退默认正文。 */
    writeFileSync(join(directory, 'contents', `${interactionHash('<p>暂无记录</p>')}.json`), JSON.stringify({ html: '损坏' }))
    await expect(service.invoke('getVersion', { sessionId, prototypeId, revision: 2 })).rejects.toThrow('正文已损坏')
  })
  it('Given 状态候选被篡改 When 读取 Then 拒绝内容身份不匹配', async () => {
    /** 候选保存在隔离目录，模拟外部改写状态正文。 */
    const { root, service } = setup()
    const first = await service.invoke('create', { sessionId, name: '状态测试', platform: 'mobile' })
    const prototypeId = first.document.id
    const draft = { ...first.document, pages: first.document.pages.map(page => ({ ...page, states: [{ id: 'empty', name: '无数据', html: '<p>空</p>' }] })) }
    const candidate = await service.invoke('propose', { sessionId, prototypeId, baseRevision: 1, draft, summary: '状态' })
    const path = join(root, '.dutydeck', 'interaction-design', 'prototypes', prototypeId, 'candidates', `${candidate.id}.json`)
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { draft: typeof draft }
    stored.draft.pages[0]!.states[0]!.html = '<p>被替换</p>'
    writeFileSync(path, JSON.stringify(stored))
    await expect(service.invoke('getCandidate', { sessionId, prototypeId, candidateId: candidate.id })).rejects.toThrow('候选正文身份已损坏')
  })
  it('Given 附加状态引用缺失资源 When 提交 Then 拒绝无效候选', async () => {
    /** 隔离草稿带有仅在附加状态出现的资源。 */
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '状态测试', platform: 'mobile' })
    const draft = { ...first.document, pages: first.document.pages.map(page => ({ ...page, states: [{ id: 'empty', name: '无数据', html: '<img src="prototype-asset:missing">' }] })) }
    await expect(service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft, summary: '状态' })).rejects.toThrow('不存在的项目素材')
  })
  it('Given 页级任务 When 为当前页添加状态 Then 允许候选且其他页仍受保护', async () => {
    /** 页级任务只开放所属页面的全部视觉状态。 */
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '状态测试', platform: 'mobile' })
    const prototypeId = first.document.id
    const job = await service.invoke('beginJob', { sessionId, prototypeId, baseRevision: 1, instruction: '补充空状态', pageId: 'home' })
    const draft = { ...first.document, pages: first.document.pages.map(page => ({ ...page, defaultStateName: '有数据', states: [{ id: 'empty', name: '无数据', html: '<p data-prototype-element="retry">暂无记录</p>' }] })) }
    const candidate = await service.invoke('propose', { sessionId, prototypeId, baseRevision: 1, draft, summary: '状态', jobId: job.id })
    const adopted = await service.invoke('adopt', { sessionId, prototypeId, candidateId: candidate.id, baseRevision: 1 })
    expect(adopted.document.pages[0]!.states).toHaveLength(1)
    expect((await service.invoke('beginJob', { sessionId, prototypeId, baseRevision: 2, instruction: '修改重试', pageId: 'home', elementId: 'retry' })).status).toBe('running')
  })
})

describe('历史记录清理与候选页面提示', () => {
  it('Given 整稿候选只改一页 When 提交 Then 精确保存影响页面且旧摘要可以只读重算', async () => {
    /** 隔离服务和项目根。 */
    const { service, root } = setup()
    /** 本例初始正式文档。 */
    const first = await service.invoke('create', { sessionId, name: '历史', platform: 'mobile' })
    /** 固定会话和原型归属。 */
    const base = { sessionId, prototypeId: first.document.id }
    /** 可编辑的候选基线副本。 */
    const draft = parsePrototypeDraft(first.document)
    draft.pages.push({ ...draft.pages[0]!, id: 'second', name: '第二页' })
    await service.invoke('save', { ...base, baseRevision: 1, draft, summary: '两页' })
    draft.pages[1]!.html = '<p>仅第二页变更</p>'
    /** 本例提交的候选身份。 */
    const candidate = await service.invoke('propose', { ...base, baseRevision: 2, draft, summary: '局部更改' })
    expect(candidate.affectedPageIds).toEqual(['second'])
    /** 隔离项目的候选摘要文件。 */
    const path = join(root, '.dutydeck', 'interaction-design', 'prototypes', base.prototypeId, 'candidates', `${candidate.id}.summary.json`)
    /** 模拟旧版候选摘要。 */
    const summary = JSON.parse(readFileSync(path, 'utf8'))
    delete summary.affectedPageIds
    writeFileSync(path, JSON.stringify(summary))
    /** 读取前的文件字节，验证查询不落盘。 */
    const before = readFileSync(path, 'utf8')
    expect((await service.invoke('load', base)).candidates[0]!.affectedPageIds).toBeUndefined()
    expect(await service.invoke('getCandidateImpact', { ...base, candidateId: candidate.id })).toEqual({ pageIds: ['second'] })
    expect(readFileSync(path, 'utf8')).toBe(before)
    await service.invoke('save', { ...base, baseRevision: 2, draft, summary: '推进' })
    await service.invoke('deleteVersion', { ...base, baseRevision: 3, revision: 2 })
    expect(await service.invoke('getCandidateImpact', { ...base, candidateId: candidate.id })).toEqual({ pageIds: [draft.pages[0]!.id, 'second'], conservative: true })
  })

  it('Given 未采纳候选 When 删除并重开 Then 候选和任务不再出现且迟到操作被拒绝', async () => {
    /** 隔离服务和项目根。 */
    const { service, root } = setup()
    /** 本例初始正式文档。 */
    const first = await service.invoke('create', { sessionId, name: '历史', platform: 'mobile' })
    /** 固定会话和原型归属。 */
    const base = { sessionId, prototypeId: first.document.id }
    /** 本例生成任务及其固定范围。 */
    const job = await service.invoke('beginJob', { ...base, baseRevision: 1, instruction: '设计', mode: 'design' })
    /** 本例提交的候选身份。 */
    const candidate = await service.invoke('propose', { ...base, baseRevision: 1, draft: first.document, summary: '候选', jobId: job.id })
    await expect(service.invoke('deleteHistory', { ...base, baseRevision: 2, kind: 'candidate', recordId: candidate.id })).rejects.toThrow('版本已变化')
    await service.invoke('deleteHistory', { ...base, baseRevision: 1, kind: 'candidate', recordId: candidate.id })
    /** 模拟应用重新打开的服务实例。 */
    const reopened = new InteractionDesignService({ workspaceId: 'workspace', projectRoot: root })
    expect((await reopened.invoke('load', base)).candidates).toEqual([])
    expect((await reopened.invoke('load', base)).jobs).toEqual([])
    await expect(reopened.invoke('getCandidate', { ...base, candidateId: candidate.id })).rejects.toThrow('已删除')
    await expect(reopened.invoke('adopt', { ...base, baseRevision: 1, candidateId: candidate.id })).rejects.toThrow('已删除')
    await expect(reopened.invoke('discardCandidate', { ...base, candidateId: candidate.id })).rejects.toThrow('已删除')
    await expect(reopened.invoke('propose', { ...base, baseRevision: 1, draft: first.document, summary: '迟到', jobId: job.id })).rejects.toThrow('已删除')
  })

  it('Given 当前已采纳候选与运行任务 When 清理 Then 保护当前与运行任务并保留历史采纳事实', async () => {
    /** 隔离服务和项目根。 */
    const { service, root } = setup()
    /** 本例初始正式文档。 */
    const first = await service.invoke('create', { sessionId, name: '历史', platform: 'mobile' })
    /** 固定会话和原型归属。 */
    const base = { sessionId, prototypeId: first.document.id }
    /** 本例生成任务及其固定范围。 */
    const job = await service.invoke('beginJob', { ...base, baseRevision: 1, instruction: '设计', mode: 'design' })
    await expect(service.invoke('deleteHistory', { ...base, baseRevision: 1, kind: 'job', recordId: job.id })).rejects.toThrow('先取消')
    await service.invoke('cancelJob', { ...base, jobId: job.id })
    expect((await service.invoke('deleteHistory', { ...base, baseRevision: 1, kind: 'job', recordId: job.id })).jobs).toEqual([])
    /** 本例提交的候选身份。 */
    const candidate = await service.invoke('propose', { ...base, baseRevision: 1, draft: first.document, summary: '采纳' })
    await service.invoke('adopt', { ...base, baseRevision: 1, candidateId: candidate.id })
    expect((await service.invoke('adopt', { ...base, baseRevision: 1, candidateId: candidate.id })).document.revision).toBe(2)
    await expect(service.invoke('deleteHistory', { ...base, baseRevision: 2, kind: 'candidate', recordId: candidate.id })).rejects.toThrow('当前版本')
    await service.invoke('save', { ...base, baseRevision: 2, draft: first.document, summary: '下一版' })
    /** 删除后的完整快照。 */
    const deleted = await service.invoke('deleteHistory', { ...base, baseRevision: 3, kind: 'candidate', recordId: candidate.id })
    expect(deleted.versions.map(version => version.revision)).toEqual([3, 2, 1])
    /** 持久化采纳事实，验证清理不丢幂等信息。 */
    const head = JSON.parse(readFileSync(join(root, '.dutydeck', 'interaction-design', 'prototypes', base.prototypeId, 'head.json'), 'utf8'))
    expect(head.adopted[candidate.id]).toBe(2)
  })
})

describe('候选影响范围边界', () => {
  it('Given 多页和分组 When 修改状态、排序、入口、流程或增删页面 Then 仅返回实际受影响身份', async () => {
    /** 双分组、三页的独立基线。 */
    const { service } = setup()
    /** 本例初始正式文档。 */
    const first = await service.invoke('create', { sessionId, name: '范围', platform: 'mobile' })
    /** 固定会话和原型归属。 */
    const base = { sessionId, prototypeId: first.document.id }
    /** 可编辑的候选基线副本。 */
    const draft = parsePrototypeDraft(first.document)
    draft.groups = [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }]
    draft.pages = ['one', 'two', 'three'].map((id, index) => ({ id, groupId: index === 2 ? 'b' : 'a', name: id, html: '<button data-prototype-element="go">跳转</button>' }))
    draft.entryPageId = 'one'
    await service.invoke('save', { ...base, baseRevision: 1, draft, summary: '基线' })
    /** 各变体独立比较同一不可变基线，不产生新正式版本。 */
    const cases: Array<{ change(value: typeof draft): void; expected: string[] }> = [
      { change: value => { value.pages[1]!.states = [{ id: 'empty', name: '空状态', html: '<p>空</p>' }] }, expected: ['two'] },
      { change: value => { value.pages[1]!.name = '改名' }, expected: ['two'] },
      { change: value => { value.pages = [value.pages[1]!, value.pages[0]!, value.pages[2]!] }, expected: ['one', 'two'] },
      { change: value => { value.entryPageId = 'two' }, expected: ['one', 'two'] },
      { change: value => { value.flows = [{ id: 'route', fromPageId: 'two', targetPageId: 'one', elementId: 'go' }] }, expected: ['two'] },
      { change: value => { value.groups[1]!.name = '新分组名' }, expected: ['three'] },
      { change: value => { value.pages.pop() }, expected: ['three'] },
      { change: value => { value.pages.push({ ...value.pages[2]!, id: 'four', name: 'four' }) }, expected: ['four'] },
    ]
    for (const item of cases) {
      /** 单次候选草稿，避免前一个变体污染后续范围。 */
      const changed = structuredClone(draft)
      item.change(changed)
      expect((await service.invoke('propose', { ...base, baseRevision: 2, draft: changed, summary: '变体' })).affectedPageIds).toEqual(item.expected)
    }
  })

  it('Given 页级旧候选基线已删除 When 查询影响与取消后清理 Then 回退固定页且取消记录可删除', async () => {
    /** 固定单页任务，生成之后推进正式版本。 */
    const { service } = setup()
    /** 本例初始正式文档。 */
    const first = await service.invoke('create', { sessionId, name: '旧候选', platform: 'mobile' })
    /** 固定会话和原型归属。 */
    const base = { sessionId, prototypeId: first.document.id }
    /** 页级任务固定身份。 */
    const pageId = first.document.pages[0]!.id
    /** 本例生成任务及其固定范围。 */
    const job = await service.invoke('beginJob', { ...base, baseRevision: 1, pageId, instruction: '改正文', mode: 'page-edit' })
    /** 本例提交的候选身份。 */
    const candidate = await service.invoke('propose', { ...base, baseRevision: 1, jobId: job.id, draft: first.document, summary: '旧候选' })
    await service.invoke('save', { ...base, baseRevision: 1, draft: first.document, summary: '新版本' })
    await service.invoke('deleteVersion', { ...base, baseRevision: 2, revision: 1 })
    expect(await service.invoke('getCandidateImpact', { ...base, candidateId: candidate.id })).toEqual({ pageIds: [pageId] })
    await service.invoke('discardCandidate', { ...base, candidateId: candidate.id })
    expect((await service.invoke('deleteHistory', { ...base, baseRevision: 2, kind: 'job', recordId: job.id })).candidates).toEqual([])
  })
})

it('Given 已采纳任务对应当前版本 When 从任务入口删除 Then 同样拒绝并保持原子记录不变', async () => {
  /** 隔离服务及正式基线。 */
  const { service, root } = setup()
  /** 初始模块。 */
  const first = await service.invoke('create', { sessionId, name: '保护', platform: 'mobile' })
  /** 固定调用身份。 */
  const base = { sessionId, prototypeId: first.document.id }
  /** 生成任务及其候选。 */
  const job = await service.invoke('beginJob', { ...base, baseRevision: 1, instruction: '设计', mode: 'design' })
  /** 待采纳正文。 */
  const candidate = await service.invoke('propose', { ...base, baseRevision: 1, jobId: job.id, draft: first.document, summary: '采纳' })
  await service.invoke('adopt', { ...base, baseRevision: 1, candidateId: candidate.id })
  await expect(service.invoke('deleteHistory', { ...base, baseRevision: 2, kind: 'job', recordId: job.id })).rejects.toThrow('当前版本')
  expect((await service.invoke('load', base)).candidates).toHaveLength(1)
  expect((await service.invoke('load', base)).jobs).toHaveLength(1)
  /** 模拟旧基线被破坏，禁止把校验失败当作正常保守回退。 */
  const baselinePath = join(root, '.dutydeck', 'interaction-design', 'prototypes', base.prototypeId, 'revisions', '1.json')
  writeFileSync(baselinePath, '{}')
  await expect(service.invoke('getCandidateImpact', { ...base, candidateId: candidate.id })).rejects.toThrow('版本页面记录非法')
})

/** 布局变更必须经过与正文相同的持久化和版本边界。 */
describe('显示合同的版本和全局边界', () => {
  it('Given 独立全屏状态 When 保存重载和恢复 Then 保留布局且递增页面版本', async () => {
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '游戏', platform: 'mobile' })
    const presentation = { schemaVersion: 1 as const, contentLayout: 'edge-to-edge' as const, statusBar: 'hidden' as const, navigation: 'none' as const, orientation: 'landscape' as const }
    const draft = { ...first.document, pages: first.document.pages.map(page => ({ ...page, states: [{ id: 'game', name: '游戏', html: '<main>游戏</main>', presentation }] })) }
    const saved = await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft, summary: '全屏状态' })
    expect(saved.document.pages[0]!.states![0]!.presentation).toEqual(presentation)
    const changed = await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 2, draft: { ...saved.document, pages: saved.document.pages.map(page => ({ ...page, presentation })) }, summary: '横屏页面' })
    expect(changed.document.pages[0]!.pageRevision).toBe(3)
    const history = await service.invoke('getPageVersions', { sessionId, prototypeId: first.document.id, pageId: 'home' })
    expect(history).toHaveLength(3)
    const restored = await service.invoke('restore', { sessionId, prototypeId: first.document.id, baseRevision: 3, revision: 2 })
    expect(restored.document.pages[0]!.states![0]!.presentation).toEqual(presentation)
    expect(restored.document.pages[0]!.presentation).toEqual(saved.document.pages[0]!.presentation)
  })
  it('Given 单页面原型改变全局设备 When 页面采纳 Then 明确拒绝并保留原基线', async () => {
    const { service } = setup()
    const first = await service.invoke('create', { sessionId, name: '环境', platform: 'mobile' })
    const candidate = await service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft: { ...first.document, environment: { schemaVersion: 1, target: 'android', deviceId: 'Pixel 10' } }, summary: '换平台' })
    expect(candidate.affectedPageIds).toEqual(['home'])
    await expect(service.invoke('adoptPage', { sessionId, prototypeId: first.document.id, candidateId: candidate.id, baseRevision: 1, basePageRevision: 1, pageId: 'home' })).rejects.toThrow('全局')
  })
})

it('Given 页面任务 When 修改目标布局 Then 可提交但全局环境变更不可混入', async () => {
  /** 页面任务权限不随布局扩展而扩张到其他页面或全局环境。 */
  const { service } = setup()
  const first = await service.invoke('create', { sessionId, name: '布局任务', platform: 'mobile' })
  const job = await service.invoke('beginJob', { sessionId, prototypeId: first.document.id, baseRevision: 1, pageId: 'home', instruction: '将本页切换为全屏游戏' })
  const draft = structuredClone(first.document)
  draft.pages[0]!.presentation = { schemaVersion: 1, contentLayout: 'edge-to-edge', statusBar: 'hidden', navigation: 'none', orientation: 'landscape' }
  const input = { sessionId, prototypeId: first.document.id, baseRevision: 1, jobId: job.id, draft, summary: '全屏布局' }
  await expect(service.invoke('propose', { ...input, draft: { ...draft, environment: { schemaVersion: 1, target: 'android', deviceId: 'Pixel 10' } } })).rejects.toThrow('超出任务页面范围')
  const candidate = await service.invoke('propose', input)
  const saved = await service.invoke('adoptPage', { sessionId, prototypeId: first.document.id, candidateId: candidate.id, baseRevision: 1, basePageRevision: 1, pageId: 'home' })
  expect(saved.document.pages[0]!.presentation).toEqual(draft.pages[0]!.presentation)
  expect(saved.document.environment).toEqual(first.document.environment)
})

it('Given 多页面模块 When 全局设备环境改变 Then 所有页面的影响范围和版本更新', async () => {
  /** 环境变化影响每个页面，即使正文完全未改。 */
  const { service } = setup()
  const first = await service.invoke('create', { sessionId, name: '设备', platform: 'mobile' })
  const draft = { ...first.document, pages: [...first.document.pages, { id: 'other', groupId: 'main', name: '另一页', html: '<main>另一页</main>' }] }
  const base = await service.invoke('save', { sessionId, prototypeId: first.document.id, baseRevision: 1, draft, summary: '增加页面' })
  const candidate = await service.invoke('propose', { sessionId, prototypeId: first.document.id, baseRevision: 2, draft: { ...base.document, environment: { schemaVersion: 1, target: 'ios', deviceId: 'iPhone X' } }, summary: '基准设备修改' })
  expect(candidate.affectedPageIds).toEqual(['home', 'other'])
  const saved = await service.invoke('adopt', { sessionId, prototypeId: first.document.id, baseRevision: 2, candidateId: candidate.id })
  expect(saved.document.pages.map(page => page.pageRevision)).toEqual(base.document.pages.map(page => page.pageRevision! + 1))
})

it('Given 旧版磁盘记录 When 缺省全部布局字段 Then 原内容hash仍可读取且不自动迁移', async () => {
  /** 构造与旧版本完全一致的持久化载荷，不使用新解析器生成历史 hash。 */
  const { root, service } = setup()
  const first = await service.invoke('create', { sessionId, name: '旧记录', platform: 'mobile' })
  const path = join(root, '.dutydeck', 'interaction-design', 'prototypes', first.document.id, 'revisions', '1.json')
  const stored = JSON.parse(readFileSync(path, 'utf8')) as { hash: string; document: { environment?: unknown; pages: Array<{ presentation?: unknown }> } }
  delete stored.document.environment
  for (const page of stored.document.pages) delete page.presentation
  const page = first.document.pages[0]!
  const legacy = { name: first.document.name, platform: first.document.platform, brief: first.document.brief, groups: first.document.groups, pages: [{ id: page.id, groupId: page.groupId, name: page.name, html: page.html, pageRevision: page.pageRevision }], entryPageId: first.document.entryPageId, flows: first.document.flows }
  stored.hash = interactionHash(JSON.stringify([first.document.id, 1, first.document.createdAt, first.document.updatedAt, legacy]))
  writeJsonFileAtomic(path, stored)
  const loaded = await service.invoke('getVersion', { sessionId, prototypeId: first.document.id, revision: 1 })
  expect(loaded).not.toHaveProperty('environment')
  expect(loaded.pages[0]).not.toHaveProperty('presentation')
  expect(loaded.pages[0]!.html).toBe(page.html)
})
