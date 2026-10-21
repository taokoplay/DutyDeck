import { randomUUID } from 'node:crypto'
import { existsSync, opendirSync, readdirSync } from 'node:fs'
import { basename, join, posix } from 'node:path'
import type { InteractionDesignInputs, InteractionDesignMethod, InteractionDesignResults, PrototypeCandidate, PrototypeCandidateSummary, PrototypeCheck, PrototypeDocument, PrototypeDraft, PrototypeJob, PrototypePage, PrototypePageComparison, PrototypePageVersionSummary, PrototypeSnapshot, PrototypeSummary, PrototypeVersion } from '@dutydeck/shared'
import { assertPrototypeDraft, createPrototypeBlankPage, inferPrototypeJobMode, isProjectRestoreInstruction, parsePrototypeDraft, parsePrototypePlan, parseInteractionDesignCommand, PROTOTYPE_LIMITS, validateProjectRestoreDraft, validatePrototypeStructure } from '@dutydeck/shared'
import { acquireMediaFileLock } from '../media/media-file-lock'
import { readAtomicFileState, removeFileAtomic, writeJsonFileAtomicSecure } from '../safe-file'
import { assertInteractionId, interactionDirectory, readInteractionFile } from './paths'
import { InteractionAssetService, MAX_INTERACTION_IMAGE_BYTES } from './asset-service'
import { InteractionSourceService, interactionHash } from './source-service'
import type { InteractionSourceReader } from './source-service'
import { createInteractionDelivery, createInteractionHandoff } from './delivery-service'
import { validatePrototypeContent } from './content-validation'

/** 项目内多原型历史合并后的唯一指针；旧目录保留用于兼容外部引用。 */
interface PrototypeConsolidation {
  schemaVersion: 1
  workspaceId: string
  canonicalId: string
  sourceIds: string[]
  createdAt: number
}

/** 主进程为已授权项目构造的依赖，真实来源读取使用稳定目录能力。 */
export interface InteractionDesignServiceDependencies {
  /** 工作区身份，用于正式文件归属验证。 */
  workspaceId: string
  /** 重新核验当前会话、项目根与权限绑定。 */
  assertCurrent?: () => void
  /** getProjectFilesPath(workspace.slug) 返回的可信项目根。 */
  projectRoot: string
  /** 可重建缓存根，与正式文件独立。 */
  cacheRoot?: string
  /** 生产环境提供稳定目录读取，测试可注入隔离实现。 */
  readSourceFile?: InteractionSourceReader
  /** 主进程验证项目、媒体身份与权限后返回独立图片字节。 */
  readMediaAsset?: (ref: { assetId: string; revision: number; hash: string; mediaKind: 'image' }) => Promise<Uint8Array>
  /** 覆盖异步准备和短提交阶段的工作区写 lease。 */
  withWriteLease?: <T>(effect: () => Promise<T>) => Promise<T>
}
/** 原子提交点仅指向已经完整保存的不可变版本。 */
interface PrototypeHead {
  schemaVersion: 1
  workspaceId: string
  prototypeId: string
  revision: number
  /** 已经分配过的最高版本号；恢复旧版本时保持历史编号单调。 */
  latestRevision?: number
  /** 候选采纳记录与 head 同一次提交，崩溃恢复不重复采纳。 */
  adopted: Record<string, number>
}
/** 正文去重后的版本文件，保留全部非正文属性。 */
interface StoredVersion {
  /** 完整文档的 SHA-256，用于检测版本元数据篡改。 */
  hash: string
  document: Omit<PrototypeDocument, 'pages'> & { pages: Array<Omit<PrototypeDocument['pages'][number], 'html' | 'states'> & { contentHash: string; states?: Array<Omit<NonNullable<PrototypePage['states']>[number], 'html'> & { contentHash: string }> }> }
  version: PrototypeVersion
}
/** 历史删除采用单个原子索引，正文、采纳事实和交接记录保持不变。 */
interface HistoryDeletions {
  /** 已隐藏的候选身份。 */
  candidates: string[]
  /** 已隐藏的生成任务身份。 */
  jobs: string[]
}
/** 正式数据只读和修改都通过本服务。 */
export class InteractionDesignService {
  /** 项目来源读取。 */
  private readonly sources: InteractionSourceService
  /** 独立图片库。 */
  private readonly assets: InteractionAssetService
  constructor(private readonly dependencies: InteractionDesignServiceDependencies) {
    assertInteractionId(dependencies.workspaceId)
    this.sources = new InteractionSourceService(dependencies.projectRoot, dependencies.readSourceFile)
    this.assets = new InteractionAssetService(dependencies.projectRoot)
  }
  /** 获取已校验的正式目录；不把全局缓存当权威数据。 */
  private root(create = false): string { return interactionDirectory(this.dependencies.projectRoot, ['.proma', 'interaction-design'], create) }
  /** 读取项目级合并指针；指针损坏时停止加载，避免把历史模块误当成当前模块。 */
  private consolidation(): PrototypeConsolidation | null {
    const path = join(this.root(), 'consolidation.json')
    if (!existsSync(path)) return null
    const value = this.json<PrototypeConsolidation>(path, 64 * 1024)
    try { assertInteractionId(value.canonicalId) } catch { throw new Error('交互模块合并记录损坏') }
    if (value.schemaVersion !== 1 || value.workspaceId !== this.dependencies.workspaceId || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
      || !Array.isArray(value.sourceIds) || value.sourceIds.length < 2 || new Set(value.sourceIds).size !== value.sourceIds.length
      || value.sourceIds.some(id => !/^[A-Za-z0-9_-]{1,128}$/.test(id)) || !value.sourceIds.includes(value.canonicalId)) throw new Error('交互模块合并记录损坏')
    return value
  }
  /** 检查项目是否已经存在正式交互模块；旧模块目录保留以避免重复创建。 */
  private hasPrototype(): boolean {
    const path = join(this.dependencies.projectRoot, '.proma', 'interaction-design', 'prototypes')
    if (!existsSync(path)) return false
    /** 原型目录也必须逐级拒绝符号链接，不能因唯一性检查绕过正式路径边界。 */
    interactionDirectory(this.dependencies.projectRoot, ['.proma', 'interaction-design', 'prototypes'])
    return readdirSync(path, { withFileTypes: true }).some(entry => entry.isDirectory() && /^[A-Za-z0-9_-]+$/.test(entry.name) && existsSync(join(path, entry.name, 'head.json')))
  }
  /** 校验原型身份并定位独立目录。 */
  private directory(id: string, child?: string, create = false): string {
    assertInteractionId(id)
    return interactionDirectory(this.dependencies.projectRoot, ['.proma', 'interaction-design', 'prototypes', id, ...(child ? [child] : [])], create)
  }
  /** 有界读取正式 JSON；不存在或损坏均不静默还原旧 head。 */
  private json<T>(path: string, maxBytes = 32 * 1024 * 1024): T { return JSON.parse(readInteractionFile(path, maxBytes).toString('utf8')) as T }
  /** 读取并核验项目归属和当前版本。 */
  private head(id: string, budget?: { remaining: number }): PrototypeHead {
    /** head 不携带正文，仅允许有限采纳索引；列表调用同时消耗累计预算。 */
    const bytes = readInteractionFile(join(this.directory(id), 'head.json'), Math.min(budget?.remaining ?? 512 * 1024, 512 * 1024))
    if (budget) budget.remaining -= bytes.length
    /** 当前正式提交点。 */
    const head = JSON.parse(bytes.toString('utf8')) as PrototypeHead
    const latestRevision = head.latestRevision ?? head.revision
    if (head.schemaVersion !== 1 || head.workspaceId !== this.dependencies.workspaceId || head.prototypeId !== id
      || !Number.isSafeInteger(head.revision) || head.revision < 1
      || !Number.isSafeInteger(latestRevision) || latestRevision < head.revision) throw new Error('原型归属或版本记录损坏')
    /** 当前指针必须对应已经完整写入的版本；历史高水位允许因用户删除而出现空洞。 */
    if (!existsSync(join(this.directory(id, 'revisions'), `${head.revision}.json`))) throw new Error('原型当前版本记录损坏')
    /** 兼容旧 head 文件时在内存中补齐历史最高版本号。 */
    head.latestRevision = latestRevision
    return head
  }
  /** 读取固定历史版本并逐页验证内容 hash。 */
  private version(id: string, revision: number): PrototypeDocument {
    /** 当前指针与历史高水位只读取一次，避免恢复/导出时重复读取 head。 */
    const head = this.head(id)
    if (!Number.isSafeInteger(revision) || revision < 1 || revision > (head.latestRevision ?? head.revision)) throw new Error('原型版本不存在')
    /** 不可变版本记录；删除后的历史统一返回领域错误，不泄漏底层文件路径。 */
    const versionPath = join(this.directory(id, 'revisions'), `${revision}.json`)
    if (!existsSync(versionPath)) throw new Error('原型版本不存在')
    const stored = this.json<StoredVersion>(versionPath, 2 * 1024 * 1024)
    if (!stored.document || !Array.isArray(stored.document.pages) || stored.document.pages.length > PROTOTYPE_LIMITS.pages) throw new Error('版本页面记录非法')
    /** 在加载下一页前扣除正文读取预算。 */
    let remainingContentBytes = PROTOTYPE_LIMITS.totalChars * 4
    /** 根据内容身份读取单个状态正文，并共享整个版本的读取预算。 */
    const readContent = (contentHash: string): string => {
      if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error('页面内容身份非法')
      /** 内容寻址的页面或状态对象。 */
      const content = this.json<{ html: string }>(join(this.directory(id, 'contents'), `${contentHash}.json`), Math.min(remainingContentBytes, PROTOTYPE_LIMITS.pageChars * 4 + 1024))
      if (typeof content.html !== 'string' || interactionHash(content.html) !== contentHash) throw new Error('页面正文已损坏')
      remainingContentBytes -= Buffer.byteLength(content.html)
      return content.html
    }
    /** 恢复后的完整文档；旧版本不补写可选状态字段。 */
    const document: PrototypeDocument = { ...stored.document, pages: stored.document.pages.map(page => {
      if (page.states !== undefined && (!Array.isArray(page.states) || page.states.length > PROTOTYPE_LIMITS.statesPerPage)) throw new Error('版本页面状态记录非法')
      /** 存储定位字段不穿过公开边界。 */
      const { contentHash, states, ...metadata } = page
      return { ...metadata, html: readContent(contentHash), ...(states === undefined ? {} : { states: states.map(state => ({ id: state.id, name: state.name, html: readContent(state.contentHash), ...(state.presentation === undefined ? {} : { presentation: state.presentation }) })) }) }
    }) }
    if (document.id !== id || document.revision !== revision || document.schemaVersion !== 1) throw new Error('版本身份不匹配')
    assertPrototypeDraft(document)
    if (interactionHash(JSON.stringify([document.id, document.revision, document.createdAt, document.updatedAt, parsePrototypeDraft(document)])) !== stored.hash) throw new Error('版本内容身份已损坏')
    return document
  }
  /** 枚举固定目录内有限 JSON 文件。 */
  private records<T>(id: string, child: string, maximumRevision?: number): T[] {
    /** 子目录可能尚未创建。 */
    const path = join(this.directory(id), child)
    if (!existsSync(path)) return []
    this.directory(id, child)
    /** 记录名只允许稳定身份。 */
    const names = readdirSync(path).filter(name => /^[A-Za-z0-9_-]+\.json$/.test(name) && (maximumRevision === undefined || /^[1-9][0-9]*\.json$/.test(name) && Number(name.slice(0, -5)) <= maximumRevision))
    if (names.length > 2000) throw new Error('记录数量超过读取预算')
    /** 单次读取累计预算，避免大量历史挤占主进程内存。 */
    let remaining = 32 * 1024 * 1024
    return names.map(name => {
      /** 在解析前以剩余预算限制读取。 */
      const bytes = readInteractionFile(join(path, name), remaining)
      remaining -= bytes.length
      return JSON.parse(bytes.toString('utf8')) as T
    })
  }
  /** 枚举项目内正式原型目录，保留有 head 的稳定身份。 */
  private prototypeIds(): string[] {
    const path = join(this.dependencies.projectRoot, '.proma', 'interaction-design', 'prototypes')
    if (!existsSync(path)) return []
    this.root()
    interactionDirectory(this.dependencies.projectRoot, ['.proma', 'interaction-design', 'prototypes'])
    const ids: string[] = []
    const handle = opendirSync(path)
    let entries = 0
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        if (++entries > 4000) throw new Error('原型目录条目超过列表预算')
        if (/^[A-Za-z0-9_-]+$/.test(entry.name) && existsSync(join(path, entry.name, 'head.json'))) ids.push(entry.name)
        if (ids.length > 2000) throw new Error('原型数量超过列表预算')
      }
    } finally { handle.closeSync() }
    return ids
  }
  /** 仅读取当前版本摘要，不打开页面正文。 */
  private prototypeSummary(id: string, budget: { remaining: number }): PrototypeSummary {
    const head = this.head(id, budget)
    const bytes = readInteractionFile(join(this.directory(id, 'revisions'), `${head.revision}.json`), Math.min(budget.remaining, 2 * 1024 * 1024))
    budget.remaining -= bytes.length
    const stored = JSON.parse(bytes.toString('utf8')) as StoredVersion
    const document = stored.document
    if (!document || document.id !== id || document.revision !== head.revision || document.schemaVersion !== 1
      || typeof document.name !== 'string' || document.name.length > 120 || !document.name.trim()
      || (document.platform !== 'mobile' && document.platform !== 'desktop')
      || !Array.isArray(document.pages) || document.pages.length < 1 || document.pages.length > PROTOTYPE_LIMITS.pages
      || !Number.isSafeInteger(document.updatedAt) || document.updatedAt < 0) throw new Error('原型摘要元数据损坏')
    return { id, name: document.name, platform: document.platform, revision: document.revision, pageCount: document.pages.length, updatedAt: document.updatedAt }
  }
  /** 把一个历史模块追加到正式模块，冲突身份自动重写并保留页面跳转。 */
  private appendPrototype(canonical: PrototypeDraft, source: PrototypeDocument): PrototypeDraft {
    const usedGroups = new Set(canonical.groups.map(group => group.id))
    const usedPages = new Set(canonical.pages.map(page => page.id))
    const usedFlows = new Set(canonical.flows.map(flow => flow.id))
    /** 先为全部分组分配身份，再解析父子关系，避免依赖源数组顺序。 */
    const groupIds = new Map(source.groups.map(group => [group.id, usedGroups.has(group.id) ? randomUUID() : group.id]))
    const pageIds = new Map<string, string>()
    const sourceName = source.name.trim() || '历史模块'
    const groups = source.groups.map(group => {
      /** 当前分组已经在全量映射中预留身份，父级映射不受数组顺序影响。 */
      const id = groupIds.get(group.id)!
      usedGroups.add(id)
      return { ...group, id, ...(group.parentId ? { parentId: groupIds.get(group.parentId) ?? group.parentId } : {}) }
    })
    source.pages.forEach(page => { const id = usedPages.has(page.id) ? randomUUID() : page.id; usedPages.add(id); pageIds.set(page.id, id) })
    /** 重写双引号、单引号及等号周围空白，保留合并页面的内部跳转。 */
    const rewrite = (html: string): string => [...pageIds.entries()].reduce((value, [before, after]) => value.replace(new RegExp(`(data-prototype-page\\s*=\\s*["'])${before}(["'])`, 'g'), `$1${after}$2`), html)
    const pages = source.pages.map(page => {
      const id = pageIds.get(page.id)!
      const groupId = groupIds.get(page.groupId) ?? page.groupId
      return { ...page, id, groupId, html: rewrite(page.html), ...(page.states ? { states: page.states.map(state => ({ ...state, html: rewrite(state.html) })) } : {}) }
    })
    const flows = source.flows.map(flow => {
      const id = usedFlows.has(flow.id) ? randomUUID() : flow.id
      usedFlows.add(id)
      return { ...flow, id, fromPageId: pageIds.get(flow.fromPageId) ?? flow.fromPageId, targetPageId: pageIds.get(flow.targetPageId) ?? flow.targetPageId }
    })
    const namedGroups = new Set(canonical.groups.map(group => group.name))
    const normalizedGroups = groups.map(group => {
      if (!namedGroups.has(group.name)) { namedGroups.add(group.name); return group }
      return { ...group, name: `${sourceName} · ${group.name}` }
    })
    const merged = { ...canonical, groups: [...canonical.groups, ...normalizedGroups], pages: [...canonical.pages, ...pages], flows: [...canonical.flows, ...flows] }
    if (!merged.brief.trim() && source.brief.trim()) merged.brief = source.brief
    return merged
  }
  /** 首次发现历史多模块时一次性合并；后续列表读取只返回正式模块摘要。 */
  private async consolidatePrototypes(ids: string[], summaries: PrototypeSummary[]): Promise<PrototypeSummary> {
    const marker = this.consolidation()
    if (marker) {
      const summary = summaries.find(item => item.id === marker.canonicalId)
      if (!summary) throw new Error('交互模块合并指针指向不存在的正式模块')
      return summary
    }
    const ordered = [...summaries].sort((left, right) => left.updatedAt - right.updatedAt || left.id.localeCompare(right.id))
    const canonicalSummary = ordered[ordered.length - 1]
    if (!canonicalSummary) throw new Error('没有可合并的交互模块')
    const documents = await Promise.all(ordered.map(item => Promise.resolve(this.version(item.id, item.revision))))
    let merged: PrototypeDraft = structuredClone(documents[documents.length - 1]!)
    for (let index = documents.length - 2; index >= 0; index -= 1) merged = this.appendPrototype(merged, documents[index]!)
    assertPrototypeDraft(merged)
    await this.write(() => {
      /** 并发列表请求可能在本次读取后先完成合并，写锁内再次检查避免重复提交。 */
      if (this.consolidation()) return
      this.commit(canonicalSummary.id, canonicalSummary.revision, merged, `合并 ${ids.length} 个交互模块`)
      const path = join(this.root(true), 'consolidation.json')
      writeJsonFileAtomicSecure(path, { schemaVersion: 1, workspaceId: this.dependencies.workspaceId, canonicalId: canonicalSummary.id, sourceIds: [...ids], createdAt: Date.now() } satisfies PrototypeConsolidation, { expectedDestination: { kind: 'missing' } })
    })
    const budget = { remaining: 8 * 1024 * 1024 }
    return this.prototypeSummary(canonicalSummary.id, budget)
  }
  /** 删除前核验固定交接引用；输入模块和版本，遇到引用或不可验证记录时拒绝删除。 */
  private assertVersionUnreferenced(id: string, revision: number): void {
    if (this.records<PrototypeJob>(id, 'jobs').some(job => job.status === 'running' && job.baseRevision === revision)) {
      throw new Error('该版本仍用于运行中的生成任务，请先取消任务再删除')
    }
    /** 交接目录首次使用前允许不存在，存在时逐级拒绝符号链接。 */
    const path = join(this.directory(id), 'deliveries')
    if (!existsSync(path)) return
    this.directory(id, 'deliveries')
    /** 流式枚举避免文件数量过大时一次性分配目录列表。 */
    const directory = opendirSync(path)
    /** 包含无关交付文件在内的枚举预算。 */
    let count = 0
    /** 交接记录的累计读取预算。 */
    let remainingBytes = 32 * 1024 * 1024
    try {
      for (;;) {
        /** 当前目录项；文件读取仍使用 no-follow 稳定句柄。 */
        const entry = directory.readSync()
        if (!entry) break
        if (++count > 2000) throw new Error('交付记录数量超过读取预算，无法安全删除版本')
        if (!entry.name.endsWith('.handoff.json')) continue
        /** 只需核验交接身份和固定版本，不加载额外正文或素材。 */
        const bytes = readInteractionFile(join(path, entry.name), Math.min(remainingBytes, 2 * 1024 * 1024))
        remainingBytes -= bytes.length
        /** 来自受管文件的最小交接身份，损坏时不能假定没有引用。 */
        const handoff = JSON.parse(bytes.toString('utf8')) as { schemaVersion?: number; prototypeId?: string; revision?: number }
        if (!handoff || handoff.schemaVersion !== 1 || handoff.prototypeId !== id || !Number.isSafeInteger(handoff.revision) || handoff.revision! < 1) throw new Error('开发交接记录损坏，无法安全删除版本')
        if (handoff.revision === revision) throw new Error('该版本已用于开发交接，不能删除')
      }
    } finally { directory.closeSync() }
  }
  /** 读取有界删除索引；不存在表示兼容旧项目，损坏则明确阻断。 */
  private historyDeletions(id: string): HistoryDeletions {
    /** 项目内固定索引路径。 */
    const path = join(this.directory(id), 'history-deletions.json')
    if (!existsSync(path)) return { candidates: [], jobs: [] }
    /** 原子索引记录只保存身份，不保存正文。 */
    const deleted = this.json<HistoryDeletions>(path, 1024 * 1024)
    if (!Array.isArray(deleted.candidates) || !Array.isArray(deleted.jobs) || deleted.candidates.length > 2000 || deleted.jobs.length > 2000) throw new Error('历史删除记录损坏')
    for (const recordId of [...deleted.candidates, ...deleted.jobs]) assertInteractionId(recordId)
    return deleted
  }
  /** 对比固定基线与候选，返回正文、目录顺序、状态、入口和源流程真正变化的页面身份。 */
  private affectedPages(baseline: PrototypeDraft, draft: PrototypeDraft): string[] {
    /** 构造单页可见语义，目录祖先变化也会影响该页。 */
    const signatures = (value: PrototypeDraft): Map<string, string> => new Map(value.pages.map(page => {
      /** 目录祖先身份及其同级位置。 */
      const groups: unknown[] = []
      /** 当前目录游标与防循环集合。 */
      let groupId: string | undefined = page.groupId
      /** 已遍历祖先，保证损坏循环不会阻塞读取。 */
      const visited = new Set<string>()
      while (groupId && !visited.has(groupId)) {
        visited.add(groupId)
        /** 当前祖先及其名称、位置。 */
        const group = value.groups.find(item => item.id === groupId)
        if (!group) break
        groups.push([group, value.groups.filter(item => item.parentId === group.parentId).findIndex(item => item.id === group.id)])
        groupId = group.parentId
      }
        const pageContent = { id: page.id, groupId: page.groupId, name: page.name, html: page.html, ...(page.defaultStateName === undefined ? {} : { defaultStateName: page.defaultStateName }), ...(page.states === undefined ? {} : { states: page.states }), ...(page.source === undefined ? {} : { source: page.source }), ...(page.route === undefined ? {} : { route: page.route }), ...(page.role === undefined ? {} : { role: page.role }), ...(page.presentation === undefined ? {} : { presentation: page.presentation }) }
        return [page.id, JSON.stringify([pageContent, groups, value.pages.filter(item => item.groupId === page.groupId).findIndex(item => item.id === page.id), value.flows.filter(flow => flow.fromPageId === page.id), value.entryPageId === page.id, ...(value.environment === undefined ? [] : [value.environment])])]
    }))
    /** 两份稿的页面签名，只遍历有限页面集。 */
    const before = signatures(baseline)
    /** 候选页面签名。 */
    const after = signatures(draft)
    return [...new Set([...before.keys(), ...after.keys()])].filter(id => before.get(id) !== after.get(id))
  }
  /** 从不可变全局版本索引推导页面独立版本，不读取页面 HTML 正文。 */
  private pageVersions(id: string, pageId: string): PrototypePageVersionSummary[] {
    const head = this.head(id)
    const versions = this.records<StoredVersion>(id, 'revisions', head.latestRevision).sort((left, right) => left.version.revision - right.version.revision)
    const result: PrototypePageVersionSummary[] = []
    let lastHash: string | undefined
    let derivedRevision = 0
    for (const stored of versions) {
      const page = stored.document.pages.find(item => item.id === pageId)
      if (!page) continue
      const contentHash = interactionHash(JSON.stringify([page.contentHash, ...(page.states ?? []).map(state => [state.id, state.contentHash, ...(state.presentation === undefined ? [] : [state.presentation])]), page.name, page.groupId, page.route, page.role, ...(page.presentation === undefined ? [] : [page.presentation]), ...(stored.document.environment === undefined ? [] : [stored.document.environment])]))
      if (contentHash === lastHash) continue
      const explicitRevision = Number.isSafeInteger(page.pageRevision) && page.pageRevision! > 0 ? page.pageRevision! : derivedRevision + 1
      derivedRevision = Math.max(derivedRevision + 1, explicitRevision)
      lastHash = contentHash
      result.push({ pageId, pageRevision: derivedRevision, globalRevision: stored.version.revision, summary: stored.version.summary, createdAt: stored.version.createdAt, contentHash })
    }
    return result.sort((left, right) => right.pageRevision - left.pageRevision)
  }
  /** 按页面正文计算简单、可审计的行级增删，不执行任何页面脚本。 */
  private lineDiff(before: string, after: string): { addedLines: string[]; removedLines: string[] } {
    const previous = before.split(/\r?\n/)
    const next = after.split(/\r?\n/)
    return { addedLines: next.filter(line => !previous.includes(line)), removedLines: previous.filter(line => !next.includes(line)) }
  }
  /** 从历史版本或候选投影目标页面，避免对比结果泄漏邻页正文。 */
  private pageComparisonSide(id: string, pageId: string, ref: { revision?: number; candidateId?: string }): { kind: 'version' | 'candidate'; id: string; globalRevision: number; pageRevision: number; page: PrototypePage; flows: string[] } {
    if (ref.revision !== undefined) {
      const document = this.version(id, ref.revision)
      const page = document.pages.find(item => item.id === pageId)
      if (!page) throw new Error('原型页面不存在')
      return { kind: 'version', id: String(ref.revision), globalRevision: ref.revision, pageRevision: page.pageRevision ?? 1, page, flows: document.flows.filter(flow => flow.fromPageId === pageId).map(flow => JSON.stringify(flow)) }
    }
    if (!ref.candidateId) throw new Error('页面对比版本缺少身份')
    const candidate = this.candidate(id, ref.candidateId)
    const page = candidate.draft.pages.find(item => item.id === pageId)
    if (!page) throw new Error('原型页面不存在')
    return { kind: 'candidate', id: ref.candidateId, globalRevision: candidate.baseRevision, pageRevision: page.pageRevision ?? 1, page, flows: candidate.draft.flows.filter(flow => flow.fromPageId === pageId).map(flow => JSON.stringify(flow)) }
  }
  /** 生成只包含目标页面的结构化对比结果。 */
  private comparePage(input: InteractionDesignInputs['comparePage']): PrototypePageComparison {
    const left = this.pageComparisonSide(input.prototypeId, input.pageId, input.left)
    const right = this.pageComparisonSide(input.prototypeId, input.pageId, input.right)
    const lineDiff = this.lineDiff(left.page.html, right.page.html)
    const beforeStates = new Map((left.page.states ?? []).map(state => [state.id, state]))
    const afterStates = new Map((right.page.states ?? []).map(state => [state.id, state]))
    const assets = (html: string): string[] => [...new Set([...html.matchAll(/prototype-asset:([A-Za-z0-9_-]+)/g)].map(match => match[1]!))]
    const beforeAssets = new Set(assets([left.page.html, ...(left.page.states ?? []).map(state => state.html)].join('\n')))
    const afterAssets = new Set(assets([right.page.html, ...(right.page.states ?? []).map(state => state.html)].join('\n')))
    const states = { added: [...afterStates.keys()].filter(id => !beforeStates.has(id)), removed: [...beforeStates.keys()].filter(id => !afterStates.has(id)), changed: [...afterStates.keys()].filter(id => beforeStates.has(id) && JSON.stringify(afterStates.get(id)) !== JSON.stringify(beforeStates.get(id))) }
    return {
      prototypeId: input.prototypeId, pageId: input.pageId,
      left: { kind: left.kind, id: left.id, globalRevision: left.globalRevision, pageRevision: left.pageRevision, name: left.page.name, html: left.page.html, ...(left.page.states === undefined ? {} : { states: left.page.states }), ...(left.page.presentation === undefined ? {} : { presentation: left.page.presentation }) },
      right: { kind: right.kind, id: right.id, globalRevision: right.globalRevision, pageRevision: right.pageRevision, name: right.page.name, html: right.page.html, ...(right.page.states === undefined ? {} : { states: right.page.states }), ...(right.page.presentation === undefined ? {} : { presentation: right.page.presentation }) },
      defaultHtml: { changed: left.page.html !== right.page.html, before: left.page.html, after: right.page.html, ...lineDiff },
      states,
      assets: { added: [...afterAssets].filter(id => !beforeAssets.has(id)), removed: [...beforeAssets].filter(id => !afterAssets.has(id)) },
      flows: { added: right.flows.filter(flow => !left.flows.includes(flow)), removed: left.flows.filter(flow => !right.flows.includes(flow)) },
    }
  }
  /** 规范化业务身份，阻止 Agent 在已有页面上重复创建新身份。 */
  private normalizePageIdentity(value: string | undefined): string | undefined {
    const raw = value?.trim().toLocaleLowerCase().replace(/\\/g, '/').replace(/\s+/g, ' ')
    const normalized = raw === '/' ? '/' : raw?.replace(/\/+$/, '')
    return normalized || undefined
  }
  /** 仅检查候选新增页；已有 pageId 的局部修改不会因改名而被误判。 */
  private assertNoDuplicatePages(baseline: PrototypeDraft, draft: PrototypeDraft): void {
    const existing = new Set(baseline.pages.map(page => page.id))
    for (const page of draft.pages.filter(item => !existing.has(item.id))) {
      const route = this.normalizePageIdentity(page.route)
      const name = this.normalizePageIdentity(page.name)
      const role = this.normalizePageIdentity(page.role)
      const duplicate = baseline.pages.find(previous => {
        const previousRoute = this.normalizePageIdentity(previous.route)
        if (route && previousRoute && route === previousRoute) return true
        const previousName = this.normalizePageIdentity(previous.name)
        const previousRole = this.normalizePageIdentity(previous.role)
        return Boolean(name && previousName && name === previousName && (!role || !previousRole || role === previousRole))
      })
      if (duplicate) throw new Error(`页面“${page.name}”已存在，请复用 pageId=${duplicate.id}`)
    }
  }
  /** 候选可采纳性由当前 head 推导，不修改旧生成结果。 */
  private candidate(id: string, candidateId: string): PrototypeCandidate {
    assertInteractionId(candidateId)
    if (this.historyDeletions(id).candidates.includes(candidateId)) throw new Error('候选已删除')
    /** 独立保存的候选正文。 */
    const candidate = this.json<PrototypeCandidate & { draftHash: string }>(join(this.directory(id, 'candidates'), `${candidateId}.json`))
    /** 当前提交点。 */
    const head = this.head(id)
    if (candidate.id !== candidateId || candidate.prototypeId !== id) throw new Error('候选归属不匹配')
    assertPrototypeDraft(candidate.draft)
    if (candidate.draftHash !== interactionHash(JSON.stringify(parsePrototypeDraft(candidate.draft)))) throw new Error('候选正文身份已损坏')
    /** 存储校验字段不穿过 renderer/Agent 返回边界。 */
    const { draftHash: _draftHash, ...publicCandidate } = candidate
    if (head.adopted[candidateId]) return { ...publicCandidate, status: 'adopted', adoptedRevision: head.adopted[candidateId] }
    if (candidate.status === 'discarded') return publicCandidate
    return { ...publicCandidate, status: candidate.baseRevision === head.revision ? 'ready' : 'stale' }
  }
  /** 候选列表只读取摘要，避免加载全部生成正文。 */
  private candidateSummaries(id: string, head: PrototypeHead): PrototypeCandidateSummary[] {
    /** 首次尚无候选目录。 */
    const path = join(this.directory(id), 'candidates')
    if (!existsSync(path)) return []
    this.directory(id, 'candidates')
    /** 轻量摘要文件集合。 */
    const names = readdirSync(path).filter(name => /^[A-Za-z0-9_-]+\.summary\.json$/.test(name))
    if (names.length > 2000) throw new Error('候选数量超过预算')
    /** 一次读取删除索引，避免每条摘要重复访问磁盘。 */
    const deleted = new Set(this.historyDeletions(id).candidates)
    /** 新摘要最多包含增删两侧 400 个页面身份，累计读取仍限制为 32 MiB。 */
    let remaining = 32 * 1024 * 1024
    return names.filter(name => !deleted.has(name.slice(0, -13))).map(name => {
      /** 独立候选摘要，不含 HTML。 */
      const bytes = readInteractionFile(join(path, name), Math.min(remaining, 64 * 1024))
      remaining -= bytes.length
      /** 已受单条和累计预算约束的摘要数据。 */
      const storedSummary = JSON.parse(bytes.toString('utf8')) as PrototypeCandidateSummary & { draftHash?: string }
      /** 兼容先前摘要残留的存储字段，不向调用方泄漏。 */
      const { draftHash: _draftHash, ...summary } = storedSummary
      if (summary.prototypeId !== id) throw new Error('候选归属不匹配')
      if (head.adopted[summary.id]) return { ...summary, status: 'adopted' as const, adoptedRevision: head.adopted[summary.id] }
      return { ...summary, status: summary.status === 'discarded' ? 'discarded' as const : summary.baseRevision === head.revision ? 'ready' as const : 'stale' as const }
    })
  }
  /** 单独更新候选摘要，正文与摘要都不拥有推进 head 的权限。 */
  private candidateSummary(candidate: PrototypeCandidate): void {
    /** 去掉不可变候选正文。 */
    const { draft: _draft, draftHash: _draftHash, ...summary } = candidate as PrototypeCandidate & { draftHash?: string }
    /** 固定摘要路径。 */
    const path = join(this.directory(candidate.prototypeId, 'candidates'), `${candidate.id}.summary.json`)
    /** 当前摘要身份。 */
    const state = readAtomicFileState(path)
    writeJsonFileAtomicSecure(path, summary, { expectedDestination: state ? { kind: 'state', state } : { kind: 'missing' } })
  }
  /** 返回当前文档及有限的轻量记录。 */
  private snapshot(id: string): PrototypeSnapshot {
    /** 当前提交点。 */
    const head = this.head(id)
    /** 删除索引在本次快照中仅读取一次。 */
    const deletedJobs = new Set(this.historyDeletions(id).jobs)
    return {
      document: this.version(id, head.revision),
      /** 恢复旧版本后仍展示更高版本，用户可以再次切换而不丢历史。 */
      versions: this.records<StoredVersion>(id, 'revisions', head.latestRevision).filter(value => value.version.revision <= (head.latestRevision ?? head.revision)).map(value => value.version).sort((a, b) => b.revision - a.revision),
      candidates: this.candidateSummaries(id, head),
      assets: this.assets.list(), jobs: this.records<PrototypeJob>(id, 'jobs').filter(job => !deletedJobs.has(job.id)), checks: this.records<PrototypeCheck>(id, 'checks'),
    }
  }
  /** 使用工作区 lease 与跨进程模块锁覆盖整个受控变更。 */
  private async write<T>(effect: () => Promise<T> | T): Promise<T> {
    /** 已授权的写入闭包。 */
    const run = async (): Promise<T> => {
      /** 模块短锁；各异步来源准备在调用本方法前完成。 */
      this.dependencies.assertCurrent?.()
      const release = acquireMediaFileLock(join(this.root(true), '.interaction-design.lock'))
      try { return await effect() } finally { release() }
    }
    return run()
  }
  /** 保存完整不可变版本，然后原子 CAS 推进唯一 head。 */
  private commit(id: string, baseRevision: number, draft: PrototypeDraft, summary: string, adoptedId?: string): void {
    draft = parsePrototypeDraft(draft)
    this.dependencies.assertCurrent?.()
    /** 现有提交点，初次创建允许缺失。 */
    const directory = this.directory(id, undefined, true)
    /** head 文件及读取期 CAS 状态。 */
    const headPath = join(directory, 'head.json')
    /** 读取期文件身份。 */
    const state = readAtomicFileState(headPath)
    /** 当前权威版本。 */
    const previous = state ? this.head(id) : null
    if ((previous?.revision ?? 0) !== baseRevision) throw new Error('原型版本已变化，请重新读取后修改')
    /** 固定基线用于内容差分；旧状态缺陷不阻断其他页面或目录修改。 */
    const baseline = previous ? this.version(id, previous.revision) : undefined
    /** 页面独立版本只在该页正文、状态、目录或职责真正变化时递增。 */
    const changedPageIds = new Set(baseline ? this.affectedPages(baseline, draft) : draft.pages.map(page => page.id))
    const normalizedPages = draft.pages.map(page => {
      const previousPage = baseline?.pages.find(value => value.id === page.id)
      const previousRevision = previousPage?.pageRevision ?? 1
      return { ...page, pageRevision: previousPage ? changedPageIds.has(page.id) ? previousRevision + 1 : previousRevision : 1 }
    })
    draft = { ...draft, pages: normalizedPages }
    this.assertAssets(draft, baseline)
    /** 创建时间始终沿用原始文档。 */
    const createdAt = baseline?.createdAt ?? Date.now()
    /** 新版本号取历史最高值之后，避免恢复旧版本后覆盖已有历史文件。 */
    const revision = (previous?.latestRevision ?? previous?.revision ?? 0) + 1
    /** 完整新文档。 */
    const document: PrototypeDocument = { ...structuredClone(draft), schemaVersion: 1, id, revision, createdAt, updatedAt: Date.now() }
    /** 页面内容寻址目录。 */
    const contents = this.directory(id, 'contents', true)
    /** 保存默认正文或附加状态正文；相同 HTML 共享不可变内容对象。 */
    const storeContent = (html: string): string => {
      /** HTML 内容身份。 */
      const contentHash = interactionHash(html)
      /** 不可变内容位置。 */
      const path = join(contents, `${contentHash}.json`)
      if (!existsSync(path)) writeJsonFileAtomicSecure(path, { html }, { expectedDestination: { kind: 'missing' } })
      else {
        /** 崩溃残留也必须经过内容身份验证。 */
        const existing = this.json<{ html: string }>(path, PROTOTYPE_LIMITS.pageChars * 4 + 1024)
        if (typeof existing.html !== 'string' || interactionHash(existing.html) !== contentHash) throw new Error('已有页面内容对象损坏，未提交新版本')
      }
      return contentHash
    }
    /** 页面及状态正文与版本元数据分离存储。 */
    const pages = document.pages.map(page => {
      /** 保留旧文档未提供状态字段时的原始磁盘结构。 */
      const { html, states, ...metadata } = page
      return { ...metadata, contentHash: storeContent(html), ...(states === undefined ? {} : { states: states.map(state => ({ id: state.id, name: state.name, contentHash: storeContent(state.html), ...(state.presentation === undefined ? {} : { presentation: state.presentation }) })) }) }
    })
    /** 新版本记录完整写入后才允许发布 head。 */
    const versionPath = join(this.directory(id, 'revisions', true), `${revision}.json`)
    /** 崩溃遗留的未发布版本允许在锁内覆盖，不属于可读取历史。 */
    const orphanState = readAtomicFileState(versionPath)
    writeJsonFileAtomicSecure(versionPath, { hash: interactionHash(JSON.stringify([document.id, document.revision, document.createdAt, document.updatedAt, parsePrototypeDraft(document)])), document: { ...document, pages }, version: { revision, summary: summary.slice(0, 1000), createdAt: document.updatedAt } }, { expectedDestination: orphanState ? { kind: 'state', state: orphanState } : { kind: 'missing' } })
    /** 候选采纳记录与当前版本共享一个提交点。 */
    const adopted = { ...(previous?.adopted ?? {}), ...(adoptedId ? { [adoptedId]: revision } : {}) }
    writeJsonFileAtomicSecure(headPath, { schemaVersion: 1, workspaceId: this.dependencies.workspaceId, prototypeId: id, revision, latestRevision: revision, adopted }, { expectedDestination: state ? { kind: 'state', state } : { kind: 'missing' } })
  }
  /** 保存独立记录，调用者持有模块锁。 */
  private record<T extends { id: string }>(id: string, child: string, record: T): void {
    this.dependencies.assertCurrent?.()
    assertInteractionId(record.id)
    /** 记录位置。 */
    const path = join(this.directory(id, child, true), `${record.id}.json`)
    /** 当前记录状态供 CAS 更新。 */
    const state = readAtomicFileState(path)
    writeJsonFileAtomicSecure(path, record, { expectedDestination: state ? { kind: 'state', state } : { kind: 'missing' } })
  }
  /** 生成结果仅保存候选，不能替换正式 head。 */
  private propose(input: InteractionDesignInputs['propose']): PrototypeCandidateSummary {
    input = { ...input, draft: parsePrototypeDraft(input.draft) }
    /** 当前原型提交点。 */
    const head = this.head(input.prototypeId)
    /** 所有候选都必须有真实基线，包含整模块任务及恢复后仍存在的历史版本。 */
    const baseline = this.version(input.prototypeId, input.baseRevision)
    this.assertNoDuplicatePages(baseline, input.draft)
    this.assertAssets(input.draft, baseline)
    if (input.jobId) {
      /** 绑定当前任务，拒绝取消后回填或跨会话伪造。 */
      const job = this.job(input.prototypeId, input.jobId)
      if (job.sessionId !== input.sessionId || job.status !== 'running' || job.baseRevision !== input.baseRevision) throw new Error('生成任务已结束或归属不匹配')
      this.assertJobScope(job, input.draft)
      this.assertProjectRestoreScope(job, input.draft)
    }
    /** 不可变候选内容。 */
    const affectedPageIds = this.affectedPages(baseline, input.draft)
    const candidate: PrototypeCandidate = { id: randomUUID(), prototypeId: input.prototypeId, baseRevision: input.baseRevision, draft: structuredClone(input.draft), affectedPageIds, ...(affectedPageIds.length === 1 ? { pageId: affectedPageIds[0] } : {}), summary: input.summary.slice(0, 1000), status: head.revision === input.baseRevision ? 'ready' : 'stale', createdAt: Date.now(), ...(input.jobId ? { jobId: input.jobId } : {}) }
    this.record(input.prototypeId, 'candidates', { ...candidate, draftHash: interactionHash(JSON.stringify(candidate.draft)) })
    this.candidateSummary(candidate)
    if (input.jobId) this.record(input.prototypeId, 'jobs', { ...this.job(input.prototypeId, input.jobId), status: 'candidate' })
    /** 摘要不返回正文。 */
    const { draft: _draft, ...result } = candidate
    return result
  }
  /** 提交候选和采纳候选都复核任务页面范围，不能靠生成期的一次检查。 */
  private assertJobScope(job: PrototypeJob, draft: PrototypeDraft): void {
    if (!job.pageId) return
    /** 固定任务基线。 */
    const baseline = parsePrototypeDraft(this.version(job.prototypeId, job.baseRevision))
    /** 目标页默认正文、附加状态及状态名称可不同；页面名称和目录仍受保护。 */
    const withoutPageContent = (value: PrototypeDraft): string => JSON.stringify({ ...value, pages: value.pages.map(page => page.id === job.pageId ? { ...page, html: '', defaultStateName: undefined, states: undefined, presentation: undefined } : page) })
    if (withoutPageContent(baseline) !== withoutPageContent(draft)) throw new Error('候选修改超出任务页面范围')
  }
  /** 项目还原任务必须按冻结的业务页面清单提交，防止导览页加整套 App 单页冒充拆分。 */
  private assertProjectRestoreScope(job: PrototypeJob, draft: PrototypeDraft): void {
    /** 显式整项目还原始终复核规划；其余任务沿用 pageId 优先的推断，单页越界由前置 assertJobScope 拦截。 */
    if (job.mode !== 'project-restore' && inferPrototypeJobMode(job.instruction, job.pageId) !== 'project-restore') return
    /** 宿主共享校验逻辑，阻断导览页、完整单体和缺页候选。 */
    /** 新任务使用完整规划，旧任务仅保留 pageManifest 兼容读取。 */
    const issues = validateProjectRestoreDraft(draft, job.plan ?? job.pageManifest)
    if (issues.length) throw new Error(`项目还原候选未完成页面拆分：${issues[0]}`)
  }
  /** 确认所有逻辑图片引用已在本项目独立库中存在。 */
  private assertAssets(draft: PrototypeDraft, baseline?: PrototypeDraft): void {
    /** 新正文必须离线完整；既有坏正文仍可读取并通过独立检查报告。 */
    const issues = validatePrototypeContent(draft, baseline)
    if (issues.length) throw new Error(issues[0])
    /** 当前项目已知资产身份。 */
    const known = new Set(this.assets.list().map(asset => asset.id))
    for (const page of draft.pages) {
      for (const html of [page.html, ...(page.states?.map(state => state.html) ?? [])]) {
        for (const match of html.matchAll(/prototype-asset:([A-Za-z0-9_-]+)/g)) {
          if (!known.has(match[1]!)) throw new Error('原型引用了不存在的项目素材')
        }
      }
    }
  }
  /** 读取独立任务并验证归属。 */
  private job(id: string, jobId: string): PrototypeJob {
    assertInteractionId(jobId)
    if (this.historyDeletions(id).jobs.includes(jobId)) throw new Error('生成任务已删除')
    this.head(id)
    /** 当前任务记录。 */
    const job = this.json<PrototypeJob>(join(this.directory(id, 'jobs'), `${jobId}.json`))
    if (job.id !== jobId || job.prototypeId !== id) throw new Error('任务归属不匹配')
    /** 任务文件属于受管数据，重新读取规划时仍执行同一边界解析。 */
    if (job.plan !== undefined) job.plan = parsePrototypePlan(job.plan)
    return job
  }
  /** 类型安全入口；边界 parser 由生产 facade 调用。 */
  async invoke<M extends InteractionDesignMethod>(method: M, input: InteractionDesignInputs[M]): Promise<InteractionDesignResults[M]> {
    /** 服务直调同样执行严格白名单解析，不能绕过 IPC 验证。 */
    const command = parseInteractionDesignCommand({ method, input })
    this.dependencies.assertCurrent?.()
    /** 所有异步来源准备都持有项目 lease，迁移不能在准备和提交之间改根。 */
    const effect = async (): Promise<InteractionDesignResults[M]> => {
      /** 完成后复核授权，迟到读取不能返回给失效会话。 */
      const result = await this.execute(command.method, command.input)
      this.dependencies.assertCurrent?.()
      return result as InteractionDesignResults[M]
    }
    return this.dependencies.withWriteLease ? this.dependencies.withWriteLease(effect) : effect()
  }
  /** 根据受限命令调用对应服务，所有修改都在写 lease 和模块锁内。 */
  private async execute(method: InteractionDesignMethod, input: InteractionDesignInputs[InteractionDesignMethod]): Promise<InteractionDesignResults[InteractionDesignMethod]> {
    switch (method) {
      case 'list': {
        /** 原型根不存在时不创建任何正式数据。 */
        const ids = this.prototypeIds()
        if (!ids.length) return []
        const budget = { remaining: 8 * 1024 * 1024 }
        const summaries = ids.map(id => this.prototypeSummary(id, budget))
        const marker = this.consolidation()
        if (marker) {
          const summary = summaries.find(item => item.id === marker.canonicalId)
          if (!summary) throw new Error('交互模块合并指针指向不存在的正式模块')
          return [summary]
        }
        if (summaries.length > 1) return [await this.consolidatePrototypes(ids, summaries)]
        return summaries
      }
      case 'create': {
        /** 已解析的新建参数。 */
        const request = input as InteractionDesignInputs['create']
        return this.write(() => {
          if (this.hasPrototype()) throw new Error('当前项目已存在交互设计模块，请在现有模块中新增页面')
          /** 新原型稳定身份。 */
          const id = randomUUID()
          /** 页面入口传 pageName 时直接使用用户的页面名，避免先创建容器再生成重复首页。 */
          const pageName = request.pageName ?? '首页'
          /** 页面入口创建的是项目唯一模块，模块名称固定为默认值；Agent 直接创建时仍保留其明确命名。 */
          this.commit(id, 0, { name: request.pageName ? '交互设计' : request.name, platform: request.platform, environment: { schemaVersion: 1, target: request.platform === 'mobile' ? 'ios' : 'web', deviceId: request.platform === 'mobile' ? 'iPhone 17' : '浏览器 Web' }, brief: '', groups: [{ id: 'main', name: '主要页面' }], pages: [createPrototypeBlankPage('home', 'main', pageName, request.platform === 'mobile' ? 'ios' : 'web')], entryPageId: 'home', flows: [] }, request.pageName ? '创建页面' : '创建原型')
          return this.snapshot(id)
        })
      }
      case 'load': return this.snapshot((input as InteractionDesignInputs['load']).prototypeId)
      case 'save': {
        /** 已解析的保存参数。 */
        const request = input as InteractionDesignInputs['save']
        return this.write(() => { this.commit(request.prototypeId, request.baseRevision, request.draft, request.summary); return this.snapshot(request.prototypeId) })
      }
      case 'getVersion': {
        /** 历史读取参数。 */
        const request = input as InteractionDesignInputs['getVersion']
        return this.version(request.prototypeId, request.revision)
      }
      case 'getPageVersions': {
        /** 仅读取版本元数据，不加载页面正文，适合 Agent 查看独立历史。 */
        const request = input as InteractionDesignInputs['getPageVersions']
        return this.pageVersions(request.prototypeId, request.pageId)
      }
      case 'restore': {
        /** 恢复只切换当前 head，不写入新的版本文件。 */
        const request = input as InteractionDesignInputs['restore']
        return this.write(() => {
          /** 读取期 CAS 状态与当前 head，避免旧界面覆盖新提交。 */
          const headPath = join(this.directory(request.prototypeId), 'head.json')
          const state = readAtomicFileState(headPath)
          const head = this.head(request.prototypeId)
          if (!state) throw new Error('原型当前指针记录损坏')
          if (head.revision !== request.baseRevision) throw new Error('原型版本已变化，请重新读取后恢复')
          /** 先完整校验目标版本，再原子切换当前指针。 */
          this.version(request.prototypeId, request.revision)
          writeJsonFileAtomicSecure(headPath, {
            schemaVersion: 1,
            workspaceId: this.dependencies.workspaceId,
            prototypeId: request.prototypeId,
            revision: request.revision,
            latestRevision: head.latestRevision ?? head.revision,
            adopted: head.adopted,
          }, { expectedDestination: { kind: 'state', state } })
          return this.snapshot(request.prototypeId)
        })
      }
      case 'deleteVersion': {
        /** 删除历史版本；当前 head 只允许切换，不允许被删除。 */
        const request = input as InteractionDesignInputs['deleteVersion']
        return this.write(() => {
          /** 模块写锁内复核当前基线，避免旧历史面板删除新上下文中的记录。 */
          const head = this.head(request.prototypeId)
          if (head.revision !== request.baseRevision) throw new Error('原型版本已变化，请重新读取后删除')
          if (request.revision === head.revision) throw new Error('当前版本不能删除')
          if (request.revision > (head.latestRevision ?? head.revision)) throw new Error('原型版本不存在')
          /** 先完整校验历史正文与内容身份，再按文件身份原子删除。 */
          this.version(request.prototypeId, request.revision)
          this.assertVersionUnreferenced(request.prototypeId, request.revision)
          /** 已验证且未被固定交接或运行任务引用的历史文件。 */
          const versionPath = join(this.directory(request.prototypeId, 'revisions'), `${request.revision}.json`)
          /** 删除时的文件身份，防止替换后的条目被误删。 */
          const versionState = readAtomicFileState(versionPath)
          if (!versionState) throw new Error('原型版本不存在')
          removeFileAtomic(versionPath, { expectedIdentity: versionState })
          return this.snapshot(request.prototypeId)
        })
      }
      case 'getCandidateImpact': {
        /** 旧摘要按需比对正文，读取过程绝不补写持久化文件。 */
        const request = input as InteractionDesignInputs['getCandidateImpact']
        /** 已校验正文及归属的候选。 */
        const candidate = this.candidate(request.prototypeId, request.candidateId)
        /** 仅缺失版本允许保守回退，损坏或无权限不能冒充已完成比对。 */
        if (!Number.isSafeInteger(candidate.baseRevision) || candidate.baseRevision < 1) throw new Error('候选基线身份非法')
        const baselinePath = join(this.directory(request.prototypeId, 'revisions'), `${candidate.baseRevision}.json`)
        if (existsSync(baselinePath)) return { pageIds: this.affectedPages(this.version(request.prototypeId, candidate.baseRevision), candidate.draft) }
        if (candidate.jobId) {
          /** 固定候选对应生成任务。 */
          const job = this.job(request.prototypeId, candidate.jobId)
          if (job.pageId) return { pageIds: [job.pageId] }
        }
        /** 当前正式页用于缺失基线时的保守范围。 */
        const current = this.version(request.prototypeId, this.head(request.prototypeId).revision)
        return { pageIds: [...new Set([...candidate.draft.pages, ...current.pages].map(page => page.id))], conservative: true }
      }
      case 'deleteHistory': {
        /** 清理只改变列表可见性；写锁内复核 CAS、运行任务和当前版本保护。 */
        const request = input as InteractionDesignInputs['deleteHistory']
        return this.write(() => {
          /** 写锁内的当前版本事实。 */
          const head = this.head(request.prototypeId)
          if (head.revision !== request.baseRevision) throw new Error('原型版本已变化，请重新读取后删除')
          /** 已有隐藏身份，不覆盖历史清理结果。 */
          const deleted = this.historyDeletions(request.prototypeId)
          /** 同一次原子提交隐藏候选及其关联任务，避免任务重新冒出。 */
          const candidates = request.kind === 'candidate'
            ? [this.candidate(request.prototypeId, request.recordId)]
            : this.candidateSummaries(request.prototypeId, head).filter(candidate => candidate.jobId === request.recordId)
          /** 本次同时隐藏的任务身份。 */
          const jobIds = new Set(candidates.flatMap(candidate => candidate.jobId ? [candidate.jobId] : []))
          if (request.kind === 'job') jobIds.add(request.recordId)
          for (const candidate of candidates) {
            if (head.adopted[candidate.id] === head.revision) throw new Error('当前版本对应候选不能删除')
          }
          for (const jobId of jobIds) {
            if (this.job(request.prototypeId, jobId).status === 'running') throw new Error('运行中的任务请先取消再删除')
          }
          /** 单次原子发布的完整删除索引。 */
          const next: HistoryDeletions = { candidates: [...new Set([...deleted.candidates, ...candidates.map(candidate => candidate.id)])], jobs: [...new Set([...deleted.jobs, ...jobIds])] }
          if (next.candidates.length > 2000 || next.jobs.length > 2000) throw new Error('历史删除数量超过预算')
          /** 已校验项目目录内的固定文件。 */
          const path = join(this.directory(request.prototypeId), 'history-deletions.json')
          /** 写入前的文件身份，用于原子 CAS。 */
          const state = readAtomicFileState(path)
          this.dependencies.assertCurrent?.()
          writeJsonFileAtomicSecure(path, next, { expectedDestination: state ? { kind: 'state', state } : { kind: 'missing' } })
          return this.snapshot(request.prototypeId)
        })
      }
      case 'propose': return this.write(() => this.propose(input as InteractionDesignInputs['propose']))
      case 'getCandidate': {
        /** 候选定位参数。 */
        const request = input as InteractionDesignInputs['getCandidate']
        return this.candidate(request.prototypeId, request.candidateId)
      }
      case 'adopt': {
        /** 显式用户采纳。 */
        const request = input as InteractionDesignInputs['adopt']
        return this.write(() => {
          /** 当前候选与可采纳性。 */
          const candidate = this.candidate(request.prototypeId, request.candidateId)
          if (candidate.status === 'adopted') return this.snapshot(request.prototypeId)
          if (candidate.status !== 'ready' || candidate.baseRevision !== request.baseRevision) throw new Error('候选已过期或不可采纳')
          if (candidate.jobId) {
            /** 候选正文提交与任务终态之间崩溃时，未完成的候选不能被采纳。 */
            const job = this.job(request.prototypeId, candidate.jobId)
            if (job.status !== 'candidate' || job.baseRevision !== candidate.baseRevision) throw new Error('候选对应的生成任务尚未完成或已失效')
            this.assertJobScope(job, candidate.draft)
            this.assertProjectRestoreScope(job, candidate.draft)
          }
          this.commit(request.prototypeId, request.baseRevision, candidate.draft, candidate.summary, candidate.id)
          return this.snapshot(request.prototypeId)
        })
      }
      case 'adoptPage': {
        /** 页面级自动采纳仅替换目标页，允许其他页面先产生独立提交。 */
        const request = input as InteractionDesignInputs['adoptPage']
        return this.write(() => {
          const candidate = this.candidate(request.prototypeId, request.candidateId)
          if (candidate.status === 'adopted') return this.snapshot(request.prototypeId)
          if (candidate.baseRevision !== request.baseRevision) throw new Error('页面候选基线不匹配')
          const baseline = this.version(request.prototypeId, candidate.baseRevision)
          const baselinePage = baseline.pages.find(page => page.id === request.pageId)
          const candidatePage = candidate.draft.pages.find(page => page.id === request.pageId)
          if (!baselinePage || !candidatePage) throw new Error('页面候选目标不存在')
          if (JSON.stringify(baseline.environment) !== JSON.stringify(candidate.draft.environment)) throw new Error('页面候选包含全局设备环境修改，请使用整原型采纳')
          const affected = this.affectedPages(baseline, candidate.draft)
          if (affected.some(pageId => pageId !== request.pageId)) throw new Error('页面候选包含跨页修改，请使用整原型采纳')
          if ((baselinePage.pageRevision ?? 1) !== request.basePageRevision) throw new Error('页面候选基线版本不匹配')
          const head = this.head(request.prototypeId)
          const current = this.version(request.prototypeId, head.revision)
          const currentPage = current.pages.find(page => page.id === request.pageId)
          if (!currentPage || (currentPage.pageRevision ?? 1) !== request.basePageRevision) throw new Error('页面版本已变化，请重新读取后采纳')
          if (candidate.jobId) {
            const job = this.job(request.prototypeId, candidate.jobId)
            if (job.status !== 'candidate' || job.baseRevision !== candidate.baseRevision) throw new Error('候选对应的生成任务尚未完成或已失效')
            this.assertJobScope(job, candidate.draft)
            this.assertProjectRestoreScope(job, candidate.draft)
          }
          const merged: PrototypeDraft = { ...current, pages: current.pages.map(page => page.id === request.pageId ? candidatePage : page) }
          this.commit(request.prototypeId, head.revision, merged, candidate.summary, candidate.id)
          return this.snapshot(request.prototypeId)
        })
      }
      case 'comparePage': {
        /** 对比读取不写入正式数据，也不执行候选脚本。 */
        return this.comparePage(input as InteractionDesignInputs['comparePage'])
      }
      case 'discardCandidate': {
        /** 显式放弃候选。 */
        const request = input as InteractionDesignInputs['discardCandidate']
        return this.write(() => {
          /** 当前候选。 */
          const candidate = this.candidate(request.prototypeId, request.candidateId)
          if (candidate.status === 'adopted') throw new Error('已采纳候选不能放弃')
          this.record(request.prototypeId, 'candidates', { ...candidate, status: 'discarded', draftHash: interactionHash(JSON.stringify(parsePrototypeDraft(candidate.draft))) })
          this.candidateSummary({ ...candidate, status: 'discarded' })
          return this.snapshot(request.prototypeId)
        })
      }
      case 'beginJob': {
        /** 生成任务输入。 */
        const request = input as InteractionDesignInputs['beginJob']
        return this.write(() => {
          if (this.head(request.prototypeId).revision !== request.baseRevision) throw new Error('生成基线已变化')
          if (request.mode === 'project-restore' && (!request.plan || request.plan.pages.length < 2)) throw new Error('项目还原任务必须先提交至少两个业务页面的页面规划')
          /** 验证范围来自实际基线，不接受不存在的页面。 */
          const baseline = this.version(request.prototypeId, request.baseRevision)
          if (request.pageId && !baseline.pages.some(page => page.id === request.pageId)) throw new Error('任务页面不存在')
          if (request.elementId) {
            /** 元素引用提供修改上下文，实际候选隔离边界仍为所属页面。 */
            const page = baseline.pages.find(value => value.id === request.pageId)
            /** 逐状态扫描元素，避免为检查额外拼接全部正文。 */
            const elementPattern = new RegExp(`data-prototype-element\\s*=\\s*["']${request.elementId}["']`, 'i')
            if (!page || ![page.html, ...(page.states?.map(state => state.html) ?? [])].some(html => elementPattern.test(html))) throw new Error('任务元素在指定页面不存在')
          }
          /** 已固定任务所属会话和范围。 */
          const job: PrototypeJob = { ...request, id: randomUUID(), status: 'running', createdAt: Date.now(), ...(request.elementId ? { message: '元素引用已固定，候选变更保护范围为所属页面' } : {}) }
          this.record(request.prototypeId, 'jobs', job)
          return job
        })
      }
      case 'cancelJob': case 'failJob': {
        /** 结束任务但不修改正式原型。 */
        const request = input as InteractionDesignInputs['failJob']
        return this.write(() => {
          /** 当前任务身份。 */
          const job = this.job(request.prototypeId, request.jobId)
          if (job.sessionId !== request.sessionId) throw new Error('任务会话不匹配')
          if (job.status === 'running') this.record(request.prototypeId, 'jobs', { ...job, status: method === 'cancelJob' ? 'cancelled' : 'failed', message: request.message?.slice(0, 1000) })
          return method === 'cancelJob' ? this.snapshot(request.prototypeId) : this.job(request.prototypeId, request.jobId)
        })
      }
      case 'importAsset': {
        /** 本项目图片来源。 */
        const request = input as InteractionDesignInputs['importAsset']
        this.head(request.prototypeId)
        /** 在安全来源读取之后复制到独立资产库。 */
        const bytes = await this.sources.bytes(request.relativePath, MAX_INTERACTION_IMAGE_BYTES)
        return this.write(() => { this.head(request.prototypeId); return this.assets.import(bytes, basename(request.relativePath)) })
      }
      case 'importMediaAsset': {
        /** 可信媒体引用，不能接受 renderer 绝对路径。 */
        const request = input as InteractionDesignInputs['importMediaAsset']
        this.head(request.prototypeId)
        if (!this.dependencies.readMediaAsset) throw new Error('媒体导入尚未授权')
        /** 后端验证引用后获得的图片字节。 */
        const bytes = Buffer.from(await this.dependencies.readMediaAsset({ assetId: request.assetId, revision: request.revision, hash: request.hash, mediaKind: 'image' }))
        return this.write(() => { this.head(request.prototypeId); return this.assets.import(bytes, request.assetId, request.hash) })
      }
      case 'assetContent': {
        /** 独立资产定位参数。 */
        const request = input as InteractionDesignInputs['assetContent']
        this.head(request.prototypeId)
        return this.assets.content(request.assetId)
      }
      case 'inspectProject': return this.sources.inspect()
      case 'readSource': return this.sources.read((input as InteractionDesignInputs['readSource']).paths)
      case 'importHtml': return this.importHtml(input as InteractionDesignInputs['importHtml'])
      case 'exportHtml': {
        /** 导出固定版本，不读取后来改变的 head 正文。 */
        const request = input as InteractionDesignInputs['exportHtml']
        /** 固定的版本完整文档。 */
        const document = this.version(request.prototypeId, request.revision)
        return this.write(() => createInteractionDelivery(document, this.assets, this.directory(request.prototypeId, 'deliveries', true)))
      }
      case 'createHandoff': {
        /** 开发交接固定读取调用方指定版本，不跟随之后的 head 变化。 */
        const request = input as InteractionDesignInputs['createHandoff']
        return this.write(() => {
          /** 读取基线与登记引用共享模块锁，不能与版本删除交错。 */
          const document = this.version(request.prototypeId, request.revision)
          return createInteractionHandoff(document, this.assets, this.directory(request.prototypeId, 'deliveries', true))
        })
      }
      case 'validate': case 'recordExperience': {
        /** 验证证据严格绑定明确版本。 */
        const request = input as InteractionDesignInputs['recordExperience']
        return this.write(() => {
          /** 被验证的不可变文档。 */
          const document = this.version(request.prototypeId, request.revision)
          /** 结构检查只报告结构事实。 */
          const issues = method === 'validate' ? [...validatePrototypeStructure(document), ...validatePrototypeContent(document)] : []
          /** 用户声明实际访问过的页面顺序，不推断未访问覆盖。 */
          const visitedPageIds = method === 'recordExperience' ? request.visitedPageIds : []
          if (visitedPageIds.some(id => !document.pages.some(page => page.id === id))) throw new Error('体验记录包含不存在的页面')
          /** 持久证据。 */
          const check: PrototypeCheck = { id: randomUUID(), revision: request.revision, kind: method === 'validate' ? 'structure' : 'experience', passed: issues.length === 0 && (method === 'validate' || visitedPageIds.length > 0), issues, visitedPageIds, createdAt: Date.now() }
          this.record(request.prototypeId, 'checks', check)
          return check
        })
      }
    }
  }
  /** 把静态 HTML 与本地相对依赖转为独立候选，读取失败不覆盖原稿。 */
  private async importHtml(request: InteractionDesignInputs['importHtml']): Promise<PrototypeCandidateSummary> {
    /** 固定来源版本。 */
    const document = this.version(request.prototypeId, request.baseRevision)
    /** Agent 的整页导入必须绑定独立 HTML 任务，项目还原任务只能走页面清单候选。 */
    /** 可选的独立 HTML 任务记录；UI 直接导入时没有该字段。 */
    const job = request.jobId ? this.job(request.prototypeId, request.jobId) : undefined
    if (job) {
      if (job.sessionId !== request.sessionId || job.status !== 'running' || job.baseRevision !== request.baseRevision) throw new Error('生成任务已结束或归属不匹配')
      if (job.mode !== 'design' || isProjectRestoreInstruction(job.instruction)) throw new Error('整页 HTML 导入只允许独立页面设计任务；项目还原任务必须先完成页面拆分，再调用 prototype_propose')
    }
    /** 页面源 HTML。 */
    const original = await this.sources.text(request.relativePath)
    /** 递归闭包剩余总预算。 */
    let remaining = 4 * 1024 * 1024
    /** 已读取的依赖去重与循环检测。 */
    const active = new Set<string>()
    /** 解析并复制相对依赖，拒绝网络与项目越界。 */
    const dependency = async (url: string, source: string, depth: number): Promise<string> => {
      if (/^(?:data:|#|prototype-asset:)/i.test(url)) return url
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(url) || depth > 6) throw new Error('导入依赖必须是有界的本地相对资源')
      /** 去除查询与锚点后的实际相对依赖位置。 */
      const path = posix.normalize(posix.join(posix.dirname(source), decodeURIComponent(url.split(/[?#]/, 1)[0]!)))
      if (active.has(path)) throw new Error('导入依赖形成循环')
      active.add(path)
      try {
        if (/\.css$/i.test(path)) {
          /** 原始 CSS。 */
          let css = await this.sources.text(path, Math.min(remaining, 512 * 1024))
          remaining -= Buffer.byteLength(css)
          /** 将 CSS @import 递归内联，预览 CSP 不需要开放外部样式源。 */
          const imports = [...css.matchAll(/@import\s+(?:url\(\s*(['"]?)(.*?)\1\s*\)|(['"])(.*?)\3)\s*([^;]*);/gi)]
          for (const imported of imports) {
            /** 已打包的子样式数据。 */
            const resource = await dependency(imported[2] ?? imported[4]!, path, depth + 1)
            if (!resource.startsWith('data:text/css;base64,')) throw new Error('CSS import 只能引用本地样式')
            /** 子样式实际正文。 */
            const content = Buffer.from(resource.slice('data:text/css;base64,'.length), 'base64').toString('utf8')
            css = css.replace(imported[0], imported[5]?.trim() ? `@media ${imported[5]} {${content}}` : content)
          }
          /** CSS 相对图片和字体引用；字体暂不准入，避免错误导出。 */
          const matches = [...css.matchAll(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi)]
          for (const match of matches) {
            /** CSS data URL 内必须使用可独立解析的图片数据。 */
            const resource = await dependency(match[2]!, path, depth + 1)
            css = css.replace(match[0], `url("${resource.startsWith('prototype-asset:') ? this.assets.content(resource.slice(16)).dataUrl : resource}")`)
          }
          return `data:text/css;base64,${Buffer.from(css).toString('base64')}`
        }
        if (/\.[cm]?js$/i.test(path)) {
          /** 只支持独立脚本，ES module 依赖必须先打包。 */
          const script = await this.sources.text(path, Math.min(remaining, 512 * 1024))
          remaining -= Buffer.byteLength(script)
          if (/\b(?:import\s*(?:[('"*{]|\w)|export\s)/.test(script)) throw new Error('导入脚本包含模块依赖，请先构建静态 HTML')
          return `data:text/javascript;base64,${Buffer.from(script).toString('base64')}`
        }
        if (/\.woff2?$/i.test(path)) {
          /** 字体作为当前页面内嵌资源保存，保持离线字体一致。 */
          const font = await this.sources.bytes(path, Math.min(remaining, 2 * 1024 * 1024))
          remaining -= font.length
          /** 标准 WOFF/WOFF2 文件头。 */
          const signature = font.subarray(0, 4).toString('ascii')
          if (signature !== 'wOFF' && signature !== 'wOF2') throw new Error('字体文件格式无效')
          return `data:font/${signature === 'wOF2' ? 'woff2' : 'woff'};base64,${font.toString('base64')}`
        }
        /** 其余资源只允许经过魔数检查的图片。 */
        const bytes = await this.sources.bytes(path, Math.min(remaining, MAX_INTERACTION_IMAGE_BYTES))
        remaining -= bytes.length
        /** 保存独立图片，不因 Canvas 清理而失效。 */
        const asset = await this.write(() => this.assets.import(bytes, basename(path)))
        return `prototype-asset:${asset.id}`
      } finally { active.delete(path) }
    }
    /** 改写的候选 HTML。 */
    let html = original.replace(/<(img|script|link|source)\b[^>]*>/gi, tag => tag.replace(/\b(src|href)\s*=\s*([^\s"'=<>`]+)/gi, (_attribute, name: string, value: string) => `${name}="${value}"`))
    /** 只改写资源属性，普通链接稍后显式处理。 */
    const matches = [...html.matchAll(/<(img|script|link|source)\b[^>]*?\b(src|href)\s*=\s*(['"])(.*?)\3[^>]*>/gi)]
    for (const match of matches) {
      /** 经依赖闭包复制的资源引用。 */
      const replacement = await dependency(match[4]!, request.relativePath, 0)
      if (match[1]!.toLowerCase() === 'script' && replacement.startsWith('data:text/javascript;base64,')) {
        /** 脚本内联以匹配隔离预览 CSP。 */
        const content = Buffer.from(replacement.slice('data:text/javascript;base64,'.length), 'base64').toString('utf8')
        if (/<\/script/i.test(content)) throw new Error('脚本包含无法安全内联的结束标签')
        html = html.replace(match[0], `<script>${content}`)
      } else if (match[1]!.toLowerCase() === 'link' && replacement.startsWith('data:text/css;base64,')) {
        /** 样式内联，避免 data URL 样式被隔离策略拦截。 */
        const content = Buffer.from(replacement.slice('data:text/css;base64,'.length), 'base64').toString('utf8')
        if (/<\/style/i.test(content)) throw new Error('样式包含无法安全内联的结束标签')
        html = html.replace(match[0], `<style>${content}</style>`)
      } else html = html.replace(match[0], match[0].replace(`${match[3]}${match[4]}${match[3]}`, `${match[3]}${replacement}${match[3]}`))
    }
    if (/\bsrcset\s*=|<base\b|<iframe\b|<object\b|<embed\b/i.test(html)) throw new Error('HTML 包含尚未支持的嵌入或响应式资源，请先生成独立静态页面')
    /** 页面内 CSS 同样不能留下失效的相对资源。 */
    const inlineUrls = [...html.matchAll(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi)]
    for (const match of inlineUrls) html = html.replace(match[0], `url("${await dependency(match[2]!, request.relativePath, 0)}")`)
    /** 目标分组不存在时拒绝，不隐式修改目录。 */
    const groupId = request.groupId ?? document.groups[0]?.id
    if (!groupId || !document.groups.some(group => group.id === groupId)) throw new Error('导入目标分组不存在')
    /** 新页面稳定身份。 */
    const id = randomUUID()
    return this.write(() => this.propose({ ...request, draft: { ...document, pages: [...document.pages, { id, groupId, name: basename(request.relativePath), html, source: { path: request.relativePath, hash: interactionHash(original), kind: 'html' } }] }, summary: `导入 ${basename(request.relativePath)}` }))
  }
}
