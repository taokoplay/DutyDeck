/**
 * ContextUsageBadge — 上下文使用量指示器
 *
 * 输入框工具栏上的一个 36×36 按钮：
 * - 内部为 16px 圆环，按 displayTokens / displayWindow 比例渲染
 * - hover 弹出 Popover：剩余/占用、本轮与会话用量、缓存命中率、工具上下文与手动压缩
 * - 压缩中时按钮位置显示 Loader2 旋转图标
 * - 占用接近当前 Agent runtime 的自动压缩阈值时圆环变琥珀色
 * - 无数据时不显示
 *
 * 面板参考 PI-Desktop 的 ContextUsageInspector：运行时未提供的指标（网络请求、
 * 纯工具耗时）明确显示“暂不可用”，不把缺失当成零。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Loader2, Minimize2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { inputToolbarButtonClass } from '@/components/ai-elements/input-toolbar-styles'
import { preventHoverPopoverFocusRestore } from '@/components/ai-elements/input-toolbar-popover-focus'
import {
  agentSDKMessagesCacheAtom,
  agentSessionsAtom,
  agentSessionViewStreamStateAtomFamily,
} from '@/atoms/agent-atoms'
import { cn } from '@/lib/utils'
import {
  buildContextUsageSummary,
  formatCompactTokens,
  formatElapsedDuration,
  formatUsd,
} from '@/lib/context-usage-summary'
import {
  calculatePiAutoCompactionThresholdTokens,
  type ChannelPlanQuotaWindow,
  type ProviderType,
} from '@dutydeck/shared'
import { fetchChannelPlanQuota } from '@/lib/channel-plan-quota'
import { currentPlanQuota, formatPlanQuotaWindowValue, planQuotaAccountKey } from '@/lib/channel-plan-quota-display'
import type { LoadedPlanQuota } from '@/lib/channel-plan-quota-display'

/** 显示警告的阈值（压缩阈值的 80%） */
const WARNING_RATIO = 0.80
/** Popover hover 关闭延迟（ms），与 AgentThinkingPopover 一致 */
const HOVER_CLOSE_DELAY = 150
/** 手动压缩二次确认后自动重置确认态的超时（ms），与归档按钮一致 */
const CONFIRM_RESET_DELAY = 3000
const UNSUPPORTED_PLAN_QUOTA_MESSAGE = '当前渠道不支持订阅 Plan 额度查询'

interface ContextUsageBadgeProps {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  costUsd?: number
  contextWindow?: number
  /** 当前上下文 token 是否为 Pi 手动压缩后的预估值 */
  isEstimated?: boolean
  isCompacting?: boolean
  isProcessing: boolean
  onCompact: () => void
  /**
   * 当前会话 ID，用于在切换会话时清空 stableRef，
   * 避免新会话尚未发消息时仍显示上一个会话的 token 数。
   */
  sessionId?: string
  /** 当前 Agent 渠道 ID，用于 hover 时查询订阅 Plan 剩余额度 */
  channelId?: string | null
  /** 渠道保存时间；凭据变更后用于使旧额度缓存失效。 */
  channelUpdatedAt?: number
}

/** 圆环进度指示器 — 16×16 SVG，描边 2px */
interface UsageRingProps {
  ratio: number
  isWarning: boolean
}
function UsageRing({ ratio, isWarning }: UsageRingProps): React.ReactElement {
  const radius = 8
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(1, ratio))
  const dashOffset = circumference * (1 - clamped)

  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      className={cn(
        'shrink-0 transition-colors',
        isWarning ? 'text-amber-500 dark:text-amber-400' : 'text-foreground/70',
      )}
      aria-hidden="true"
    >
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.2"
        strokeWidth="2"
      />
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        transform="rotate(-90 10 10)"
        style={{ transition: 'stroke-dashoffset 300ms ease-out' }}
      />
    </svg>
  )
}

/** Popover 里的一行 key/value */
interface DetailRowProps {
  label: string
  value: string
  emphasized?: boolean
}
function DetailRow({ label, value, emphasized }: DetailRowProps): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-4 text-xs">
      <span className="text-foreground/70">{label}</span>
      <span className={cn('tabular-nums', emphasized ? 'font-medium text-foreground' : 'text-foreground/90')}>
        {value}
      </span>
    </div>
  )
}

function PlanQuotaRow({ quotaWindow, provider }: { quotaWindow: ChannelPlanQuotaWindow; provider: ProviderType }): React.ReactElement {
  const value = formatPlanQuotaWindowValue(quotaWindow, provider)
  return (
    <div className="space-y-1">
      <DetailRow
        label={quotaWindow.label}
        value={value}
        emphasized={quotaWindow.showProgress !== false && quotaWindow.remainingPercent <= 20}
      />
      {quotaWindow.showProgress !== false ? (
        <div className="h-1 overflow-hidden rounded-full bg-foreground/10">
          <div
            className={cn(
              'h-full rounded-full',
              quotaWindow.remainingPercent <= 20 ? 'bg-amber-500' : 'bg-foreground/60',
            )}
            style={{ width: `${Math.max(0, Math.min(100, quotaWindow.remainingPercent))}%` }}
          />
        </div>
      ) : null}
    </div>
  )
}

export function ContextUsageBadge({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheCreationTokens,
  costUsd,
  contextWindow,
  isEstimated,
  isCompacting,
  isProcessing,
  onCompact,
  sessionId,
  channelId,
  channelUpdatedAt,
}: ContextUsageBadgeProps): React.ReactElement | null {
  // usage 高频更新只唤醒这个小组件，不再让 AgentView 和输入框参与 reconciliation。
  const sessionStreamState = useAtomValue(agentSessionViewStreamStateAtomFamily(sessionId ?? ''))
  const displayInputTokens = sessionId ? sessionStreamState.inputTokens : inputTokens
  const displayOutputTokens = sessionId ? sessionStreamState.outputTokens : outputTokens
  const displayCacheReadTokens = sessionId ? sessionStreamState.cacheReadTokens : cacheReadTokens
  const displayCacheCreationTokens = sessionId ? sessionStreamState.cacheCreationTokens : cacheCreationTokens
  const displayContextWindow = sessionId ? sessionStreamState.contextWindow : contextWindow
  const displayIsEstimated = sessionId
    ? sessionStreamState.contextUsageIsEstimated === true
    : isEstimated === true
  /** 本次报告可信度与保留的最近数值分开，未知不等于零占用。 */
  const displayUsageStatus = sessionId ? sessionStreamState.usageStatus : undefined
  const displayIsCompacting = sessionId
    ? sessionStreamState.isCompacting === true
    : isCompacting === true

  // 保留最近一次有效的 token 值，避免切换会话时闪烁消失
  const stableRef = React.useRef<{
    inputTokens: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    contextWindow?: number
  } | null>(null)
  // 会话切换时清空陈旧值，避免新会话尚未上报 usage 时显示上个会话的数字
  const lastSessionRef = React.useRef<string | undefined>(sessionId)
  React.useEffect(() => {
    if (lastSessionRef.current !== sessionId) {
      stableRef.current = null
      lastSessionRef.current = sessionId
    }
  }, [sessionId])
  if (displayInputTokens != null && (displayInputTokens > 0 || displayUsageStatus === 'known')) {
    stableRef.current = {
      inputTokens: displayInputTokens,
      outputTokens: displayOutputTokens,
      cacheReadTokens: displayCacheReadTokens,
      cacheCreationTokens: displayCacheCreationTokens,
      contextWindow: displayContextWindow,
    }
  }

  const [open, setOpen] = React.useState(false)
  const closeTimerRef = React.useRef<number | null>(null)
  const popoverReceivedFocusRef = React.useRef(false)
  // 同账号刷新可保留旧值；切换账号或清空渠道时立即隐藏旧结果。
  const [loadedQuota, setLoadedQuota] = React.useState<LoadedPlanQuota | null>(null)
  const quotaKey = planQuotaAccountKey(channelId, channelUpdatedAt)
  const quota = currentPlanQuota(loadedQuota, quotaKey)

  const cancelClose = React.useCallback(() => {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const scheduleClose = React.useCallback(() => {
    cancelClose()
    closeTimerRef.current = window.setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY)
  }, [cancelClose])

  React.useEffect(() => cancelClose, [cancelClose])

  // 二次确认压缩状态：第一次点击进入确认态，再次点击才触发压缩
  const [confirming, setConfirming] = React.useState(false)

  // 确认态超时后自动重置，避免按钮长时间停留在确认态
  React.useEffect(() => {
    if (!confirming) return
    const timer = window.setTimeout(() => setConfirming(false), CONFIRM_RESET_DELAY)
    return () => window.clearTimeout(timer)
  }, [confirming])

  // Popover 关闭时同步重置确认态
  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) setConfirming(false)
    setOpen(nextOpen)
  }

  React.useEffect(() => {
    if (!open || !channelId || !quotaKey) return

    let cancelled = false

    fetchChannelPlanQuota(channelId, channelUpdatedAt)
      .then((result) => {
        if (!cancelled) setLoadedQuota({ channelKey: quotaKey, result })
      })

    return () => {
      cancelled = true
    }
  }, [open, channelId, channelUpdatedAt, quotaKey])

  // 压缩中 → 按钮位置显示 spinner
  if (displayIsCompacting) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(inputToolbarButtonClass, 'text-muted-foreground cursor-default')}
        disabled
      >
        <Loader2 className="size-4 animate-spin" />
      </Button>
    )
  }

  // 使用稳定值：优先当前数据，回退到上次有效数据
  const stable = stableRef.current
  const hasCurrent = displayInputTokens != null && (displayInputTokens > 0 || displayUsageStatus === 'known')
  const displayTokens = hasCurrent ? displayInputTokens : stable?.inputTokens
  const displayWindow = hasCurrent ? displayContextWindow : stable?.contextWindow
  const displayOutput = hasCurrent ? displayOutputTokens : stable?.outputTokens
  const displayCacheRead = hasCurrent ? displayCacheReadTokens : stable?.cacheReadTokens
  const displayCacheCreation = hasCurrent ? displayCacheCreationTokens : stable?.cacheCreationTokens
  const displayCost = sessionId ? sessionStreamState.costUsd : costUsd

  /** 有明确的未知报告时显示问号入口；没有任何用量事件时保持隐藏。 */
  const isUsageUnavailable = displayUsageStatus === 'unknown' || displayUsageStatus === 'partial'
  if (displayTokens == null && !isUsageUnavailable) return null

  // 警告阈值：Pi 在自动压缩阈值的 80% 时预警。
  const compactThreshold = displayWindow
    ? calculatePiAutoCompactionThresholdTokens(displayWindow)
    : undefined
  const isWarning = compactThreshold && displayTokens != null
    ? displayTokens / compactThreshold >= WARNING_RATIO
    : false

  const ratio = displayWindow && displayTokens != null ? displayTokens / displayWindow : 0

  const percent = displayWindow && displayTokens != null
    ? Math.round((displayTokens / displayWindow) * 100)
    : undefined

  /** 屏幕阅读器和悬浮入口都明确说明数值是本次报告还是最近已知值。 */
  const usageLabel = isUsageUnavailable
    ? `${displayUsageStatus === 'partial' ? '用量仅部分统计' : '用量未知'}${displayTokens != null ? '，显示最近已知值' : ''}`
    : `上下文用量 ${percent != null ? `${percent}%` : `${displayTokens} tokens`}`

  const shouldShowPlanQuota = quota != null && (
    quota.supported
    || quota.windows.length > 0
    || quota.message !== UNSUPPORTED_PLAN_QUOTA_MESSAGE
  )

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={usageLabel}
          title={usageLabel}
          className={cn(
            inputToolbarButtonClass,
            isWarning ? 'text-amber-600 dark:text-amber-400' : 'text-foreground/60 hover:text-foreground',
          )}
          onMouseEnter={() => {
            cancelClose()
            setOpen(true)
          }}
          onMouseLeave={scheduleClose}
        >
          {displayTokens == null ? <span aria-hidden="true">?</span> : <UsageRing ratio={ratio} isWarning={isWarning} />}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={8}
        className="w-[320px] max-h-[70vh] overflow-y-auto p-2.5"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
        onFocusCapture={() => {
          popoverReceivedFocusRef.current = true
        }}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(event) => {
          preventHoverPopoverFocusRestore(event, popoverReceivedFocusRef.current)
          popoverReceivedFocusRef.current = false
        }}
      >
        <div className="flex w-full flex-col gap-1.5">
          <ContextUsageStats
            sessionId={sessionId}
            usedTokens={displayTokens}
            outputTokens={displayOutput}
            cacheReadTokens={displayCacheRead}
            cacheCreationTokens={displayCacheCreation}
            contextWindow={displayWindow}
            turnCostUsd={displayCost}
            thinkingEstimatedTokens={sessionStreamState.thinkingEstimatedTokens}
            isEstimated={displayIsEstimated}
            compactedPercent={percent}
            isUsageUnavailable={isUsageUnavailable}
            usageLabel={usageLabel}
          />

          {shouldShowPlanQuota ? (
            <>
              <div className="h-px bg-border my-0.5" />
              <div className="text-[11px] font-medium text-foreground/70">
                订阅额度{quota?.planName ? ` · ${quota.planName}` : ''}
              </div>
              {quota?.supported && quota.windows.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  {quota.windows.map((quotaWindow) => (
                    <PlanQuotaRow key={`${quotaWindow.type}-${quotaWindow.label}`} quotaWindow={quotaWindow} provider={quota.provider} />
                  ))}
                </div>
              ) : (
                <div className="text-[11px] text-foreground/50">
                  {quota?.message ?? '订阅额度查询失败'}
                </div>
              )}
            </>
          ) : null}

          <div className="h-px bg-border my-0.5" />
          <Button
            type="button"
            variant={confirming ? 'destructive' : isWarning ? 'default' : 'outline'}
            size="sm"
            className={cn(
              'h-7 text-xs gap-1.5 select-none',
              isWarning && !confirming && 'bg-amber-500 hover:bg-amber-600 text-white',
            )}
            onClick={() => {
              if (isProcessing) return
              if (confirming) {
                setConfirming(false)
                onCompact()
                setOpen(false)
                return
              }
              setConfirming(true)
            }}
            disabled={isProcessing}
          >
            <Minimize2 className="size-3.5" />
            {isProcessing ? '对话进行中' : confirming ? '再次点击确认压缩' : '手动压缩'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** 面板统计区的 props：全部来自当前会话的流状态与已持久化消息。 */
interface ContextUsageStatsProps {
  sessionId?: string
  usedTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  contextWindow?: number
  turnCostUsd?: number
  thinkingEstimatedTokens?: number
  isEstimated?: boolean
  compactedPercent?: number
  isUsageUnavailable: boolean
  usageLabel: string
}

/**
 * 上下文用量面板的统计区。
 *
 * 参考 PI-Desktop 的 ContextUsageInspector，把“剩余、会话成本、模型用量、
 * 工具上下文”放到同一处。运行时没有提供的耗时分解保持“暂不可用”，
 * 不推测数值。
 */
export function ContextUsageStats({
  sessionId,
  usedTokens,
  outputTokens,
  cacheReadTokens,
  cacheCreationTokens,
  contextWindow,
  turnCostUsd,
  thinkingEstimatedTokens,
  isEstimated,
  compactedPercent,
  isUsageUnavailable,
  usageLabel,
}: ContextUsageStatsProps): React.ReactElement {
  const messagesCache = useAtomValue(agentSDKMessagesCacheAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const sessionMeta = sessionId ? sessions.find((session) => session.id === sessionId) : undefined
  const messages = React.useMemo(
    () => (sessionId ? messagesCache.get(sessionId) ?? [] : []),
    [messagesCache, sessionId],
  )
  // 会话耗时按秒刷新；面板关闭时子组件不渲染，定时器随之销毁。
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const summary = React.useMemo(() => buildContextUsageSummary({
    usedTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    contextWindow,
    turnCostUsd,
    thinkingEstimatedTokens,
    messages,
    sessionCreatedAt: sessionMeta?.createdAt,
    now,
  }), [
    usedTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    contextWindow,
    turnCostUsd,
    thinkingEstimatedTokens,
    messages,
    sessionMeta?.createdAt,
    now,
  ])

  // 生成速度只在有结果耗时时计算；整轮时长会低估纯生成速度，因此不做实时猜测。
  const generationTokensPerSecond = React.useMemo(() => {
    const output = outputTokens ?? 0
    if (output <= 0) return undefined
    let durationMs: number | undefined
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const value = (messages[index] as { _durationMs?: unknown })._durationMs
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        durationMs = value
        break
      }
    }
    return durationMs !== undefined ? Math.round(output / (durationMs / 1000)) : undefined
  }, [messages, outputTokens])

  const usedPercent = compactedPercent ?? summary.usedPercent
  const toolSummary = summary.toolCallCount > 0
    ? `${summary.tools.length} 种工具 · ${summary.toolCallCount} 次调用 · 约 ${formatCompactTokens(summary.toolTotalTokens)} tokens`
    : '暂无工具调用'

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-semibold text-foreground">
          {isEstimated
            ? `压缩后 预估 ${formatCompactTokens(usedTokens ?? 0)} tokens`
            : summary.remainingTokens != null
              ? `剩余 ${formatCompactTokens(summary.remainingTokens)} tokens`
              : '上下文用量未知'}
        </span>
        <span className="text-sm font-semibold tabular-nums text-foreground">
          {isEstimated
            ? `${usedPercent ?? '—'}%`
            : `${summary.remainingPercent ?? '—'}%`}
        </span>
      </div>

      {contextWindow ? (
        <div className="flex items-baseline justify-between gap-3 text-xs">
          <span className="text-foreground/70">上下文窗口</span>
          <span className="tabular-nums text-foreground/90">
            {formatCompactTokens(usedTokens ?? 0)} / {formatCompactTokens(contextWindow)} tokens
          </span>
          <span className="tabular-nums text-foreground/50">{usedPercent ?? '—'}%</span>
        </div>
      ) : null}

      {isUsageUnavailable ? <DetailRow label="本次用量" value={usageLabel} /> : null}

      <div className="h-px bg-border" />
      <DetailRow label="本轮合计" value={summary.turnTotal != null ? formatCompactTokens(summary.turnTotal) : '—'} />
      <DetailRow
        label="生成速度"
        value={generationTokensPerSecond != null ? `${generationTokensPerSecond} tokens/s` : '—'}
      />
      <DetailRow label="本轮费用" value={formatUsd(turnCostUsd) ?? '—'} />
      <DetailRow label="会话累计" value={formatUsd(summary.sessionCostUsd) ?? '—'} />
      <DetailRow label="会话总耗时" value={formatElapsedDuration(summary.sessionElapsedMs)} />

      <div className="h-px bg-border" />
      <DetailRow label="网络请求耗时" value="暂不可用" />
      <DetailRow label="模型响应耗时" value="暂不可用" />
      <DetailRow label="工具调用耗时" value="暂不可用" />

      <div className="h-px bg-border" />
      <div className="space-y-1 text-xs">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-foreground/70">模型用量</span>
          <span className="flex flex-wrap justify-end gap-x-3 gap-y-0.5 text-right tabular-nums text-foreground/90">
            <span>输入 {formatCompactTokens(usedTokens ?? 0)}</span>
            <span>输出 {formatCompactTokens(outputTokens ?? 0)}</span>
            {cacheReadTokens ? <span>缓存读取 {formatCompactTokens(cacheReadTokens)}</span> : null}
          </span>
        </div>
        {(cacheCreationTokens || summary.cacheHitRate != null || summary.reasoningTokens != null) ? (
          <div className="flex flex-wrap justify-end gap-x-3 gap-y-0.5 text-right tabular-nums text-foreground/90">
            {cacheCreationTokens ? <span>缓存写入 {formatCompactTokens(cacheCreationTokens)}</span> : null}
            {summary.cacheHitRate != null ? <span>缓存命中率 {summary.cacheHitRate}%</span> : null}
            {summary.reasoningTokens != null ? <span>推理（估算） {formatCompactTokens(summary.reasoningTokens)}</span> : null}
          </div>
        ) : null}
      </div>

      <div className="flex items-start justify-between gap-3 text-xs">
        <span className="shrink-0 text-foreground/70">工具上下文</span>
        <span className="text-right tabular-nums text-foreground/90">{toolSummary}</span>
      </div>
      {summary.compactionCount > 0 ? (
        <DetailRow label="压缩次数" value={String(summary.compactionCount)} />
      ) : null}
    </div>
  )
}
