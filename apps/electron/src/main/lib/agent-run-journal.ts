import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AgentRunJournalEvent,
  AgentRunJournalEventType,
  AgentRunJournalFactBinding,
  AgentRunRecoveryPlan,
  AgentRunReconciliation,
} from '@dutydeck/shared'
import { isJournalEventSequenceValid } from '@dutydeck/shared'
import { getAgentSessionMessagesPath } from './config-paths'
import { assertPiBranchBinding, readPiArtifactSnapshot } from './pi-artifact-reconciliation'

export interface AgentRunJournalOptions {
  /** 测试可注入路径；生产默认复用受管 Session 消息目录。 */
  resolvePath?: (sessionId: string) => string
  /** 可选展示 JSONL 路径；生产默认使用受管 Session 消息文件。 */
  resolveDisplayPath?: (sessionId: string) => string
  /** 测试固定时间。 */
  now?: () => number
}

/**
 * Agent 运行事实日志；只在 turn、工具、审批、检查点和终态边界写入，避免逐 token 写盘。
 * Journal 与 UI JSONL 分离，恢复器以这里的 sequence 和 runId 为准。
 */
export class AgentRunJournalStore {
  private readonly options: AgentRunJournalOptions
  private readonly cached = new Map<string, AgentRunJournalEvent[]>()
  /** 文件身份和修改时间用于感知其他 Journal 实例的追加，避免恢复查询使用旧终态。 */
  private readonly fingerprints = new Map<string, string>()

  constructor(options: AgentRunJournalOptions = {}) {
    this.options = options
  }

  /** 追加一个事件并校验同一 run 的严格 sequence；重复幂等键返回原事件。 */
  append(input: {
    sessionId: string
    runId: string
    branchId: string
    eventType: AgentRunJournalEventType
    payload?: Record<string, unknown>
    factBinding?: AgentRunJournalFactBinding
    parentEventId?: string
    commandId?: string
    idempotencyKey?: string
  }): AgentRunJournalEvent {
    const events = this.read(input.sessionId).filter((event) => event.runId === input.runId)
    if (input.idempotencyKey) {
      const existing = events.find((event) => event.idempotencyKey === input.idempotencyKey)
      if (existing) return existing
    }
    const createdAt = this.options.now?.() ?? Date.now()
    const event: AgentRunJournalEvent = {
      runId: input.runId,
      branchId: input.branchId,
      sequence: events.length + 1,
      eventId: randomUUID(),
      eventType: input.eventType,
      ...(input.parentEventId ? { parentEventId: input.parentEventId } : {}),
      ...(input.commandId ? { commandId: input.commandId } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      payload: { ...(input.payload ?? {}) },
      createdAt,
    }
    if (input.factBinding) {
      event.payload = {
        ...event.payload,
        __factBinding: cloneFactBinding(input.factBinding),
      }
    }
    const path = this.resolvePath(input.sessionId)
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 })
    const all = this.cached.get(input.sessionId) ?? []
    all.push(event)
    this.cached.set(input.sessionId, all)
    this.fingerprints.set(input.sessionId, journalFingerprint(path))
    return event
  }

  /** 读取 Session 全部事件；损坏行会阻断恢复，避免错误重放副作用。 */
  read(sessionId: string): AgentRunJournalEvent[] {
    const path = this.resolvePath(sessionId)
    if (!existsSync(path)) {
      this.cached.set(sessionId, [])
      this.fingerprints.delete(sessionId)
      return []
    }
    const fingerprint = journalFingerprint(path)
    const cached = this.cached.get(sessionId)
    if (cached && this.fingerprints.get(sessionId) === fingerprint) return cached.map(cloneEvent)
    const events: AgentRunJournalEvent[] = []
    for (const [index, line] of readFileSync(path, 'utf8').split('\n').filter(Boolean).entries()) {
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { throw new Error(`AGENT_RUN_JOURNAL_CORRUPT:${index + 1}`) }
      if (!isJournalEvent(parsed)) throw new Error(`AGENT_RUN_JOURNAL_INVALID:${index + 1}`)
      events.push(parsed)
    }
    this.cached.set(sessionId, events)
    this.fingerprints.set(sessionId, fingerprint)
    return events.map(cloneEvent)
  }

  /** 扫描未完成 run；非幂等工具或审批等待默认进入 confirm，避免崩溃后重复副作用。 */
  scanRecovery(sessionId: string): AgentRunRecoveryPlan[] {
    const events = this.read(sessionId)
    const byRun = new Map<string, AgentRunJournalEvent[]>()
    for (const event of events) {
      /** 原地追加分组，避免长会话恢复扫描产生平方级数组复制。 */
      const group = byRun.get(event.runId)
      if (group) group.push(event)
      else byRun.set(event.runId, [event])
    }
    const plans: AgentRunRecoveryPlan[] = []
    for (const [runId, runEvents] of byRun) {
      /** 放弃回执独立核验此前全部事实，允许收束损坏序列但不能遮蔽后来事件。 */
      const last = runEvents.at(-1)
      if (last?.eventType === 'run_stopped' && last.payload.reason === 'recovery_abandoned') {
        const prefix = runEvents.slice(0, -1)
        if (prefix.length > 0 && last.payload.previousEventCount === prefix.length
          && last.payload.previousEventId === prefix.at(-1)?.eventId
          && last.payload.previousEventsSha256 === recoveryPrefixDigest(prefix)) continue
        plans.push({ runId, branchId: runEvents[0]?.branchId ?? 'unknown', lastSequence: runEvents.length, action: 'abandon', reason: '放弃回执与此前 Journal 事实不一致' })
        continue
      }
      const sequences = runEvents.map((event) => event.sequence)
      if (!isJournalEventSequenceValid(sequences)) {
        plans.push({ runId, branchId: runEvents[0]?.branchId ?? 'unknown', lastSequence: runEvents.length, action: 'abandon', reason: 'Journal sequence 不连续' })
        continue
      }
      if (!last || (isTerminalEvent(last.eventType) && !(last.eventType === 'run_failed' && last.payload.recoverableInterruption === true))) continue
      /** 只有生产回执带有文件身份或显式注入路径时才读取展示 JSONL，测试和旧日志保持兼容。 */
      const verifyDisplay = this.options.resolveDisplayPath !== undefined || runEvents.some((event) => Boolean(readFactBinding(event)?.display?.fileIdentity))
      const reconciliation = reconcileRunEvents(runEvents, {
        displayPath: verifyDisplay
          ? (this.options.resolveDisplayPath?.(sessionId) ?? getAgentSessionMessagesPath(sessionId))
          : '',
        verifyDisplay,
      })
      /** 工具按事件身份闭合，权限兼容生产回调的稳定 requestId。 */
      const resolvedTools = new Set(runEvents.filter((event) => event.eventType === 'tool_result').map((event) => event.parentEventId))
      const resolvedPermissions = runEvents.filter((event) => event.eventType === 'permission_resolved')
      const resolvedPermissionEvents = new Set(resolvedPermissions.map((event) => event.parentEventId))
      const resolvedPermissionIds = new Set(resolvedPermissions.map((event) => event.payload.requestId).filter((id): id is string => typeof id === 'string'))
      const pendingTool = [...runEvents].reverse().find((event) => event.eventType === 'tool_started' && !resolvedTools.has(event.eventId))
      const pendingPermission = [...runEvents].reverse().find((event) => event.eventType === 'permission_requested' && !resolvedPermissionEvents.has(event.eventId) && !(typeof event.payload.requestId === 'string' && resolvedPermissionIds.has(event.payload.requestId)))
      const pending = pendingTool ?? pendingPermission
      const payload = pending?.payload ?? {}
      const replaySafe = payload.replaySafe === true
      const action = reconciliation.status === 'mismatch'
        ? 'abandon'
        : reconciliation.status === 'incomplete'
          ? 'confirm'
          : pending && !replaySafe
            ? 'confirm'
            : pending
              ? 'resume'
                : 'resume'
      plans.push({
        runId,
        branchId: last.branchId,
        lastSequence: last.sequence,
        action,
        reason: reconciliation.reasons[0]
          ?? (pending ? (replaySafe ? '可幂等恢复未完成工具' : '存在未确认的工具或权限副作用') : '运行在终态前中断'),
        ...(pending?.eventId ? { pendingEventId: pending.eventId } : {}),
        ...(typeof payload.moduleId === 'string' ? { moduleId: payload.moduleId } : {}),
        ...(typeof payload.capabilityId === 'string' ? { capabilityId: payload.capabilityId } : {}),
        reconciliation,
      })
    }
    return plans
  }

  /** 绑定调用方已核验的完整运行前缀并追加终止回执；不重写损坏历史或其他运行。 */
  abandonRecovery(sessionId: string, runId: string, branchId: string, expectedEvents: readonly AgentRunJournalEvent[]): void {
    /** 当前事实与领取时的快照必须一致，避免取消回调期间新增事件被错误放弃。 */
    const currentEvents = this.read(sessionId).filter((event) => event.runId === runId)
    const digest = recoveryPrefixDigest(expectedEvents)
    if (currentEvents.length === 0 || recoveryPrefixDigest(currentEvents) !== digest) throw new Error('AGENT_RUN_RECOVERY_STALE')
    this.append({ sessionId, runId, branchId, eventType: 'run_stopped', payload: {
      reason: 'recovery_abandoned',
      previousEventCount: currentEvents.length,
      previousEventId: currentEvents.at(-1)!.eventId,
      previousEventsSha256: digest,
    } })
  }

  /** 读取指定运行最后的 Pi 绑定；调用方还必须核对当前 Session 元数据和恢复计划。 */
  getPiBinding(sessionId: string, runId: string): AgentRunJournalFactBinding['pi'] {
    return this.read(sessionId).filter((event) => event.runId === runId)
      .map(readFactBinding).flatMap((binding) => binding?.pi ? [binding.pi] : []).at(-1)
  }

  private resolvePath(sessionId: string): string {
    return this.options.resolvePath?.(sessionId) ?? join(dirname(getAgentSessionMessagesPath(sessionId)), `${sessionId}.run-journal.jsonl`)
  }
}

/** 对已解析事件的完整有序 JSON 求摘要；顺序、重复项和所有 payload 都参与核验。 */
function recoveryPrefixDigest(events: readonly AgentRunJournalEvent[]): string {
  return createHash('sha256').update(JSON.stringify(events), 'utf8').digest('hex')
}

/** 从事件 payload 提取只读事实源绑定。 */
function readFactBinding(event: AgentRunJournalEvent): AgentRunJournalFactBinding | undefined {
  const candidate = event.payload.__factBinding
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
  const record = candidate as Record<string, unknown>
  const display = record.display
  const pi = record.pi
  return {
    ...(display && typeof display === 'object' && !Array.isArray(display) ? { display: display as AgentRunJournalFactBinding['display'] } : {}),
    ...(pi && typeof pi === 'object' && !Array.isArray(pi) ? { pi: pi as AgentRunJournalFactBinding['pi'] } : {}),
  }
}

/** 对账当前运行的 Journal、展示 JSONL 和 Pi 绑定；只依赖持久化摘要，不猜测正文。 */
function reconcileRunEvents(
  events: readonly AgentRunJournalEvent[],
  options: { displayPath: string; verifyDisplay: boolean },
): AgentRunReconciliation {
  const reasons: string[] = []
  const branches = new Set(events.map((event) => event.branchId))
  const displayBindings = events.map(readFactBinding).flatMap((binding) => binding?.display ? [binding.display] : [])
  const piBindings = events.map(readFactBinding).flatMap((binding) => binding?.pi ? [binding.pi] : [])
  const assistantEvents = events.filter((event) => event.eventType === 'assistant_turn')
  const latestDisplay = displayBindings.at(-1)
  const latestPi = piBindings.at(-1)
  /** 所有展示回执的 UUID 集合，用于发现只提交了前一批消息的崩溃窗口。 */
  const displayedMessageUuids = new Set(displayBindings.flatMap((binding) => binding.messages.map((message) => message.uuid)))

  /** 首次创建 Pi session 前的 main 只是临时身份；仅允许明确的首次绑定转换。 */
  const firstBoundIndex = events.findIndex((event) => event.eventType === 'checkpoint' && event.payload.stage === 'pi-session-bound' && event.payload.piSessionId === event.branchId)
  const initialBinding = branches.size === 2 && branches.has('main') && firstBoundIndex >= 0
    && events.slice(0, firstBoundIndex).every((event) => event.branchId === 'main')
    && events.slice(firstBoundIndex).every((event) => event.branchId === events[firstBoundIndex]?.branchId)
  if (branches.size > 1 && !initialBinding) reasons.push('同一运行跨越多个 Pi branch，缺少明确的分支切换提交点')
  if (!latestDisplay) reasons.push('缺少展示 JSONL 追加回执，尚未核验完整事实源')
  if (!latestPi?.sessionFile || !latestPi.sessionId || !latestPi.artifactSha256 || !latestPi.branchTipId) reasons.push('缺少可核验的 Pi artifact 文件绑定')
  if (assistantEvents.length > 0 && !latestDisplay) reasons.push('已收到 assistant 输出，但展示 JSONL 尚无对应追加回执')
  if (assistantEvents.some((event) => typeof event.payload.messageUuid === 'string' && !displayedMessageUuids.has(event.payload.messageUuid))) {
    reasons.push('部分 assistant 输出尚无对应展示 JSONL 回执')
  }
  if (latestDisplay && latestDisplay.messages.some((message) => !message.uuid || !message.sha256)) {
    reasons.push('展示 JSONL 回执缺少消息摘要')
  }
  if (latestPi && Object.values(latestPi.entryBindings).some((entryId) => !entryId)) {
    reasons.push('Pi entry binding 存在空定位')
  }
  if (latestPi && Object.keys(latestPi.entryBindings).some((uuid) => !displayedMessageUuids.has(uuid))) {
    reasons.push('Pi 消息绑定尚无完整展示 JSONL 回执')
  }
  if (latestPi && latestPi.sessionId && events.some((event) => event.branchId === latestPi.sessionId) === false) {
    reasons.push('Pi artifact session 与 Journal branch 不一致')
  }
  if (options.verifyDisplay) {
    for (const binding of displayBindings) reasons.push(...verifyDisplayBinding(options.displayPath, binding))
  }
  if (latestPi) reasons.push(...verifyPiBinding(latestPi))

  return {
    status: reasons.some((reason) => reason.includes('不一致') || reason.includes('多个') || reason.includes('空定位'))
      ? 'mismatch'
      : reasons.length > 0
        ? 'incomplete'
        : 'matched',
    reasons: reasons.length > 0 ? reasons : ['Journal、展示 JSONL 与 Pi 绑定摘要一致'],
  }
}

/** 校验展示 JSONL 的设备身份、字节范围和逐消息 SHA-256。 */
function verifyDisplayBinding(path: string, binding: NonNullable<AgentRunJournalFactBinding['display']>): string[] {
  try {
    if (!existsSync(path)) return ['事实源不一致：展示 JSONL 文件不存在']
    const stat = statSync(path)
    if (binding.fileIdentity && (stat.dev !== binding.fileIdentity.dev || stat.ino !== binding.fileIdentity.ino)) {
      return ['事实源不一致：展示 JSONL 文件身份已变化']
    }
    const bytes = readFileSync(path)
    const end = binding.byteOffset + binding.byteLength
    if (binding.byteOffset < 0 || binding.byteLength <= 0 || end > bytes.length) {
      return ['事实源不一致：展示 JSONL 追加范围不存在']
    }
    const segment = bytes.subarray(binding.byteOffset, end)
    const lines = segment.toString('utf8').split('\n').filter(Boolean)
    if (lines.length !== binding.messages.length) return ['事实源不一致：展示 JSONL 消息数量变化']
    for (const [index, message] of binding.messages.entries()) {
      const line = lines[index]
      if (!line || createHash('sha256').update(line, 'utf8').digest('hex') !== message.sha256) {
        return ['事实源不一致：展示 JSONL 消息摘要变化']
      }
    }
    return []
  } catch {
    return ['事实源不一致：展示 JSONL 无法读取']
  }
}

/** 校验 Pi artifact 文件仍包含 Journal 记录的 session 与 entry。 */
function verifyPiBinding(binding: NonNullable<AgentRunJournalFactBinding['pi']>): string[] {
  if (!binding.sessionFile) return []
  try {
    const snapshot = readPiArtifactSnapshot(binding.sessionFile)
    assertPiBranchBinding({
      expectedSessionId: binding.sessionId,
      actualSessionId: snapshot.sessionId,
      branch: snapshot.branchEntryIds.map((id, index) => ({ type: 'message', id, parentId: index > 0 ? snapshot.branchEntryIds[index - 1]! : null })),
      entryBindings: binding.entryBindings,
      expectedBranchTipId: binding.branchTipId,
    })
    if (binding.artifactSha256 && binding.artifactSha256 !== snapshot.artifactSha256) return ['事实源不一致：Pi artifact 摘要变化']
    return []
  } catch {
    return ['事实源不一致：Pi artifact branch 或摘要校验失败']
  }
}

function isTerminalEvent(eventType: AgentRunJournalEventType): boolean {
  return eventType === 'run_completed' || eventType === 'run_failed' || eventType === 'run_stopped'
}

function isJournalEvent(value: unknown): value is AgentRunJournalEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.runId === 'string' && typeof record.branchId === 'string' && typeof record.sequence === 'number'
    && typeof record.eventId === 'string' && typeof record.eventType === 'string' && typeof record.createdAt === 'number'
    && typeof record.payload === 'object' && record.payload !== null && !Array.isArray(record.payload)
}

function cloneEvent(event: AgentRunJournalEvent): AgentRunJournalEvent {
  return { ...event, payload: { ...event.payload, ...(event.payload.__factBinding ? { __factBinding: cloneFactBinding(event.payload.__factBinding as AgentRunJournalFactBinding) } : {}) } }
}

function cloneFactBinding(binding: AgentRunJournalFactBinding): AgentRunJournalFactBinding {
  return {
    ...(binding.display ? {
      display: {
        ...binding.display,
        ...(binding.display.fileIdentity ? { fileIdentity: { ...binding.display.fileIdentity } } : {}),
        messages: binding.display.messages.map((message) => ({ ...message })),
      },
    } : {}),
    ...(binding.pi ? {
      pi: {
        ...binding.pi,
        entryBindings: { ...binding.pi.entryBindings },
      },
    } : {}),
  }
}

/** 以宿主文件身份和纳秒时间感知原子替换或其他实例追加。 */
function journalFingerprint(path: string): string {
  const stat = statSync(path, { bigint: true })
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
}
