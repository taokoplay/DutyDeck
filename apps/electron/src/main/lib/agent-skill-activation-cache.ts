import { lstatSync } from 'node:fs'
import { mergeSkillActivations } from '@dutydeck/shared'
import type { SkillActivation } from '@dutydeck/shared'

/** 只保存已验证的 Skill 数组，不保存正文；文件版本改变即失效。 */
interface ActivationMemo {
  /** 纳秒文件版本，绑定路径当前指向的普通文件。 */
  stamp: string
  /** 使用 JSON 快照，避免调用方后续修改原数组。 */
  serialized: string
  /** 键和序列化内容的 UTF-8 字节预算。 */
  bytes: number
}

/** 无变化快路径的固定内存上限，允许专项测试使用更小预算。 */
interface ActivationCacheLimits {
  maxEntries?: number
  maxBytes?: number
}

/**
 * 获取普通单链接文件的完整版本；不存在、符号链接或无法读取时不提供缓存依据。
 * @param path 会话 JSONL 路径。
 * @returns inode、大小、纳秒 mtime/ctime 组成的版本，或 undefined。
 */
export function skillActivationFileStamp(path: string): string | undefined {
  try {
    const stat = lstatSync(path, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) return undefined
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
  } catch { return undefined }
}

/**
 * 只证明重复激活无变化；不是业务存储，也不提供消息定位或读取替代。
 * 冷启动、新激活、任何文件变化均由原有严格读取与原子写入处理。
 */
export class SkillActivationNoopCache {
  /** 按最近验证/命中顺序保存，限制长期运行的内存占用。 */
  private readonly entries = new Map<string, ActivationMemo>()
  /** 当前键和 JSON 内容总字节数。 */
  private bytes = 0
  /** 最大缓存条目数。 */
  private readonly maxEntries: number
  /** 最大内容字节预算；Map 与字符串对象开销另受条目数限制。 */
  private readonly maxBytes: number

  /** 配置固定预算，默认最多 128 项、1 MiB 内容。 */
  constructor(limits: ActivationCacheLimits = {}, private readonly currentStamp = skillActivationFileStamp) {
    this.maxEntries = limits.maxEntries ?? 128
    this.maxBytes = limits.maxBytes ?? 1024 * 1024
    if (![this.maxEntries, this.maxBytes].every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new Error('Skill 无变化缓存预算必须为正整数')
    }
  }

  /** 移除一项并归还其字节预算。 */
  private forget(key: string): void {
    const entry = this.entries.get(key)
    if (entry) this.bytes -= entry.bytes
    this.entries.delete(key)
  }

  /**
   * 记录已完整验证/成功提交的消息元数据；调用方负责保证其来自权威 JSONL。
   * @param stamp 验证对应的文件版本；变更后的旧快照不进入缓存。
   */
  remember(path: string, uuid: string, activations: SkillActivation[], stamp: string | undefined): void {
    const key = JSON.stringify([path, uuid])
    this.forget(key)
    if (!stamp || stamp !== this.currentStamp(path)) return
    const serialized = JSON.stringify(activations)
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(serialized) + Buffer.byteLength(stamp)
    if (bytes > this.maxBytes) return
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      this.forget(this.entries.keys().next().value!)
    }
    this.entries.set(key, { stamp, serialized, bytes })
    this.bytes += bytes
  }

  /**
   * 使用与正常路径相同的合并规则，只有完全无变化才返回 true。
   * @returns true 表示无需正文 I/O；false 必须继续原有读取/写入路径。
   */
  matches(path: string, uuid: string, activations: SkillActivation[]): boolean {
    const key = JSON.stringify([path, uuid])
    const entry = this.entries.get(key)
    if (!entry) return false
    if (entry.stamp !== this.currentStamp(path)) {
      this.forget(key)
      return false
    }
    const stored = JSON.parse(entry.serialized) as SkillActivation[]
    if (JSON.stringify(mergeSkillActivations(stored, activations)) !== entry.serialized) return false
    this.entries.delete(key)
    this.entries.set(key, entry)
    return true
  }
}
