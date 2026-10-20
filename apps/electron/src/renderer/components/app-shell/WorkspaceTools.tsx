import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import { Blocks, Brain, CalendarDays, Clock, FolderOpen, Globe, ListTodo, Plug, SquareTerminal } from 'lucide-react'
import { getAgentModuleIcon } from '@/components/agent/module-icons'
import { WorkspaceToolRail } from './WorkspaceToolRail'
import type { WorkspaceToolRailItem } from './WorkspaceToolRail'
import { ObsidianIcon } from '@/components/obsidian/obsidian-brand'
import { activeWorkspaceToolAtom, openWorkspaceToolAtom, workspaceProjectAtom, workspaceToolAvailabilityAtom, workspaceToolsExpandedAtom, type WorkspaceToolId } from '@/atoms/workspace-tools'
import { agentSessionInputStreamStateAtomFamily, agentWorkspacesAtom, currentAgentSessionIdAtom, workspaceCapabilitiesVersionAtom } from '@/atoms/agent-atoms'
import { agentSessionModuleCatalogAtomFamily } from '@/atoms/agent-module-atoms'
import { attachAgentModule, detachAgentModule, loadAgentModuleCatalog, loadAgentSessionModuleCatalog } from '@/components/agent/agent-module-loader'
import { automationsAtom } from '@/atoms/automation-atoms'
import { settingsOpenAtom, settingsTabAtom } from '@/atoms/settings-tab'
import { appModeAtom } from '@/atoms/app-mode'

/** 固定入口按已确认的四组排列；各工具及外观入口使用不同图标，业务可用性统一来自命令 atom。 */
const TOOL_ITEMS: WorkspaceToolRailItem[] = [
  { id: 'browser', label: '新建浏览器标签', group: '工作区', icon: Globe, keywords: 'browser 网页' },
  { id: 'files', label: '打开文件', group: '工作区', icon: FolderOpen, keywords: 'files 文件夹' },
  { id: 'terminal', label: '新建终端', group: '工作区', icon: SquareTerminal, keywords: 'terminal shell' },
  { id: 'todos', label: 'Todo', group: '效率', icon: ListTodo, keywords: '待办 任务' },
  { id: 'calendar', label: '日程', group: '效率', icon: CalendarDays, keywords: 'calendar' },
  { id: 'automations', label: '定时任务', group: '效率', icon: Clock, keywords: 'automation 计划' },
  { id: 'memory', label: '项目知识库', group: '知识与能力', icon: Brain, keywords: 'memory 记忆' },
  { id: 'vault', label: 'Obsidian', group: '知识与能力', icon: ObsidianIcon, keywords: 'vault 笔记' },
  { id: 'skills', label: 'Skills', group: '知识与能力', icon: Blocks, keywords: '技能' },
  { id: 'mcp', label: 'MCP', group: '知识与能力', icon: Plug, keywords: '服务 插件' },
  { id: 'interaction-design', label: '交互设计', group: '专业工具', icon: getAgentModuleIcon('interaction-design'), keywords: '原型 页面 prototype interaction' },
  { id: 'visual-production', label: '影像创作', group: '专业工具', icon: getAgentModuleIcon('visual-production'), keywords: '漫剧 影片 宣传片 图片 分镜 visual production' },
  { id: 'canvas', label: '画布', group: '专业工具', icon: getAgentModuleIcon('canvas'), keywords: 'canvas 设计' },
  { id: 'server-ops', label: '服务器运维', group: '专业工具', icon: getAgentModuleIcon('server-ops'), keywords: 'server ops SSH 数据库' },
  { id: 'api-workbench', label: '接口工作台', group: '专业工具', icon: getAgentModuleIcon('api-workbench'), keywords: 'API HTTP' },
  { id: 'capability-factory', label: '编排工厂', group: '专业工具', icon: getAgentModuleIcon('capability-factory'), keywords: 'factory 能力' },
]

/** 旧版静态入口只作为目录 IPC 尚未完成时的首屏兜底；目录返回后由可信清单替换。 */
const BUILTIN_MODULE_IDS = new Set(['interaction-design', 'visual-production', 'canvas', 'server-ops', 'api-workbench', 'capability-factory'])

/** 常驻工具菜单负责显示真实可用状态，资源生命周期仍由现有工作区拥有。 */
export function WorkspaceTools(): React.ReactElement {
  /** 界面状态和导航动作共享同一 Jotai store，不使用原型独立主题缓存。 */
  const [expanded, setExpanded] = useAtom(workspaceToolsExpandedAtom)
  const availability = useAtomValue(workspaceToolAvailabilityAtom)
  const activeTool = useAtomValue(activeWorkspaceToolAtom)
  const openTool = useSetAtom(openWorkspaceToolAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)
  const automations = useAtomValue(automationsAtom)
  const projectId = useAtomValue(workspaceProjectAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const capabilitiesVersion = useAtomValue(workspaceCapabilitiesVersionAtom)
  const appMode = useAtomValue(appModeAtom)
  const sessionId = useAtomValue(currentAgentSessionIdAtom)
  const sessionStreamState = useAtomValue(agentSessionInputStreamStateAtomFamily(sessionId ?? '__none__'))
  const moduleCatalog = useAtomValue(agentSessionModuleCatalogAtomFamily(sessionId ?? '__none__'))
  const store = useStore()
  const workspaceSlug = workspaces.find((workspace) => workspace.id === projectId)?.slug
  /** 只保留当前项目的更新提示，异步读取不能覆盖已切换的项目。 */
  const [skillsHaveUpdate, setSkillsHaveUpdate] = React.useState(false)

  React.useEffect(() => {
    void loadAgentModuleCatalog(store, window.electronAPI)
    const unsubscribe = window.electronAPI.onContentPluginsChanged?.(() => {
      void loadAgentModuleCatalog(store, window.electronAPI, true)
      if (sessionId) void loadAgentSessionModuleCatalog(store, window.electronAPI, sessionId, true)
    })
    return unsubscribe
  }, [sessionId, store])

  React.useEffect(() => {
    if (appMode !== 'agent' || !sessionId) return
    void loadAgentSessionModuleCatalog(store, window.electronAPI, sessionId)
  }, [appMode, sessionId, store])

  React.useEffect(() => {
    /** 仅项目或能力版本变化时读取一次，沿用旧左栏查询，无轮询或资源常驻。 */
    let disposed = false
    setSkillsHaveUpdate(false)
    if (appMode !== 'agent' || !workspaceSlug) return
    void window.electronAPI.getWorkspaceCapabilities(workspaceSlug)
      .then((capabilities) => {
        if (!disposed) setSkillsHaveUpdate(capabilities.skills.some((skill) => skill.hasUpdate))
      })
      .catch((error: unknown) => console.error('[工具菜单] 读取技能更新失败:', error))
    return () => { disposed = true }
  }, [appMode, workspaceSlug, capabilitiesVersion])

  /** 只有 Agent 模式的当前会话可以显示 Session 模块，避免 Chat 复用旧会话目录。 */
  const showSessionModules = appMode === 'agent' && Boolean(sessionId)
  /** Session 目录返回后替换静态专业模块；未知 surface 不进入菜单。 */
  const moduleItems: WorkspaceToolRailItem[] = showSessionModules ? (moduleCatalog?.entries.map((entry) => ({
    id: entry.id,
    label: entry.displayName,
    group: entry.group,
    icon: getAgentModuleIcon(entry.id),
    keywords: `${entry.id} ${entry.description}`,
    active: activeTool === entry.surfaceId,
    disabledReason: entry.state === 'unavailable' ? entry.reason : availability[entry.surfaceId as WorkspaceToolId]?.disabledReason,
    moduleState: entry.state,
    statusLabel: entry.state === 'attached' ? (sessionStreamState.running || sessionStreamState.backgroundWaiting ? '下一轮生效' : '已接入') : entry.reason ? '重新接入' : entry.state === 'available' ? '点击接入' : '不可用',
    onRemove: entry.state === 'attached' ? () => { void detachAgentModule(store, window.electronAPI, sessionId ?? '', entry.id) } : undefined,
  })) ?? []) : []
  const staticItems = TOOL_ITEMS.filter((item) => !moduleCatalog || !BUILTIN_MODULE_IDS.has(item.id))
  /** 轻量派生工具菜单；模块接入状态直接来自 Session 目录。 */
  const items = [...staticItems.filter((item) => availability[item.id as WorkspaceToolId]?.visible).map((item) => ({
    ...item,
    active: activeTool === item.id,
    disabledReason: availability[item.id as WorkspaceToolId]?.disabledReason,
    badge: item.id === 'automations' && automations.length > 0 ? (automations.length > 99 ? '99+' : String(automations.length)) : undefined,
    showUpdate: item.id === 'skills' && skillsHaveUpdate,
  })), ...moduleItems]

  const handleSelect = (id: string): void => {
    const module = moduleCatalog?.entries.find((entry) => entry.id === id)
    if (!module || !sessionId) {
      openTool(id as WorkspaceToolId)
      return
    }
    if (module.state === 'unavailable') return
    if (module.state === 'attached') {
      openTool(module.surfaceId as WorkspaceToolId)
      return
    }
    void attachAgentModule(store, window.electronAPI, sessionId, module.id).then((catalog) => {
      if (catalog) openTool(module.surfaceId as WorkspaceToolId)
    })
  }

  return <WorkspaceToolRail expanded={expanded} onExpandedChange={setExpanded} items={items} onSelect={handleSelect} onAppearance={() => {
    setSettingsTab('appearance')
    setSettingsOpen(true)
  }} />
}
