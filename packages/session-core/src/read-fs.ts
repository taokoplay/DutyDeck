/**
 * 文件 IO 层 — 仅供 Node 侧（proma CLI / Electron 主进程）使用。
 *
 * 本文件 import 'node:fs'，因此**不能**进入浏览器可达的主 barrel（'@dutydeck/session-core'）。
 * 它只通过子路径 '@dutydeck/session-core/node' 暴露，避免 Vite 把 node:fs 打进渲染层 bundle。
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs'
import type { Stats } from 'node:fs'
import type { SDKMessage } from '@dutydeck/shared'
import { readSessionMessagesFromString } from './read'
import { parseSkillActivationStore, projectSkillActivations, SKILL_ACTIVATION_STORE_MAX_BYTES } from './skill-activation-projection'

/** 比较读取前后的普通文件身份及内容时间戳，发现置换或写入时拒绝使用快照。 */
function sameSidecarFile(before: Stats, after: Stats): boolean {
  return after.isFile() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
}

/** 从指定旁车读取有界权威快照；仅初次观察缺失时返回 undefined，其余错误携带路径向上传播。 */
function readSkillSidecar(path: string) {
  try {
    /** lstat 不跟随软链，悬空链接也不能被当作缺失旁车。 */
    let observed: Stats
    try {
      observed = lstatSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (!observed.isFile() || observed.isSymbolicLink()) throw new Error('Skill 补记旁车必须是普通文件')
    if (observed.size > SKILL_ACTIVATION_STORE_MAX_BYTES) throw new Error('Skill 补记旁车超过字节预算')
    /** 禁止跟随被替换的链接，非阻塞打开避免普通文件被替换为 FIFO 后卡住。 */
    const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      if (!sameSidecarFile(observed, fstatSync(descriptor))) throw new Error('Skill 补记旁车读取冲突')
      /** 分配前已校验预算；多读一字节仅用于发现读取期间的增长。 */
      const buffer = Buffer.alloc(observed.size + 1)
      /** 已读取字节数，同时作为显式文件偏移。 */
      let length = 0
      while (length < buffer.length) {
        /** 每次只读取剩余有界空间，EOF 返回零。 */
        const count = readSync(descriptor, buffer, length, buffer.length - length, length)
        if (count === 0) break
        length += count
      }
      if (length !== observed.size || !sameSidecarFile(observed, fstatSync(descriptor))
        || !sameSidecarFile(observed, lstatSync(path))) throw new Error('Skill 补记旁车读取冲突或超过预算')
      return parseSkillActivationStore(JSON.parse(buffer.subarray(0, length).toString('utf8')))
    } finally {
      closeSync(descriptor)
    }
  } catch (error) {
    throw new Error(`无法读取 Skill 补记旁车 ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

/**
 * 从磁盘读取一份会话 JSONL 并解析为 SDKMessage[]。
 */
export function readSessionMessages(filePath: string): SDKMessage[] {
  /** 先解析未投影正文，摘要必须与持久化输入一致。 */
  const messages = readSessionMessagesFromString(readFileSync(filePath, 'utf-8'))
  /** 一次加载权威快照，所有消息共用同一投影索引。 */
  const store = readSkillSidecar(`${filePath}.skills.json`)
  return store ? messages.map((message) => projectSkillActivations(store, message)) : messages
}
