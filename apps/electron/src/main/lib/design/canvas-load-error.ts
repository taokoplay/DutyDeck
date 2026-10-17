import { randomUUID } from 'node:crypto'
import { CANVAS_DIAGNOSTIC_SYSTEM_CODES, isCanvasDiagnosticSystemCode } from '@dutydeck/shared'
import type { CanvasErrorDiagnostic } from '@dutydeck/shared'

/** 根据已验证的系统码选择用户可理解的原因。 */
function reasonForSystemCode(code: string): CanvasErrorDiagnostic['reason'] {
  if (['EACCES', 'EPERM', 'WIN32_5'].includes(code)) return 'access-denied'
  if (['ENOENT', 'WIN32_2', 'WIN32_3'].includes(code)) return 'missing-file'
  if (['ENOSPC', 'EDQUOT', 'WIN32_39', 'WIN32_112'].includes(code)) return 'disk-full'
  if (['EBUSY', 'EAGAIN', 'WIN32_32', 'WIN32_33'].includes(code)) return 'resource-busy'
  if (['EROFS', 'CANVAS_PROJECT_READ_ONLY', 'WIN32_19'].includes(code)) return 'read-only'
  if (['ETIMEDOUT', 'WIN32_121', 'WIN32_1460'].includes(code)) return 'timeout'
  if (code.endsWith('_RECOVERY_REQUIRED') || code.endsWith('_UNCERTAIN')) return 'recovery-required'
  if (code.endsWith('_CORRUPT') || code.endsWith('_INVALID') || code === 'CANVAS_PATH_UNSAFE') return 'invalid-data'
  return 'unknown'
}

/**
 * 从内部异常提取有限诊断；原始路径、stderr、堆栈和业务身份只留在主进程日志。
 * @param error 原始异常（可能不是 Error，或带有嵌套 cause）。
 * @param stage 当前请求最后执行的阶段。
 * @param referenceId 本次失败的随机日志编号，测试可指定固定值。
 * @returns 可以跨 IPC 返回的诊断，遍历最多八层错误链。
 */
export function createCanvasLoadDiagnostic(
  error: unknown,
  stage: CanvasErrorDiagnostic['stage'],
  referenceId = randomUUID(),
): CanvasErrorDiagnostic {
  /** 记录本次失败的安全字段，不直接复制错误对象。 */
  const diagnostic: CanvasErrorDiagnostic = { stage, reason: 'unknown', referenceId }
  /** 有界遍历可处理循环 cause，不让诊断阻塞错误返回。 */
  let current = error
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    /** 仅读取自身 data 属性，避免错误对象上的 getter 造成二次异常。 */
    const fields = Object.getOwnPropertyDescriptors(current)
    const message: string = typeof fields.message?.value === 'string' ? fields.message.value.slice(0, 16_384) : ''
    const code: unknown = fields.code?.value
    const isHelper = message.startsWith('稳定目录 helper ')
    /** 仅识别 native host 固定格式中的数字，忽略 stderr 的其他内容。 */
    const windowsCode = isHelper ? /\[win32=(\d{1,10})(?: [A-Z_]+)?\]/.exec(message)?.[1] : undefined
    const systemCode = windowsCode !== undefined && isCanvasDiagnosticSystemCode(`WIN32_${windowsCode}`)
      ? `WIN32_${windowsCode}`
      : isCanvasDiagnosticSystemCode(code) ? code
        : CANVAS_DIAGNOSTIC_SYSTEM_CODES.find((candidate) => message === candidate || message.startsWith(`${candidate}:`))
    if (systemCode) {
      diagnostic.systemCode = systemCode
      diagnostic.reason = reasonForSystemCode(systemCode)
    }
    if (isHelper) {
      const exitCode = /^稳定目录 helper 提前退出: code=(\d{1,10}),/.exec(message)?.[1]
      if (exitCode !== undefined && Number(exitCode) <= 0xffff_ffff) diagnostic.helperExitCode = Number(exitCode)
      if (diagnostic.reason === 'unknown') {
        diagnostic.reason = /^稳定目录 helper (不存在|启动失败|进程错误)/.test(message)
          ? 'helper-unavailable' : message.includes('超时') ? 'timeout' : 'helper-failed'
      }
    } else if (message === '无权访问 Canvas 文档') {
      diagnostic.reason = 'access-denied'
    } else if (message === 'Canvas 加载参数无效' || message === 'Canvas 项目或会话 ID 非法') {
      diagnostic.reason = 'invalid-data'
    }
    current = fields.cause?.value ?? fields.causeError?.value
  }
  return diagnostic
}
