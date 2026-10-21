import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { MediaGenerationRequest, MediaGenerationSnapshot } from '@dutydeck/shared'
import { assertVisualProductionId, parseMediaGenerationRequest, parseMediaModelRef } from '@dutydeck/shared'
import { acquireMediaFileLock } from './media-file-lock'
import { readAtomicFileState, readJsonFileStrict, writeJsonFileAtomicSecure } from '../safe-file'
import type { UnifiedMediaRemoteTask, UnifiedMediaVisualProductionBinding } from './unified-media-generation-service'

/** 单任务 JSON 的读写共同预算，防止写出下一次无法读取的记录。 */
const MAX_RECORD_BYTES = 2 * 1024 * 1024

/** 任务磁盘协议仅允许公开输入、身份摘要与结果，不保存供应商路由。 */
export interface StoredMediaGeneration {
  /** 明确的协议版本，旧/未知结构不能被当成可重新提交任务。 */
  version: 1
  /** 已授权的发起会话。 */
  ownerSessionId: string
  /** 经过输入解析器冻结的生成参数。 */
  request: MediaGenerationRequest
  /** 原始输入摘要使重复操作不会因默认值变化另行收费。 */
  intentHash: string
  /** 去除凭据后的配置身份摘要。 */
  routeHash: string
  /** 冻结执行器身份，用于只恢复支持续查的供应商。 */
  adapterId: string
  /** 对外公开的生命周期与资产引用。 */
  snapshot: MediaGenerationSnapshot
  /** 仅允许已校验的供应商任务 ID。 */
  remoteTask?: UnifiedMediaRemoteTask
  /** 可信宿主授予的影像任务绑定。 */
  visualProduction?: UnifiedMediaVisualProductionBinding
}

/** 规范排序后计算摘要，不把原始路由或秘密写进索引。 */
export function mediaIdentityHash(value: unknown): string {
  /** 递归排序对象键，保持输入对象不同排列仍为同一操作。 */
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize)
    : item !== null && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, normalize(entry)])) : item
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex')
}

/** owner、项目与操作确定任务身份，无需全量扫描或独立索引。 */
export function mediaOperationRunId(ownerSessionId: string, request: MediaGenerationRequest): string {
  const hash = mediaIdentityHash([ownerSessionId, request.projectId, request.operationId])
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`
}

/** 校验并投影远端任务，拒绝携带 URL、响应体或凭据的额外对象。 */
export function parseMediaRemoteTask(value: unknown): UnifiedMediaRemoteTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MEDIA_REMOTE_TASK_INVALID')
  const task = value as Record<string, unknown>
  if (Object.keys(task).length !== 1 || typeof task.taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(task.taskId)) throw new Error('MEDIA_REMOTE_TASK_INVALID')
  return { taskId: task.taskId }
}

/** 校验全部已保存字段，任何损坏均拒绝执行，不能回退到 prepared 重发。 */
function isStoredMediaGeneration(value: unknown): value is StoredMediaGeneration {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const record = value as StoredMediaGeneration
    if (Object.keys(record).some(key => !['version', 'ownerSessionId', 'request', 'intentHash', 'routeHash', 'adapterId', 'snapshot', 'remoteTask', 'visualProduction'].includes(key))) return false
    if (record.version !== 1 || typeof record.ownerSessionId !== 'string' || !record.ownerSessionId || record.ownerSessionId.length > 256
      || !/^[a-f0-9]{64}$/.test(record.intentHash) || !/^[a-f0-9]{64}$/.test(record.routeHash)
      || typeof record.adapterId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(record.adapterId)) return false
    const request = parseMediaGenerationRequest(record.request)
    if (Object.values(request.inputs).some(input => input.kind === 'scalar' && typeof input.value === 'number' && !Number.isFinite(input.value))) return false
    const snapshot = record.snapshot
    if (!snapshot || Object.keys(snapshot).some(key => !['id', 'projectId', 'revision', 'phase', 'modelRef', 'mediaKind', 'createdAt', 'updatedAt', 'outputs', 'error'].includes(key))
      || snapshot.id !== mediaOperationRunId(record.ownerSessionId, request)
      || snapshot.projectId !== request.projectId || snapshot.modelRef !== request.modelRef
      || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
      || !['prepared', 'queued', 'running', 'unknown', 'succeeded', 'failed', 'cancelled'].includes(snapshot.phase)
      || snapshot.mediaKind !== parseMediaModelRef(request.modelRef).kind
      || !Number.isFinite(snapshot.createdAt) || !Number.isFinite(snapshot.updatedAt)
      || !(snapshot.error === null || typeof snapshot.error === 'string' && snapshot.error.length <= 4096)
      || !Array.isArray(snapshot.outputs) || snapshot.outputs.length > 128) return false
    for (const output of snapshot.outputs) {
      if (!output || Object.keys(output).length !== 2 || typeof output.outputKey !== 'string' || !output.outputKey || output.outputKey.length > 256) return false
      parseMediaGenerationRequest({ ...request, inputs: { output: { kind: 'asset', asset: output.asset } } })
      if (output.asset.mediaKind !== snapshot.mediaKind) return false
    }
    if (record.remoteTask) parseMediaRemoteTask(record.remoteTask)
    if (record.visualProduction) {
      if (Object.keys(record.visualProduction).length !== 3) return false
      assertVisualProductionId(record.visualProduction.productionId)
      assertVisualProductionId(record.visualProduction.jobId)
      if (!Number.isSafeInteger(record.visualProduction.baseRevision) || record.visualProduction.baseRevision < 1) return false
    }
    return true
  } catch { return false }
}

/** 宿主指定目录中的单任务原子存储；不扫描、不保存备份旧状态，避免已提交任务回滚重发。 */
export class UnifiedMediaGenerationStore {
  constructor(private readonly directory: string) {}

  /** 懒读取指定任务，严格校验所有权和磁盘身份。 */
  load(ownerSessionId: string, runId: string): StoredMediaGeneration | null {
    const record = readJsonFileStrict<StoredMediaGeneration>(this.path(runId), { validate: isStoredMediaGeneration, maxBytes: MAX_RECORD_BYTES, description: '媒体任务', secureRecovery: true })
    if (record && (record.ownerSessionId !== ownerSessionId || record.snapshot.id !== runId)) throw new Error('MEDIA_GENERATION_NOT_OWNED')
    return record
  }

  /** 提交下一版状态，revision 校验阻止陈旧实例再次提交同一任务。 */
  save(record: StoredMediaGeneration, expectedRevision: number | null): void {
    if (!isStoredMediaGeneration(record) || Buffer.byteLength(JSON.stringify(record), 'utf8') > MAX_RECORD_BYTES) throw new Error('MEDIA_GENERATION_STORAGE_INVALID')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const path = this.path(record.snapshot.id)
    /** 复用媒体层跨进程锁，覆盖读取/CAS/rename 整个窗口，避免并发提交双重收费。 */
    const release = acquireMediaFileLock(join(this.directory, `${record.snapshot.id}.lock`))
    try {
      const state = readAtomicFileState(path)
      const previous = this.load(record.ownerSessionId, record.snapshot.id)
      if (expectedRevision === null ? previous !== null : previous?.snapshot.revision !== expectedRevision) throw new Error('MEDIA_GENERATION_REVISION_CONFLICT')
      /** 绑定与远端身份写入不推进快照版本，故另行禁止陈旧实例清除不可变事实。 */
      if (previous?.visualProduction && mediaIdentityHash(previous.visualProduction) !== mediaIdentityHash(record.visualProduction ?? null)) throw new Error('MEDIA_VISUAL_BINDING_CONFLICT')
      if (previous?.remoteTask && previous.remoteTask.taskId !== record.remoteTask?.taskId) throw new Error('MEDIA_REMOTE_TASK_CONFLICT')
      writeJsonFileAtomicSecure(path, record, { expectedDestination: state ? { kind: 'state', state } : { kind: 'missing' } })
    } finally { release() }
  }

  /** 严格限制路径片段，不允许 owner 或请求参数进入文件系统路径。 */
  private path(runId: string): string {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runId)) throw new Error('MEDIA_GENERATION_NOT_OWNED')
    return join(this.directory, `${runId}.json`)
  }
}
