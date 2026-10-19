import * as React from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { LayoutDashboard, Clapperboard, MousePointer2, Globe2, SquareTerminal, MoreHorizontal, Loader2, Check } from 'lucide-react'
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
}

/**
 * 聊天输入框上方的模块选择栏；点击模块只更新 Session 策略，不直接执行 Skill。
 * @param sessionId 当前 Agent Session。
 * @param disabled 当前输入区域是否不可交互。
 */
export function AgentModuleBar({ sessionId, disabled = false }: AgentModuleBarProps): React.ReactElement {
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

  React.useEffect(() => {
    void loadAgentModuleCatalog(store, window.electronAPI)
  }, [store])

  React.useEffect(() => {
    setOpen(false)
    void loadAgentModulePolicy(store, window.electronAPI, sessionId)
  }, [store, sessionId])

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

  const visibleModules = modules.slice(0, 4)
  const failedCount = health.filter((entry) => entry.state === 'failed').length
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-border/50 px-3 py-1.5" data-testid="agent-module-bar">
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
            onClick={() => void toggleAgentModule(store, window.electronAPI, sessionId, module.id)}
          >
            <Icon className="size-3.5" />
            <span>{module.displayName}</span>
            {pinned && <span className="text-[10px] text-primary">固定</span>}
          </Button>
        )
      })}
      {modules.length > visibleModules.length && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button type="button" size="sm" variant="ghost" className="h-7 px-2" aria-expanded={open} aria-label="显示全部模块">
              <MoreHorizontal className="size-3.5" />
              <span className="sr-only">更多模块</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-2">
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
                    disabled={disabled || !policy || policyBusy}
                    className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50', active && 'bg-muted/70')}
                    onClick={() => void toggleAgentModule(store, window.electronAPI, sessionId, module.id)}
                  >
                    <Icon className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{module.displayName}</span>
                    {pinned && <span className="text-[10px] text-primary">固定</span>}
                    {active && <Check className="size-3.5 text-primary" aria-label="已启用" />}
                  </button>
                )
              })}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}
