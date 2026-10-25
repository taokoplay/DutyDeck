import type { PluginCapabilityClient } from '@dutydeck/plugin-sdk'
import {
  adoptCandidate,
  createPrototypeDocument,
  proposePageCandidate,
  summarizePrototype,
  type AdoptCandidateInput,
  type CreatePrototypeInput,
  type ProposePageInput,
  type PrototypeCandidate,
  type PrototypeClock,
  type PrototypeDocument,
  type PrototypeSummary,
} from './domain'

/** 插件只使用一个项目级 artifact，避免在宿主内注册交互设计专用存储。 */
const PROTOTYPE_ARTIFACT_ID = 'workspace'
const ARTIFACT_SCHEMA_VERSION = 1

/** 宿主 artifact.read 的公开记录。 */
interface ArtifactRecord {
  schemaVersion: number
  revision: number
  updatedAt: number
  value: unknown
}

/** 当前原型的完整读取结果。 */
export interface PrototypeReadResult {
  artifactRevision: number
  updatedAt: number
  prototype: PrototypeDocument
}

/** 空项目列表结果。 */
export interface PrototypeListResult {
  prototype: PrototypeSummary | null
  revision: number
}

/** 创建结果与正式读取共享 artifact 身份。 */
export interface PrototypeCreateResult extends PrototypeReadResult {}

/** 候选提交结果。 */
export interface PrototypeProposeResult {
  candidate: PrototypeCandidate
  revision: number
  updatedAt: number
}

/** 局部复用的项目源码读取输出。 */
export interface PrototypeSourceResult {
  path: string
  content: string
  contentHash: string
  byteSize: number
}

/** runtime 工具与 Surface 共用的交互设计试点服务。 */
export interface InteractionDesignPilotService {
  list(): Promise<PrototypeListResult>
  read(): Promise<PrototypeReadResult | null>
  create(input: unknown): Promise<PrototypeCreateResult>
  propose(input: unknown): Promise<PrototypeProposeResult>
  adopt(input: unknown): Promise<PrototypeReadResult>
  readSource(input: unknown): Promise<PrototypeSourceResult>
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 严格校验宿主 artifact 返回，插件不接受缺失旧字段的猜测状态。 */
function parseArtifactRecord(value: unknown): ArtifactRecord | null {
  if (value === null) return null
  if (!isRecord(value)
    || value.schemaVersion !== ARTIFACT_SCHEMA_VERSION
    || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 1
    || typeof value.updatedAt !== 'number'
    || !Number.isFinite(value.updatedAt)
    || !Object.hasOwn(value, 'value')) {
    throw new Error('原型 artifact 返回值无效')
  }
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    revision: Number(value.revision),
    updatedAt: value.updatedAt,
    value: value.value,
  }
}

/** 校验正式原型文档的最小身份，正文内容由领域函数继续约束。 */
function isPrototypeDocument(value: unknown): value is PrototypeDocument {
  if (!isRecord(value)) return false
  const pages = value.pages
  const candidates = value.candidates
  return value.schemaVersion === 1
    && Number.isSafeInteger(value.revision)
    && Number(value.revision) >= 1
    && typeof value.name === 'string'
    && (value.platform === 'mobile' || value.platform === 'desktop')
    && typeof value.entryPageId === 'string'
    && Array.isArray(pages)
    && pages.length > 0
    && pages.every(page => isRecord(page)
      && typeof page.id === 'string'
      && typeof page.name === 'string'
      && typeof page.html === 'string'
      && Number.isSafeInteger(page.pageRevision)
      && typeof page.updatedAt === 'number')
    && Array.isArray(candidates)
    && candidates.every(candidate => isRecord(candidate)
      && typeof candidate.id === 'string'
      && Number.isSafeInteger(candidate.baseRevision)
      && typeof candidate.pageId === 'string'
      && typeof candidate.name === 'string'
      && typeof candidate.html === 'string'
      && typeof candidate.summary === 'string'
      && (candidate.status === 'ready' || candidate.status === 'adopted'))
    && typeof value.createdAt === 'number'
    && typeof value.updatedAt === 'number'
}

/** 校验宿主 artifact revision 与文档 revision 始终一致。 */
function parsePrototypeRecord(value: unknown): PrototypeReadResult | null {
  const artifact = parseArtifactRecord(value)
  if (!artifact) return null
  if (!isPrototypeDocument(artifact.value) || artifact.value.revision !== artifact.revision) {
    throw new Error('原型 artifact 身份不一致')
  }
  return {
    artifactRevision: artifact.revision,
    updatedAt: artifact.updatedAt,
    prototype: artifact.value,
  }
}

/** 读取并校验创建原型输入。 */
function parseCreateInput(value: unknown): CreatePrototypeInput {
  if (!isRecord(value)
    || Object.keys(value).some(key => !['name', 'platform', 'html'].includes(key))
    || typeof value.name !== 'string'
    || typeof value.html !== 'string'
    || (value.platform !== 'mobile' && value.platform !== 'desktop')) {
    throw new Error('创建原型输入无效')
  }
  return { name: value.name, platform: value.platform, html: value.html }
}

/** 读取并校验候选提交输入。 */
function parseProposeInput(value: unknown): ProposePageInput {
  if (!isRecord(value)
    || Object.keys(value).some(key => !['baseRevision', 'pageId', 'name', 'html', 'summary'].includes(key))
    || !Number.isSafeInteger(value.baseRevision)
    || typeof value.pageId !== 'string'
    || typeof value.name !== 'string'
    || typeof value.html !== 'string'
    || typeof value.summary !== 'string') {
    throw new Error('原型候选输入无效')
  }
  return {
    baseRevision: Number(value.baseRevision),
    pageId: value.pageId,
    name: value.name,
    html: value.html,
    summary: value.summary,
  }
}

/** 读取并校验候选采纳输入。 */
function parseAdoptInput(value: unknown): AdoptCandidateInput {
  if (!isRecord(value)
    || Object.keys(value).some(key => !['baseRevision', 'candidateId'].includes(key))
    || !Number.isSafeInteger(value.baseRevision)
    || typeof value.candidateId !== 'string') {
    throw new Error('候选采纳输入无效')
  }
  return { baseRevision: Number(value.baseRevision), candidateId: value.candidateId }
}

/** 读取并校验源码读取输入。 */
function parseSourceInput(value: unknown): { path: string; maxBytes: number } {
  if (!isRecord(value)
    || Object.keys(value).some(key => !['path', 'maxBytes'].includes(key))
    || typeof value.path !== 'string'
    || !Number.isSafeInteger(value.maxBytes)
    || Number(value.maxBytes) < 1
    || Number(value.maxBytes) > 1024 * 1024) {
    throw new Error('源码读取输入无效')
  }
  return { path: value.path, maxBytes: Number(value.maxBytes) }
}

/** 校验源码读取结果，避免把宿主异常对象透给模型。 */
function parseSourceResult(value: unknown): PrototypeSourceResult {
  if (!isRecord(value)
    || typeof value.path !== 'string'
    || typeof value.content !== 'string'
    || typeof value.contentHash !== 'string'
    || !Number.isSafeInteger(value.byteSize)) {
    throw new Error('源码读取结果无效')
  }
  return {
    path: value.path,
    content: value.content,
    contentHash: value.contentHash,
    byteSize: Number(value.byteSize),
  }
}

/**
 * 创建插件业务服务；artifact CAS 和项目授权仍由宿主提供。
 * @param capabilities 当前工具或 Surface invocation 的能力客户端。
 * @param clock 时间和候选 ID 来源。
 */
export function createInteractionDesignPilotService(
  capabilities: PluginCapabilityClient,
  clock: PrototypeClock,
): InteractionDesignPilotService {
  /** 读取当前项目的唯一原型 artifact。 */
  const readRecord = async (): Promise<PrototypeReadResult | null> => {
    const raw = await capabilities.request<unknown>('artifact.read', {
      artifactId: PROTOTYPE_ARTIFACT_ID,
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
    })
    return parsePrototypeRecord(raw)
  }
  /** 以当前 artifact revision 做 CAS 并返回宿主确认的新版本。 */
  const writeDocument = async (document: PrototypeDocument, expectedRevision: number): Promise<{
    revision: number
    updatedAt: number
  }> => {
    const raw = await capabilities.request<unknown>('artifact.write', {
      artifactId: PROTOTYPE_ARTIFACT_ID,
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      expectedRevision,
      value: document,
    })
    if (!isRecord(raw)
      || !Number.isSafeInteger(raw.revision)
      || Number(raw.revision) < 1
      || typeof raw.updatedAt !== 'number') {
      throw new Error('原型写入结果无效')
    }
    return { revision: Number(raw.revision), updatedAt: raw.updatedAt }
  }
  return {
    async list() {
      const current = await readRecord()
      return current
        ? { prototype: summarizePrototype(current.prototype), revision: current.artifactRevision }
        : { prototype: null, revision: 0 }
    },
    read: readRecord,
    async create(value) {
      const input = parseCreateInput(value)
      if (await readRecord()) throw new Error('当前项目已经存在原型')
      const document = createPrototypeDocument(input, clock)
      const written = await writeDocument(document, 0)
      return {
        artifactRevision: written.revision,
        updatedAt: written.updatedAt,
        prototype: { ...document, revision: written.revision },
      }
    },
    async propose(value) {
      const input = parseProposeInput(value)
      const current = await readRecord()
      if (!current) throw new Error('当前项目尚无原型')
      const result = proposePageCandidate(current.prototype, input, clock)
      const written = await writeDocument(result.document, current.artifactRevision)
      return {
        candidate: result.candidate,
        revision: written.revision,
        updatedAt: written.updatedAt,
      }
    },
    async adopt(value) {
      const input = parseAdoptInput(value)
      const current = await readRecord()
      if (!current) throw new Error('当前项目尚无原型')
      const document = adoptCandidate(current.prototype, input, clock)
      const written = await writeDocument(document, current.artifactRevision)
      return {
        artifactRevision: written.revision,
        updatedAt: written.updatedAt,
        prototype: document,
      }
    },
    async readSource(value) {
      const input = parseSourceInput(value)
      return parseSourceResult(await capabilities.request<unknown>('project.files.read', input))
    },
  }
}
