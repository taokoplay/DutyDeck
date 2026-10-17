import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseCanvasErrorDiagnostic } from '@proma/shared'
import type { CanvasErrorDiagnostic } from '@proma/shared'
import { redactSensitiveLogText } from '../bridge-log-redaction'
import { writeJsonFileAtomicSecure } from '../safe-file'

/** 日志位置独立于业务数据目录；生产环境使用 Electron logs。 */
interface CanvasLoadErrorRecorderOptions {
  directory: () => string
  version?: () => string
  platform?: string
}

/** 只保存明确支持的错误字段，禁止直接序列化外来对象。 */
interface LocalErrorDetail {
  name?: string
  code?: string | number
  message?: string
  stack?: string
  cause?: LocalErrorDetail | string
  causeError?: LocalErrorDetail | string
}

/** 单条记录中的全部字段由本模块重建。 */
interface CanvasLoadErrorRecord {
  timestamp: string
  diagnostic: CanvasErrorDiagnostic
  version: string
  platform: string
  error: LocalErrorDetail | string
}

/** 先限制输入长度再脱敏，限制正则处理开销；截断的凭据仍会被脱敏。 */
function safeText(value: string, limit = 512): string {
  return redactSensitiveLogText(value.slice(0, limit))
}

/** 仅获取指定 own data 字段，不触发 getter，也不枚举未知字段。 */
function ownData(value: object, key: string): unknown {
  try {
    /** 单字段描述符避免执行属性访问器。 */
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && 'value' in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

/** 有界提取异常链；共享预算防止 cause/causeError 分支指数增长。 */
function describeError(value: unknown, seen: WeakSet<object>, budget: { remaining: number }): LocalErrorDetail | string {
  if (typeof value === 'string') return safeText(value)
  if (value === null || typeof value !== 'object') return `[${typeof value}]`
  if (seen.has(value)) return '[Circular]'
  if (budget.remaining-- <= 0) return '[Truncated]'
  seen.add(value)
  /** 每个字段分别提取，不调用外来 toJSON 或属性访问器。 */
  const result: LocalErrorDetail = {}
  /** 仅接受字符串形式的错误正文与堆栈。 */
  const message = ownData(value, 'message')
  /** 未分类系统错误仍保留本地码，仅允许有界文本或有限数字。 */
  const name = ownData(value, 'name')
  const code = ownData(value, 'code')
  if (typeof name === 'string') result.name = safeText(name, 128)
  if (typeof code === 'string') result.code = safeText(code, 128)
  else if (typeof code === 'number' && Number.isFinite(code)) result.code = code
  const stack = ownData(value, 'stack')
  if (typeof message === 'string') result.message = safeText(message)
  if (typeof stack === 'string') result.stack = safeText(stack, 1024)
  for (const key of ['cause', 'causeError'] as const) {
    /** 当前分支共享全链路预算。 */
    const cause = ownData(value, key)
    if (cause !== undefined) result[key] = describeError(cause, seen, budget)
  }
  return result
}

/**
 * 创建同步、有界的本地 LOAD 失败记录器，返回 saved/unavailable，绝不向调用者抛错。
 * 每个实例仅保留本次进程最近 16 条记录：首次错误覆盖上次会话日志，避免无界读入旧文件。
 * 不生成备份；日志故障不得改变原始画布错误返回或触碰业务目录。
 */
export function createCanvasLoadErrorRecorder(options: CanvasLoadErrorRecorderOptions): (
  diagnostic: CanvasErrorDiagnostic, error: unknown,
) => 'saved' | 'unavailable' {
  /** 内存环仅含有界、已脱敏的普通对象。 */
  const records: CanvasLoadErrorRecord[] = []
  return (diagnostic, error) => {
    try {
      /** 重新验证公开字段，剔除任何外来附加值或序列化钩子。 */
      const safeDiagnostic = parseCanvasErrorDiagnostic(diagnostic)
      if (!safeDiagnostic) return 'unavailable'
      /** 本次错误的安全本地快照，关联前端同一编号。 */
      const record: CanvasLoadErrorRecord = {
        timestamp: new Date().toISOString(),
        diagnostic: safeDiagnostic,
        version: safeText(options.version?.() ?? 'unknown', 128),
        platform: safeText(options.platform ?? process.platform, 64),
        error: describeError(error, new WeakSet<object>(), { remaining: 4 }),
      }
      /** 序列化仅处理已重建对象，检查实际 UTF-8 字节数（含缩进）。 */
      if (Buffer.byteLength(JSON.stringify(record, null, 2), 'utf8') > 8192) {
        record.error = safeText(JSON.stringify(record.error), 1024)
      }
      records.push(record)
      if (records.length > 16) records.shift()
      /** 总文件硬界独立于记录数量；与 secure writer 使用相同的缩进格式。 */
      while (Buffer.byteLength(JSON.stringify(records, null, 2), 'utf8') > 256 * 1024) records.shift()
      /** 日志根由应用注入，禁止回退到故障业务目录。 */
      const directory = options.directory()
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      writeJsonFileAtomicSecure(join(directory, 'canvas-load-errors.json'), records)
      return 'saved'
    } catch {
      return 'unavailable'
    }
  }
}
