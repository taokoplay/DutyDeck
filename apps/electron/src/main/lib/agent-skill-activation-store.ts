import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SDKMessage, SDKUserMessage, SkillActivation } from '@dutydeck/shared'
import {
  SKILL_ACTIVATION_STORE_MAX_BYTES,
  SKILL_ACTIVATION_STORE_MAX_ENTRIES,
  mergeSkillActivationStore,
  parseSkillActivationStore,
  projectSkillActivations,
} from '../../../../../packages/session-core/src/skill-activation-projection'
import type { SkillActivationStoreData } from '../../../../../packages/session-core/src/skill-activation-projection'
import { readAtomicFileState, removeFileAtomic, writeJsonFileAtomicSecure } from './safe-file'
import type { AtomicFileState } from './safe-file'

/** 单次加载供整页复用；投影无 IO，修改基于该快照进行严格 CAS。 */
export interface SkillActivationStoreSnapshot {
  /** 是否存在可投影条目，供读取侧跳过无旁车页面的投影。 */
  readonly hasEntries: boolean
  /** 宽松展示加载的失败原因；严格加载直接抛出。 */
  readonly readError: Error | null
  /** 此快照已读到或亲自提交的权威字节摘要；null 表示旁车缺失。 */
  readonly fingerprint: string | null
  /** 输入未投影的 normalized SDK 消息，返回合并 Skill 的展示消息。 */
  project(message: SDKMessage): SDKMessage
  /** 输入同一读取快照的原始 SDK user 与补记；无变化不写，冲突抛错。 */
  update(target: SDKUserMessage, additions: SkillActivation[]): void
  /** 完整正文已物化后移除此快照；发现旁车被并发替换则终止裁剪。 */
  removeAfterFold(): void
}
/** 加载选项：业务修改默认严格，历史展示显式选择宽松回退。 */
export interface SkillActivationStoreLoadOptions {
  /** false 时损坏旁车不阻断正文展示，但该快照仍禁止写入。 */
  strict?: boolean
}
/** 一次读取携带的可移植内容指纹和临时文件状态；inode 从不落盘。 */
interface StoreRead {
  /** 纯数据快照。 */
  data: SkillActivationStoreData
  /** 精确字节摘要，用于读取快照与当前权威文件的 CAS。 */
  fingerprint: string | null
  /** 本次打开对象状态，仅用于临时竞态校验。 */
  state: AtomicFileState | null
  /** 原始 JSON 字节数，用于缓存预算。 */
  bytes: number
}
/** 进程内缓存限制：最多 16 个路径、32 MiB 原始 JSON 对应的解析对象。 */
const cache = new Map<string, StoreRead>()
/** 保存最近读取的有效快照，并驱逐最旧记录以限制常驻资源。 */
function remember(path: string, value: StoreRead): void {
  cache.delete(path)
  cache.set(path, value)
  while (cache.size > 16 || [...cache.values()].reduce((sum, item) => sum + item.bytes, 0) > 32 * 1024 * 1024) {
    cache.delete(cache.keys().next().value!)
  }
}
/** 对比读取前后文件状态，防止读到一半的权威文件进入快照。 */
function sameState(left: AtomicFileState | null, right: AtomicFileState | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
/** 只读权威文件，忽略 tmp/bak；拒绝软链与损坏，缺失不创建目录或文件。 */
function readStore(path: string): StoreRead {
  /** 读取前身份来自 no-follow lstat。 */
  const state = readAtomicFileState(path)
  if (!state) {
    cache.delete(path)
    return { data: { version: 1, entries: [] }, fingerprint: null, state: null, bytes: 0 }
  }
  /** 完整 stamp 仅在内存生效，路径重建或修改会使解析缓存失效。 */
  const cached = cache.get(path)
  if (cached && sameState(state, cached.state)) { remember(path, cached); return cached }
  cache.delete(path)
  if (state.size > SKILL_ACTIVATION_STORE_MAX_BYTES) throw new Error('Skill 补记旁车超过字节预算')
  /** no-follow 与非阻塞打开避免软链及 FIFO 置换。 */
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    /** 打开身份与观察到的目标必须一致。 */
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.dev !== state.dev || opened.ino !== state.ino) throw new Error('Skill 补记旁车读取冲突')
    /** 权威字节仅在加载或修改时读取，project 不访问磁盘。 */
    const buffer = Buffer.alloc(Math.min(state.size + 1, SKILL_ACTIVATION_STORE_MAX_BYTES + 1))
    /** 最多读已知长度加一个字节；并发增长直接拒绝，不无界分配。 */
    let length = 0
    while (length < buffer.length) {
      /** 每次读取返回的长度，0 表示文件末尾。 */
      const count = readSync(descriptor, buffer, length, buffer.length - length, null)
      if (count === 0) break
      length += count
    }
    if (length !== state.size) throw new Error('Skill 补记旁车读取冲突或超过预算')
    /** 精确原始字节用于解析和 CAS。 */
    const bytes = buffer.subarray(0, length)
    if (!sameState(state, readAtomicFileState(path))) throw new Error('Skill 补记旁车读取冲突')
    const result = { data: parseSkillActivationStore(JSON.parse(bytes.toString('utf8'))), fingerprint: createHash('sha256').update(bytes).digest('hex'), state, bytes: bytes.length }
    remember(path, result)
    return result
  } finally {
    closeSync(descriptor)
  }
}
/** 加载权威 `${filePath}.skills.json`；默认严格，展示可传 strict:false。 */
export function loadSkillActivationStore(filePath: string, options: SkillActivationStoreLoadOptions = {}): SkillActivationStoreSnapshot {
  /** 使用绝对路径保证原子写和原子删除使用一致目标。 */
  const path = resolve(`${filePath}.skills.json`)
  /** 可连续更新的当前快照，仅成功提交后替换。 */
  let current: StoreRead
  /** 宽松读取的错误保持可见，禁止错误快照覆盖权威内容。 */
  let readError: Error | null = null
  try {
    current = readStore(path)
  } catch (error) {
    if (options.strict !== false) throw error
    readError = error instanceof Error ? error : new Error(String(error))
    current = { data: { version: 1, entries: [] }, fingerprint: null, state: null, bytes: 0 }
  }
  return {
    get hasEntries() { return current.data.entries.length > 0 },
    get fingerprint() { return current.fingerprint },
    readError,
    project(message) { return projectSkillActivations(current.data, message) },
    removeAfterFold() {
      if (readError) throw readError
      const actual = readStore(path)
      if (actual.fingerprint !== current.fingerprint) throw new Error('Skill 补记旁车快照冲突，请重新读取')
      if (actual.state) removeFileAtomic(path, { expectedIdentity: actual.state })
      cache.delete(path)
    },
    update(target, additions) {
      if (readError) throw readError
      /** 修改前重新读取并对比字节指纹；持久身份不依赖 inode。 */
      const actual = readStore(path)
      if (actual.fingerprint !== current.fingerprint) throw new Error('Skill 补记旁车快照冲突，请重新读取')
      /** 纯函数返回同一对象表示语义无变化，不创建临时文件。 */
      const next = mergeSkillActivationStore(current.data, target, additions)
      if (next === current.data) return
      /** 写前同样验证预算，避免生成下次无法读取的权威文件。 */
      const serialized = JSON.stringify(next, null, 2)
      if (next.entries.length > SKILL_ACTIVATION_STORE_MAX_ENTRIES || Buffer.byteLength(serialized) > SKILL_ACTIVATION_STORE_MAX_BYTES) {
        throw new Error('Skill 补记旁车超过预算')
      }
      writeJsonFileAtomicSecure(path, next, {
        expectedDestination: actual.state ? { kind: 'state', state: actual.state } : { kind: 'missing' },
      })
      /** writer 使用两空格 JSON；绑定自己提交的字节，避免后续读取吞掉并发更新。 */
      current = { data: next, fingerprint: createHash('sha256').update(serialized).digest('hex'), state: null, bytes: Buffer.byteLength(serialized) }
    },
  }
}
/** 删除权威文件，不恢复备份；拒绝软链，缺失时无副作用，损坏普通文件仍可显式删除。 */
export function removeSkillActivationStore(filePath: string): void {
  /** 只操作本模块拥有的旁车路径。 */
  const path = resolve(`${filePath}.skills.json`)
  /** 绑定删除前普通文件身份，防止替换目标被误删。 */
  const state = readAtomicFileState(path)
  if (state) removeFileAtomic(path, { expectedIdentity: state })
  cache.delete(path)
}
