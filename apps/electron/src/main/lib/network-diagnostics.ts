import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import type { NetworkDiagnosticCode, NetworkDiagnosticEvent, NetworkDiagnosticPhase, NetworkDiagnosticsReport } from '@dutydeck/shared'

/** 只接受这些已审阅的枚举，不保存任意调用方文本。 */
const PHASES = new Set<string>(['completed', 'failed', 'cancelled', 'stalled', 'recovery'])
/** 故障分类不携带异常消息或供应商响应。 */
const CODES = new Set<string>(['network_changed', 'timeout', 'dns', 'connection', 'provider_error', 'authentication', 'rate_limit', 'unknown'])
/** 报告只在本机进程内保留五分钟。 */
const REPORT_TTL_MS = 5 * 60_000

/** 有界、仅内存的诊断；每个实例拥有随机盐，生产只创建一个实例。 */
export class NetworkDiagnostics {
  /** 来源只能在当前进程内关联，进程退出后无法继续匹配。 */
  private readonly salt = randomBytes(32)
  /** 最新一百条已重建白名单的事件。 */
  private readonly events: NetworkDiagnosticEvent[] = []
  /** 按创建顺序保存最多五份用户实际预览的快照。 */
  private readonly reports = new Map<string, NetworkDiagnosticsReport>()

  /** now 返回 Unix 毫秒，测试可注入可控时钟。 */
  constructor(private readonly now: () => number = Date.now) {}

  /** 从未知输入重建允许字段；任何诊断异常均不能中断主请求。 */
  record(input: unknown, origin?: string): void {
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return
      /** 仅取白名单属性，绝不展开未知 payload。 */
      const value = input as Record<string, unknown>
      const phase = value.phase
      const code = value.code
      if (typeof phase !== 'string' || !PHASES.has(phase) || typeof code !== 'string' || !CODES.has(code)) return
      /** 时间和来源均由本容器生成，忽略调用方同名字段。 */
      const event: NetworkDiagnosticEvent = {
        phase: phase as NetworkDiagnosticPhase,
        code: code as NetworkDiagnosticCode,
        timestamp: this.now(),
      }
      /** 只保留合理的耗时值，拒绝非有限数及超24小时异常值。 */
      const durationMs = value.durationMs
      if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0 && durationMs <= 86_400_000) {
        event.durationMs = durationMs
      }
      /** HTTP 状态码必须是标准范围整数。 */
      const status = value.status
      if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) event.status = status
      if (typeof origin === 'string') {
        try {
          /** URL 对象仅在此短暂存在；路径、查询参数及凭据不进入 HMAC。 */
          const url = new URL(origin)
          if (url.protocol === 'http:' || url.protocol === 'https:') {
            event.originId = createHmac('sha256', this.salt).update(url.origin).digest('hex')
          }
        } catch { /* 不合法来源直接省略，仍可记录不带来源的分类。 */ }
      }
      this.events.push(event)
      if (this.events.length > 100) this.events.shift()
    } catch { /* 不记录输入或异常文本，避免诊断自身泄漏凭据。 */ }
  }

  /** 生成独立预览快照并返回副本，后续事件不会改变该快照。 */
  createReport(): NetworkDiagnosticsReport {
    this.pruneReports()
    /** 存储与返回都使用独立副本，防止调用方修改内部快照。 */
    const report: NetworkDiagnosticsReport = {
      id: randomUUID(),
      createdAt: this.now(),
      events: structuredClone(this.events),
    }
    this.reports.set(report.id, report)
    if (this.reports.size > 5) {
      /** Map 保持创建顺序，删除最早预览而不是最近读取项。 */
      const oldest = this.reports.keys().next().value
      if (oldest) this.reports.delete(oldest)
    }
    return structuredClone(report)
  }

  /** 精确读取用户预览的报告；未知、被淘汰或过期 id 统一报错。 */
  getReport(id: string): NetworkDiagnosticsReport {
    this.pruneReports()
    /** 不接受任意对象或超长字符串作为报告标识。 */
    const report = typeof id === 'string' && id.length <= 100 ? this.reports.get(id) : undefined
    if (!report) throw new Error('诊断预览已过期或不存在，请重新预览')
    return structuredClone(report)
  }

  /** 惰性清理到期报告，无常驻计时器。 */
  private pruneReports(): void {
    const now = this.now()
    for (const [id, report] of this.reports) {
      if (now - report.createdAt >= REPORT_TTL_MS || now < report.createdAt) this.reports.delete(id)
    }
  }
}

/** 主进程唯一诊断容器，退出时自然释放全部事件和随机盐。 */
export const networkDiagnostics = new NetworkDiagnostics()
