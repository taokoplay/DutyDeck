import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { assertVisualProductionId, VISUAL_PRODUCTION_STORAGE_SEGMENTS } from '@dutydeck/shared'
import { interactionDirectory, readInteractionFile } from '../interaction-design/paths'
import { readAtomicFileState, writeJsonFileAtomicSecure } from '../safe-file'
import type { VisualContextObservation, VisualContextEvidenceStore } from './task-context'

/** 每个运行分片的检查摘要数量有界；达到预算拒绝新增，不静默删除可追溯记录。 */
const MAX_OBSERVATIONS = 100
/** 单文件硬上限兼顾恢复时资源开销与长期可追溯摘要。 */
const MAX_STORE_BYTES = 2 * 1024 * 1024
/** 检查持久记录的基本身份与边界，损坏文件不隐式提供历史授权。 */
function isObservation(value: unknown): value is VisualContextObservation {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.version === 1 && ['id', 'workspaceId', 'sessionId', 'runId', 'contextId', 'productionId', 'scopeKey', 'objective', 'conclusion'].every(key => typeof record[key] === 'string')
    && Number.isSafeInteger(record.productionRevision) && typeof record.createdAt === 'number'
    && Array.isArray(record.unchecked) && record.unchecked.length <= 32 && record.unchecked.every(item => typeof item === 'string' && item.length <= 1000)
    && Array.isArray(record.evidence) && record.evidence.length <= 32 && record.evidence.every(item => item && typeof item === 'object' && typeof item.mediaId === 'string' && typeof item.mediaHash === 'string' && typeof item.evidenceId === 'string')
    && typeof record.objective === 'string' && record.objective.length <= 2000 && typeof record.conclusion === 'string' && record.conclusion.length <= 8000
}
/** scope 目录仅接受完整 SHA-256；runId 使用安全单级标识。 */
function assertScope(scopeKey: string, runId?: string): void {
  if (!/^[a-f0-9]{64}$/.test(scopeKey)) throw new Error('VISUAL_CONTEXT_INVALID_SCOPE')
  if (runId !== undefined) assertVisualProductionId(runId)
}
/** 每个范围索引只保存有限运行身份，不加载所有历史正文。 */
const MAX_RUNS = 10000
/** 创建固定可信根存储；每个范围/运行独立归档，旧记录不淘汰。 */
export function createVisualContextEvidenceStore(projectRoot: string, assertCurrent: () => void): VisualContextEvidenceStore {
  /** 路径由作品、完整范围hash和可信运行ID组成。 */
  const directoryFor = (productionId: string, scopeKey: string, create = false): string => {
    assertCurrent()
    assertVisualProductionId(productionId)
    assertScope(scopeKey)
    return interactionDirectory(projectRoot, [...VISUAL_PRODUCTION_STORAGE_SEGMENTS, 'projects', productionId, 'visual-observations', scopeKey], create)
  }
  /** 缺失目录意味着无记录；其他边界错误不得当作空库。 */
  const existingDirectory = (productionId: string, scopeKey: string): string | undefined => {
    try { return directoryFor(productionId, scopeKey) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  /** 索引中每项都需校验后才能用于构造文件名。 */
  const readIndex = (directory: string): string[] => {
    const path = join(directory, 'runs.index.json')
    if (!existsSync(path)) return []
    const value: unknown = JSON.parse(readInteractionFile(path, MAX_STORE_BYTES).toString('utf8'))
    if (!Array.isArray(value) || value.length > MAX_RUNS || value.some(item => typeof item !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item)) || new Set(value).size !== value.length) throw new Error('VISUAL_CONTEXT_INDEX_CORRUPT')
    assertCurrent()
    return value as string[]
  }
  /** 单运行读取有硬预算，文件内身份必须与路径完整匹配。 */
  const readRun = (directory: string, productionId: string, scopeKey: string, runId: string): VisualContextObservation[] => {
    assertScope(scopeKey, runId)
    const path = join(directory, `${runId}.json`)
    if (!existsSync(path)) return []
    const value: unknown = JSON.parse(readInteractionFile(path, MAX_STORE_BYTES).toString('utf8'))
    if (!Array.isArray(value) || value.length > MAX_OBSERVATIONS || !value.every(isObservation) || value.some(item => item.productionId !== productionId || item.scopeKey !== scopeKey || item.runId !== runId)) throw new Error('VISUAL_CONTEXT_EVIDENCE_CORRUPT: 检查摘要身份不匹配')
    assertCurrent()
    return value
  }
  return {
    list(productionId, scopeKey, runId) {
      assertScope(scopeKey, runId)
      const directory = existingDirectory(productionId, scopeKey)
      if (!directory) return []
      if (runId !== undefined) return readRun(directory, productionId, scopeKey, runId).slice(-4).reverse()
      const records: VisualContextObservation[] = []
      const runs = readIndex(directory)
      for (let index = runs.length - 1; index >= 0 && records.length < 4; index--) {
        const chunk = readRun(directory, productionId, scopeKey, runs[index]!)
        if (!chunk.length) throw new Error('VISUAL_CONTEXT_INDEX_CORRUPT: 索引指向缺失或空的运行归档')
        records.push(...chunk.slice(-(4 - records.length)).reverse())
      }
      return records
    },
    append(observation) {
      assertScope(observation.scopeKey, observation.runId)
      if (!isObservation(observation)) throw new Error('VISUAL_CONTEXT_EVIDENCE_CORRUPT')
      const directory = directoryFor(observation.productionId, observation.scopeKey, true)
      const indexPath = join(directory, 'runs.index.json')
      const indexState = existsSync(indexPath) ? readAtomicFileState(indexPath) : undefined
      const runs = readIndex(directory)
      if (!runs.includes(observation.runId) && runs.length >= MAX_RUNS) throw new Error('VISUAL_CONTEXT_INDEX_LIMIT: 此范围运行索引已满，原记录全部保留')
      const path = join(directory, `${observation.runId}.json`)
      const state = existsSync(path) ? readAtomicFileState(path) : undefined
      const records = [...readRun(directory, observation.productionId, observation.scopeKey, observation.runId), observation]
      if (records.length > MAX_OBSERVATIONS || Buffer.byteLength(JSON.stringify(records)) > MAX_STORE_BYTES) throw new Error('VISUAL_CONTEXT_EVIDENCE_LIMIT: 本运行记录已满，原结论保留；新运行使用独立归档')
      assertCurrent()
      // 先写分片再发布索引；中途退出的分片仍可用 runId 精确检索，后续追加可修复索引。
      writeJsonFileAtomicSecure(path, records, { expectedDestination: state ? { kind: 'state', state } : { kind: 'missing' } })
      assertCurrent()
      writeJsonFileAtomicSecure(indexPath, [...runs.filter(id => id !== observation.runId), observation.runId], { expectedDestination: indexState ? { kind: 'state', state: indexState } : { kind: 'missing' } })
    },
  }
}
