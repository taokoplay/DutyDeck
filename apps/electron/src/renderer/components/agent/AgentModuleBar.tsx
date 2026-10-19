import * as React from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { Blocks, LayoutDashboard, Clapperboard, MousePointer2, Globe2, SquareTerminal, MoreHorizontal, Loader2, Check, History } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  agentModulesAtom,
  agentModulesErrorAtom,
  agentModulesLoadingAtom,
  agentPluginHealthAtom,
  agentSessionModulePolicyAtomFamily,
  agentModulePolicyBusyAtomFamily,
  agentModulePolicyErrorAtomFamily,
} from '@/atoms/agent-module-atoms'
import { loadAgentModuleCatalog, loadAgentModulePolicy, toggleAgentModule } from './agent-module-loader'
import { AgentModuleRunAuditView } from './AgentModuleRunAuditView'
import type { RichTextInputHandle } from '@/components/ai-elements/rich-text-input'

const MODULE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  canvas: LayoutDashboard,
  'visual-production': Clapperboard,
  'interaction-design': MousePointer2,
  browser: Globe2,
  terminal: SquareTerminal,
}

interface AgentModuleBarProps {
  sessionId: string
  disabled?: boolean
  /** 消息模式把选择结果写入当前编辑器，而不是修改长期 Session 策略。 */
  messageMode?: boolean
  inputRef?: React.RefObject<RichTextInputHandle | null>
}

/**
 * Agent 模块入口；消息模式作为底部工具栏按钮，把显式模块调用写入当前草稿。
 * @param sessionId 当前 Agent Session。
 * @param disabled 当前输入区域是否不可交互。
 */
export function AgentModuleBar({ sessionId, disabled = false, messageMode = false, inputRef }: AgentModuleBarProps): React.ReactElement {
  const modules = useAtomValue(agentModulesAtom)
  const loading = useAtomValue(agentModulesLoadingAtom)
  const error = useAtomValue(agentModulesErrorAtom)
  const health = useAtomValue(agentPluginHealthAtom)
  /** 使用稳定 Store 将异步请求绑定到明确的会话，而不是渲染时的 setter。 */
  const store = useStore()
  const policy = useAtomValue(agentSessionModulePolicyAtomFamily(sessionId))
  const policyBusy = useAtomValue(agentModulePolicyBusyAtomFamily(sessionId))
  const policyError = useAtomValue(agentModulePolicyErrorAtomFamily(sessionId))
  const setHealth = useSetAtom(agentPluginHealthAtom)
  const [open, setOpen] = React.useState(false)
  /** 记录弹窗绑定打开时的会话，导航后立即卸载以隔离迟到结果。 */
  const [auditSessionId, setAuditSessionId] = React.useState<string | null>(null)
  /** 当前草稿中已经插入的显式模块，菜单保持打开时可连续多选。 */
  const [selectedModuleIds, setSelectedModuleIds] = React.useState<Set<string>>(new Set())
  /** 从弹窗返回时恢复到稳定入口，不依赖已经卸载的 Popover 菜单项。 */
  const moreButtonRef = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    void loadAgentModuleCatalog(store, window.electronAPI)
  }, [store])

  React.useEffect(() => {
    setOpen(false)
    setAuditSessionId(null)
    // 会话切换后，消息模式必须从新草稿重新读取模块，避免沿用上一会话的选中状态。
    if (messageMode) setSelectedModuleIds(new Set())
    void loadAgentModulePolicy(store, window.electronAPI, sessionId)
  }, [messageMode, store, sessionId])

  React.useEffect(() => {
    const releaseHealth = window.electronAPI.onAgentPluginHealthChanged((next) => {
      setHealth((current) => {
        const withoutCurrent = current.filter((entry) => entry.pluginId !== next.pluginId)
        return [...withoutCurrent, next].sort((left, right) => left.pluginId.localeCompare(right.pluginId))
      })
    })
    return releaseHealth
  }, [setHealth])

  /** 重试只重读失败的数据源，不会触发模块执行。 */
  const retryLoad = (): void => {
    if (error) void loadAgentModuleCatalog(store, window.electronAPI)
    if (policyError) void loadAgentModulePolicy(store, window.electronAPI, sessionId)
  }

  const syncSelectedModuleIds = React.useCallback((): void => {
    if (!messageMode) return
    setSelectedModuleIds(new Set(inputRef?.current?.getModuleMentionIds() ?? []))
  }, [inputRef, messageMode])

  React.useEffect(() => {
    if (!open) return
    syncSelectedModuleIds()
  }, [open, syncSelectedModuleIds])

  /** 消息模式只写入当前草稿；旧模式仍保留给集成 smoke 使用的 Session 策略入口。 */
  const handleModuleClick = (module: (typeof modules)[number]): void => {
    if (messageMode) {
      inputRef?.current?.toggleModuleMention({ id: module.id, label: module.displayName })
      syncSelectedModuleIds()
      return
    }
    void toggleAgentModule(store, window.electronAPI, sessionId, module.id)
  }

  const visibleModules = modules.slice(0, 4)
  const failedCount = health.filter((entry) => entry.state === 'failed').length
  const renderModuleMenu = (): React.ReactElement => (
    <>
      <div className="mb-1 px-2 text-xs font-medium text-foreground">{messageMode ? '选择模块' : '全部模块'}</div>
      {(error || policyError) && (
        <div className="mb-2 flex items-center gap-2 px-2 text-[11px] text-destructive">
          <span title={error ?? policyError ?? undefined}>模块不可用</span>
          <Button type="button" size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" disabled={loading || policyBusy} onClick={retryLoad}>重试</Button>
        </div>
      )}
      <div className="space-y-1">
        {modules.map((module) => {
          const Icon = MODULE_ICONS[module.id] ?? SquareTerminal
          const policyActive = (policy?.enabledModuleIds.includes(module.id) ?? false) && !policy?.disabledModuleIds.includes(module.id)
          const active = messageMode ? selectedModuleIds.has(module.id) : policyActive
          const pinned = policy?.pinnedModuleIds.includes(module.id) ?? false
          return (
            <button
              key={module.id}
              type="button"
              data-module-id={module.id}
              disabled={disabled || (!messageMode && (!policy || policyBusy))}
              aria-pressed={active}
              className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50', active && 'bg-muted/70')}
              onClick={() => handleModuleClick(module)}
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{module.displayName}</span>
              {pinned && <span className="text-[10px] text-primary">固定</span>}
              {active && <Check className="size-3.5 text-primary" aria-label="已选择" />}
            </button>
          )
        })}
        {!loading && modules.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">暂无可用模块</p>}
      </div>
      <div className="mt-2 border-t border-border/50 pt-1">
        <Button type="button" variant="ghost" size="sm" className="w-full justify-start gap-2 text-xs" aria-haspopup="dialog" onClick={() => {
          setOpen(false)
          setAuditSessionId(sessionId)
        }}>
          <History className="size-3.5" />
          调用记录
        </Button>
      </div>
    </>
  )

  return (
    <div className={cn(
      messageMode
        ? 'flex items-center'
        : 'flex flex-wrap items-center gap-1 border-b border-border/50 px-3 py-1.5',
    )} data-testid={messageMode ? 'agent-module-picker' : 'agent-module-bar'}>
      {messageMode ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button ref={moreButtonRef} data-session-id={sessionId} type="button" variant="ghost" size="icon" className={cn('size-8', selectedModuleIds.size > 0 && 'text-primary')} aria-expanded={open} aria-label="选择模块" title={failedCount > 0 ? `${failedCount} 个模块需要处理` : '选择模块'} disabled={disabled}>
              {loading ? <Loader2 className="size-4 animate-spin" /> : <Blocks className="size-4" />}
              {selectedModuleIds.size > 0 && <span className="sr-only">已选择 {selectedModuleIds.size} 个模块</span>}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" side="top" className="w-72 p-2" onCloseAutoFocus={(event) => {
            if (auditSessionId === sessionId) event.preventDefault()
          }}>
            {renderModuleMenu()}
          </PopoverContent>
        </Popover>
      ) : (
        <>
          <span className="mr-1 shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">模块</span>
          {(loading || policyBusy) && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="正在加载模块" />}
          {(error || policyError) && <>
            <span className="text-[11px] text-destructive" role="status" title={error ?? policyError ?? undefined}>模块不可用</span>
            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={loading || policyBusy} onClick={retryLoad}>重试模块加载</Button>
          </>}
          {failedCount > 0 && <span className="order-last basis-full text-[11px] text-amber-600 dark:text-amber-300" role="status" title="部分内置模块未能启动">{failedCount} 个模块需要处理</span>}
          {visibleModules.map((module) => {
            const Icon = MODULE_ICONS[module.id] ?? SquareTerminal
            const active = (policy?.enabledModuleIds.includes(module.id) ?? false) && !policy?.disabledModuleIds.includes(module.id)
            const pinned = policy?.pinnedModuleIds.includes(module.id) ?? false
            return (
              <Button
                key={module.id}
                type="button"
                size="sm"
                variant={active ? 'secondary' : 'ghost'}
                disabled={disabled || !policy || policyBusy}
                aria-pressed={active}
                title={module.description}
                className={cn('h-7 shrink-0 gap-1 px-2 text-xs', pinned && 'ring-1 ring-primary/40')}
                onClick={() => handleModuleClick(module)}
              >
                <Icon className="size-3.5" />
                <span>{module.displayName}</span>
                {pinned && <span className="text-[10px] text-primary">固定</span>}
              </Button>
            )
          })}
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button ref={moreButtonRef} data-session-id={sessionId} type="button" size="sm" variant="ghost" className="h-7 px-2" aria-expanded={open} aria-label="更多模块">
                <MoreHorizontal className="size-3.5" />
                <span className="sr-only">更多模块</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 p-2" onCloseAutoFocus={(event) => {
              // 打开记录时由 Dialog 接管焦点，防止 Popover 关闭后抢回输入。
              if (auditSessionId === sessionId) event.preventDefault()
            }}>
              <div className="mb-1 px-2 text-xs font-medium text-foreground">全部模块</div>
              <div className="space-y-1">
                {modules.map((module) => {
                  const Icon = MODULE_ICONS[module.id] ?? SquareTerminal
                  const active = (policy?.enabledModuleIds.includes(module.id) ?? false) && !policy?.disabledModuleIds.includes(module.id)
                  const pinned = policy?.pinnedModuleIds.includes(module.id) ?? false
                  return (
                    <button
                      key={module.id}
                      type="button"
                      data-module-id={module.id}
                      disabled={disabled || !policy || policyBusy}
                      className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50', active && 'bg-muted/70')}
                      onClick={() => handleModuleClick(module)}
                    >
                      <Icon className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{module.displayName}</span>
                      {pinned && <span className="text-[10px] text-primary">固定</span>}
                      {active && <Check className="size-3.5 text-primary" aria-label="已启用" />}
                    </button>
                  )
                })}
              </div>
              <div className="mt-2 border-t border-border/50 pt-1">
                <Button type="button" variant="ghost" size="sm" className="w-full justify-start gap-2 text-xs" aria-haspopup="dialog" onClick={() => {
                  setOpen(false)
                  setAuditSessionId(sessionId)
                }}>
                  <History className="size-3.5" />
                  调用记录
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </>
      )}
      {auditSessionId === sessionId && <AgentModuleRunAuditView
        sessionId={sessionId}
        onClose={() => setAuditSessionId(null)}
        onReturnFocus={() => {
          // 导航导致关闭时不把焦点从新会话或侧栏抢回。
          if (moreButtonRef.current?.dataset.sessionId === sessionId) moreButtonRef.current.focus()
        }}
      />}
    </div>
  )
}
