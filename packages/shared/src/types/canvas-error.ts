/** 加载失败的有限阶段；不包含内部目录、通道或业务身份。 */
const CANVAS_ERROR_STAGES = {
  binding: '关联画布',
  access: '检查画布访问权限',
  'image-recovery': '图片采用恢复',
  'batch-recovery': '批量操作恢复',
  'content-load': '画布内容加载与恢复',
  'agent-recovery': 'Agent 节点恢复',
  load: '读取画布',
  ipc: '连接主进程',
  renderer: '连接画布服务',
} as const

/** 仅使用固定文案解释原因，未知异常通过日志编号排查。 */
const CANVAS_ERROR_REASONS = {
  'access-denied': '文件或目录访问被拒绝，请检查当前用户权限及安全软件的拦截记录。',
  'missing-file': '所需文件或目录不存在，请确认项目目录仍然可用。',
  'disk-full': '磁盘空间不足，无法完成画布加载。',
  'resource-busy': '文件正在被占用或锁定，请稍后重试。',
  'read-only': '项目或数据目录当前不可写，无法完成画布恢复。',
  'helper-unavailable': '画布文件服务缺失或无法启动，请检查安装文件及安全软件的拦截记录。',
  'helper-failed': '画布文件服务异常退出，请复制诊断信息以便排查。',
  'recovery-required': '画布操作尚未安全恢复，请保留当前数据并重试。',
  'invalid-data': '画布数据或目录状态校验失败，请保留当前数据以便排查。',
  timeout: '画布文件操作超时，请检查磁盘或网络目录是否可用。',
  'transport-unavailable': '画布服务连接失败，请重试；若持续失败，请重新启动应用。',
  unknown: '未能识别具体原因，请复制诊断信息以便排查。',
} as const

/** 可公开的有限系统/业务错误码；不得从任意错误正文直接透传。 */
export const CANVAS_DIAGNOSTIC_SYSTEM_CODES = [
  'EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EDQUOT', 'EBUSY', 'EAGAIN', 'EROFS', 'ETIMEDOUT',
  'CANVAS_PROJECT_READ_ONLY', 'CANVAS_DOCUMENT_CORRUPT', 'CANVAS_CONTENT_CORRUPT', 'CANVAS_PATH_UNSAFE',
  'CANVAS_RECOVERY_REQUIRED', 'CANVAS_BATCH_RECOVERY_REQUIRED', 'CANVAS_IMAGE_BATCH_RECOVERY_REQUIRED',
  'CANVAS_INTENT_DURABILITY_UNCERTAIN', 'CANVAS_COMMIT_UNCERTAIN', 'CANVAS_CONTENT_COMMIT_UNCERTAIN',
  'CANVAS_DOCUMENT_INVALID', 'CANVAS_CONTENT_INTENT_INVALID', 'CANVAS_AGENT_RECONCILIATION_MISSING',
] as const

/** 跨 IPC 的安全诊断；referenceId 是本次失败的新日志编号，绝不复用业务 UUID。 */
export interface CanvasErrorDiagnostic {
  /** 最后执行的加载阶段。 */
  stage: keyof typeof CANVAS_ERROR_STAGES
  /** 固定原因分类，不含底层任意错误正文。 */
  reason: keyof typeof CANVAS_ERROR_REASONS
  /** 白名单错误码或 WIN32_<无符号整数>。 */
  systemCode?: string
  /** 原生文件服务退出码。 */
  helperExitCode?: number
  /** 与主进程完整错误日志关联的随机编号。 */
  referenceId?: string
  /** 原始异常是否已在应用日志目录保存，记录失败不影响错误展示。 */
  logStatus?: 'saved' | 'unavailable'
}

/** 判断错误码是否可安全公开；输入为未知值，返回白名单命中结果。 */
export function isCanvasDiagnosticSystemCode(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (CANVAS_DIAGNOSTIC_SYSTEM_CODES.some((code) => code === value)) return true
  /** Windows DWORD 错误码只允许十进制数，不允许拼接 stderr。 */
  const windowsCode = /^WIN32_(0|[1-9]\d{0,9})$/.exec(value)
  return windowsCode !== null && Number(windowsCode[1]) <= 0xffff_ffff
}

/** 重建公开诊断；非法值返回 undefined，额外内部字段不会被带出。 */
export function parseCanvasErrorDiagnostic(value: unknown): CanvasErrorDiagnostic | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  /** 只读 own data 属性，错误处理本身不得执行任意 getter。 */
  const fields = Object.getOwnPropertyDescriptors(value)
  if (['stage', 'reason', 'systemCode', 'helperExitCode', 'referenceId', 'logStatus'].some((key) => fields[key] && !('value' in fields[key]!))) return undefined
  /** 每个公开字段均在重建前检查类型和边界。 */
  const stage: unknown = fields.stage?.value
  const reason: unknown = fields.reason?.value
  const systemCode: unknown = fields.systemCode?.value
  const helperExitCode: unknown = fields.helperExitCode?.value
  const referenceId: unknown = fields.referenceId?.value
  const logStatus: unknown = fields.logStatus?.value
  if (typeof stage !== 'string' || !Object.hasOwn(CANVAS_ERROR_STAGES, stage)
    || typeof reason !== 'string' || !Object.hasOwn(CANVAS_ERROR_REASONS, reason)
    || (systemCode !== undefined && !isCanvasDiagnosticSystemCode(systemCode))
    || (helperExitCode !== undefined && (typeof helperExitCode !== 'number' || !Number.isSafeInteger(helperExitCode) || helperExitCode < 0 || helperExitCode > 0xffff_ffff))
    || (logStatus !== undefined && logStatus !== 'saved' && logStatus !== 'unavailable')
    || (referenceId !== undefined && (typeof referenceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(referenceId)))) return undefined
  return {
    stage: stage as CanvasErrorDiagnostic['stage'], reason: reason as CanvasErrorDiagnostic['reason'],
    ...(systemCode !== undefined ? { systemCode: systemCode as string } : {}),
    ...(helperExitCode !== undefined ? { helperExitCode: helperExitCode as number } : {}),
    ...(referenceId !== undefined ? { referenceId: referenceId as string } : {}),
    ...(logStatus !== undefined ? { logStatus: logStatus as 'saved' | 'unavailable' } : {}),
  }
}

/** 将安全诊断格式化为可显示、可复制的多行中文文本。 */
export function formatCanvasErrorDiagnostic(diagnostic: CanvasErrorDiagnostic): string {
  return [
    `失败阶段：${CANVAS_ERROR_STAGES[diagnostic.stage]}`,
    `原因：${CANVAS_ERROR_REASONS[diagnostic.reason]}`,
    ...(diagnostic.systemCode ? [`系统错误码：${diagnostic.systemCode}`] : []),
    ...(diagnostic.helperExitCode !== undefined ? [`文件服务退出码：${diagnostic.helperExitCode}`] : []),
    ...(diagnostic.referenceId ? [`日志编号：${diagnostic.referenceId}`] : []),
    ...(diagnostic.logStatus === 'saved' ? ['详细日志已保存至应用日志目录：canvas-load-errors.json'] : []),
    ...(diagnostic.logStatus === 'unavailable' ? ['详细日志未保存，请保留并复制当前诊断信息。'] : []),
  ].join('\n')
}
