import { createHash } from 'node:crypto'
import { mergeSkillActivations } from '@dutydeck/shared'
import type { SDKMessage, SDKUserMessage, SkillActivation } from '@dutydeck/shared'

/** 单旁车最大 UTF-8 字节数，主进程与 CLI 使用同一预算。 */
export const SKILL_ACTIVATION_STORE_MAX_BYTES = 8 * 1024 * 1024
/** 单旁车最大输入记录数，阻断无限对象膨胀。 */
export const SKILL_ACTIVATION_STORE_MAX_ENTRIES = 20_000

/** 单次输入的补记；只存 UUID、原始内容摘要和新增 Skill，不复制正文。 */
export interface SkillActivationStoreEntry {
  /** normalized SDK user 的稳定标识。 */
  uuid: string
  /** 未投影 content 的 SHA-256，小写十六进制。 */
  contentDigest: string
  /** 此输入的旁车补记，旧内嵌列表仍由原消息持有。 */
  additions: readonly SkillActivation[]
}
/** 主进程和 CLI 共用的可移植旁车 schema。 */
export interface SkillActivationStoreData {
  /** 格式版本，未知版本必须拒绝。 */
  version: 1
  /** 以 UUID 和内容摘要联合唯一的补记列表。 */
  entries: readonly SkillActivationStoreEntry[]
}
/** 快照对象只通过 parse/merge 创建或替换；弱引用不延长已淘汰快照的生命周期。 */
const snapshotIndexes = new WeakMap<SkillActivationStoreData, Map<string, Map<string, SkillActivationStoreEntry>>>()

/** 为一个不可变快照构建一次 UUID→摘要索引；返回该快照专属的查询表。 */
function snapshotIndex(data: SkillActivationStoreData): Map<string, Map<string, SkillActivationStoreEntry>> {
  /** 同一快照的重复投影复用索引，不再遍历全部条目。 */
  const cached = snapshotIndexes.get(data)
  if (cached) return cached
  /** 每个 UUID 可包含多个正文版本，按摘要分别保留。 */
  const index = new Map<string, Map<string, SkillActivationStoreEntry>>()
  for (const entry of data.entries) {
    /** 一次读取稳定身份，避免重复访问条目。 */
    const uuid = entry.uuid
    /** 正文版本的摘要映射，不保存或复制正文。 */
    let versions = index.get(uuid)
    if (!versions) { versions = new Map(); index.set(uuid, versions) }
    versions.set(entry.contentDigest, entry)
  }
  snapshotIndexes.set(data, index)
  return index
}

/** 判断未知 JSON 是否为普通记录，供严格 schema 校验使用。 */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
/** 输入未投影的 normalized SDK user，返回正文摘要；迁移展示路径不得参与调用。 */
export function skillActivationContentDigest(target: SDKUserMessage): string {
  return createHash('sha256').update(JSON.stringify(target.message?.content ?? null)).digest('hex')
}
/** 解析并复制完整快照；损坏、未知字段、重复输入或非规范补记均抛错，不执行 IO。 */
export function parseSkillActivationStore(value: unknown): SkillActivationStoreData {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.entries)
    || value.entries.length > SKILL_ACTIVATION_STORE_MAX_ENTRIES
    || Object.keys(value).some((key) => key !== 'version' && key !== 'entries')) {
    throw new Error('Skill 补记旁车结构无效')
  }
  /** 联合键用于拒绝重复项，避免投影产生不确定来源。 */
  const seen = new Set<string>()
  /** 每个条目校验后重新构造，隔离调用方的可变对象。 */
  const entries = value.entries.map((entry): SkillActivationStoreEntry => {
    if (!record(entry) || typeof entry.uuid !== 'string' || !entry.uuid.trim()
      || typeof entry.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.contentDigest)
      || !Array.isArray(entry.additions) || entry.additions.length === 0
      || Object.keys(entry).some((key) => !['uuid', 'contentDigest', 'additions'].includes(key))) {
      throw new Error('Skill 补记旁车条目无效')
    }
    /** shared 的规范化只用于比较，不能静默修复权威文件。 */
    const additions = mergeSkillActivations(entry.additions as SkillActivation[])
    if (entry.additions.some((addition) => !record(addition))
      || JSON.stringify(additions.map((item) => Object.entries(item).sort())) !== JSON.stringify(entry.additions.map((item) => Object.entries(item).sort()))) {
      throw new Error('Skill 补记旁车激活列表无效')
    }
    /** JSON 数组编码避免 UUID 中的分隔符造成联合键冲突。 */
    const key = JSON.stringify([entry.uuid, entry.contentDigest])
    if (seen.has(key)) throw new Error('Skill 补记旁车包含重复输入')
    seen.add(key)
    return { uuid: entry.uuid, contentDigest: entry.contentDigest, additions }
  })
  return { version: 1, entries }
}
/** 纯内存投影；无匹配时返回原消息，有匹配时复制并合并新旧 Skill。 */
export function projectSkillActivations(data: SkillActivationStoreData, message: SDKMessage): SDKMessage {
  if (!message || message.type !== 'user' || typeof message.uuid !== 'string' || !message.uuid || data.entries.length === 0) return message
  /** UUID 不存在时直接返回，不读取或计算大段无关正文的摘要。 */
  const versions = snapshotIndex(data).get(message.uuid)
  if (!versions) return message
  /** 摘要只算一次，避免逐条重复序列化正文。 */
  const target = message as SDKUserMessage
  /** SDKMessage 含开放事件分支，type 校验后收窄为规范用户输入。 */
  const digest = skillActivationContentDigest(target)
  /** 联合身份阻断同 UUID 异正文继承。 */
  const entry = versions.get(digest)
  if (!entry) return message
  return { ...message, skill_activations: mergeSkillActivations(target.skill_activations ?? [], entry.additions) }
}
/** 合并补记，语义无变化返回同一快照；入参必须是未投影 SDK user，结果不修改原对象。 */
export function mergeSkillActivationStore(
  data: SkillActivationStoreData,
  target: SDKUserMessage,
  additions: SkillActivation[],
): SkillActivationStoreData {
  if (!target || target.type !== 'user' || typeof target.uuid !== 'string' || !target.uuid.trim()) throw new Error('Skill 补记缺少用户输入 UUID')
  /** 摘要与投影使用同一个算法，保持迁移读写一致。 */
  const contentDigest = skillActivationContentDigest(target)
  /** 已有条目与正文绑定，不覆盖同 UUID 的其他正文。 */
  const existing = snapshotIndex(data).get(target.uuid)?.get(contentDigest)
  /** 比较用户实际看到的合并结果，避免旧内嵌已有来源触发落盘。 */
  const before = mergeSkillActivations(target.skill_activations ?? [], existing?.additions ?? [])
  if (JSON.stringify(before) === JSON.stringify(mergeSkillActivations(before, additions))) return data
  /** 只将补记并入旁车，不复制内嵌内容。 */
  const next = { uuid: target.uuid, contentDigest, additions: mergeSkillActivations(existing?.additions ?? [], additions) }
  return { version: 1, entries: existing ? data.entries.map((entry) => entry === existing ? next : entry) : [...data.entries, next] }
}
