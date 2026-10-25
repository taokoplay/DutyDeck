/** 试点插件支持的设备类型，与宿主交互设计模块的公开取值保持一致。 */
export type PrototypePlatform = 'mobile' | 'desktop'

/** 插件内单个可点击页面的最小合同。 */
export interface PrototypePage {
  id: string
  name: string
  html: string
  pageRevision: number
  updatedAt: number
}

/** 页面候选只保存完整正文，不直接推进正式页面。 */
export interface PrototypeCandidate {
  id: string
  baseRevision: number
  pageId: string
  name: string
  html: string
  summary: string
  status: 'ready' | 'adopted'
  createdAt: number
}

/** artifact 内保存的交互设计试点文档。 */
export interface PrototypeDocument {
  schemaVersion: 1
  revision: number
  name: string
  platform: PrototypePlatform
  entryPageId: string
  pages: PrototypePage[]
  candidates: PrototypeCandidate[]
  adoptedCandidateId?: string
  createdAt: number
  updatedAt: number
}

/** 插件期望的最小时间与 ID 来源，测试和运行时都可注入。 */
export interface PrototypeClock {
  now(): number
  id(): string
}

/** 首次创建原型的业务输入。 */
export interface CreatePrototypeInput {
  name: string
  platform: PrototypePlatform
  html: string
}

/** 为已有页面提交候选输入。 */
export interface ProposePageInput {
  baseRevision: number
  pageId: string
  name: string
  html: string
  summary: string
}

/** 采纳当前候选输入。 */
export interface AdoptCandidateInput {
  baseRevision: number
  candidateId: string
}

/** 插件返回给 Agent/Surface 的轻量摘要，不包含页面正文。 */
export interface PrototypeSummary {
  name: string
  platform: PrototypePlatform
  revision: number
  pageCount: number
  candidateCount: number
  entryPageId: string
  updatedAt: number
}

/** 页面正文与摘要的上限在插件和宿主两侧保持独立。 */
export const PILOT_PAGE_HTML_LIMIT = 200_000
const PILOT_SUMMARY_LIMIT = 2_000
const PILOT_NAME_LIMIT = 120

/** 校验稳定页面身份，拒绝路径、空值和任意控制字符。 */
function assertPageId(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('页面 ID 无效')
}

/** 校验用户可见名称，并去掉首尾空白。 */
function normalizeName(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label}不能为空`)
  if (normalized.length > PILOT_NAME_LIMIT) throw new Error(`${label}长度无效`)
  return normalized
}

/** 校验页面正文，空文档和超过宿主预算的页面都不能成为候选。 */
function normalizeHtml(value: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error('页面正文不能为空')
  if (Buffer.byteLength(normalized) > PILOT_PAGE_HTML_LIMIT) throw new Error('页面正文超过大小限制')
  if (normalized.includes('\0')) throw new Error('页面正文包含非法字符')
  return value
}

/** 校验 artifact 版本，版本从 1 开始且只能由宿主 CAS 推进。 */
function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('原型 revision 无效')
}

/**
 * 创建插件的首个正式页面。
 * @param input 原型名称、设备类型和首页正文。
 * @param clock 当前时间和稳定 ID 来源。
 * @returns revision 为 1 的不可变业务文档副本。
 */
export function createPrototypeDocument(
  input: CreatePrototypeInput,
  clock: PrototypeClock,
): PrototypeDocument {
  const now = clock.now()
  const name = normalizeName(input.name, '原型名称')
  if (input.platform !== 'mobile' && input.platform !== 'desktop') throw new Error('设备类型无效')
  return {
    schemaVersion: 1,
    revision: 1,
    name,
    platform: input.platform,
    entryPageId: 'home',
    pages: [{
      id: 'home',
      name: '首页',
      html: normalizeHtml(input.html),
      pageRevision: 1,
      updatedAt: now,
    }],
    candidates: [],
    createdAt: now,
    updatedAt: now,
  }
}

/** 返回不包含 HTML 和候选正文的列表摘要。 */
export function summarizePrototype(document: PrototypeDocument): PrototypeSummary {
  return {
    name: document.name,
    platform: document.platform,
    revision: document.revision,
    pageCount: document.pages.length,
    candidateCount: document.candidates.length,
    entryPageId: document.entryPageId,
    updatedAt: document.updatedAt,
  }
}

/**
 * 为已有页面生成候选；正式页面在采纳前保持不变。
 * @param document 当前正式文档。
 * @param input 候选正文与基线 revision。
 * @param clock 当前时间和候选 ID 来源。
 * @returns 推进一版 artifact 的文档与独立候选。
 */
export function proposePageCandidate(
  document: PrototypeDocument,
  input: ProposePageInput,
  clock: PrototypeClock,
): { document: PrototypeDocument; candidate: PrototypeCandidate } {
  assertRevision(input.baseRevision)
  if (input.baseRevision !== document.revision) throw new Error('原型版本已变化，请重新读取后修改')
  assertPageId(input.pageId)
  if (!document.pages.some(page => page.id === input.pageId)) throw new Error('页面不存在')
  const id = clock.id()
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('候选 ID 无效')
  if (document.candidates.some(candidate => candidate.id === id)) throw new Error('候选 ID 冲突')
  const now = clock.now()
  const candidate: PrototypeCandidate = {
    id,
    baseRevision: input.baseRevision,
    pageId: input.pageId,
    name: normalizeName(input.name, '页面名称'),
    html: normalizeHtml(input.html),
    summary: input.summary.trim().slice(0, PILOT_SUMMARY_LIMIT),
    status: 'ready',
    createdAt: now,
  }
  const next = structuredClone(document)
  next.revision += 1
  next.updatedAt = now
  next.candidates.unshift(candidate)
  return { document: next, candidate }
}

/**
 * 采纳当前唯一候选并推进页面独立版本。
 * @param document 已完成候选提交的正式文档。
 * @param input 当前 artifact revision 与候选身份。
 * @param clock 当前时间来源。
 * @returns 深拷贝后的新正式文档。
 */
export function adoptCandidate(
  document: PrototypeDocument,
  input: AdoptCandidateInput,
  clock: PrototypeClock,
): PrototypeDocument {
  assertRevision(input.baseRevision)
  if (input.baseRevision !== document.revision) throw new Error('原型版本已变化，请重新读取后修改')
  const index = document.candidates.findIndex(candidate => candidate.id === input.candidateId)
  if (index < 0) throw new Error('候选不存在')
  const candidate = document.candidates[index]!
  if (candidate.status !== 'ready' || candidate.baseRevision + 1 !== input.baseRevision) {
    throw new Error('候选已过期')
  }
  const pageIndex = document.pages.findIndex(page => page.id === candidate.pageId)
  if (pageIndex < 0) throw new Error('候选页面不存在')
  const now = clock.now()
  const next = structuredClone(document)
  const page = next.pages[pageIndex]!
  next.pages[pageIndex] = {
    ...page,
    name: candidate.name,
    html: candidate.html,
    pageRevision: page.pageRevision + 1,
    updatedAt: now,
  }
  next.candidates[index] = { ...next.candidates[index]!, status: 'adopted' }
  next.adoptedCandidateId = candidate.id
  next.revision += 1
  next.updatedAt = now
  return next
}
