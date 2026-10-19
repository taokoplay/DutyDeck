import { Braces, Blocks, Factory, Film, Globe2, MousePointer2, ServerCog, SquareTerminal, Workflow } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/** 沿用右侧工具栏的模块图标，供工具栏、模块选择、目录和插件卡片共用。 */
const AGENT_MODULE_ICONS: Readonly<Record<string, LucideIcon>> = Object.freeze({
  canvas: Workflow,
  'visual-production': Film,
  'interaction-design': MousePointer2,
  browser: Globe2,
  terminal: SquareTerminal,
  'server-ops': ServerCog,
  'api-workbench': Braces,
  'capability-factory': Factory,
})

/** 根据模块 ID 返回对应图标；未知的第三方模块使用通用 Blocks 图标。 */
export function getAgentModuleIcon(moduleId: string): LucideIcon {
  return AGENT_MODULE_ICONS[moduleId] ?? Blocks
}
