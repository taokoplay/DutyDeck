import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Globe, Workflow } from 'lucide-react'
import { WorkspaceToolRail, filterWorkspaceTools, type WorkspaceToolRailItem } from './WorkspaceToolRail'

/** 最小工具夹具：验证可用入口与未就绪工具同时呈现。 */
const items: WorkspaceToolRailItem[] = [
  { id: 'browser', label: '新建浏览器标签', group: '工作区', icon: Globe, active: true, keywords: 'web 浏览网页' },
  { id: 'canvas', label: '画布', group: '专业工具', icon: Workflow, disabledReason: '请先选择项目' },
]

/** 仅渲染展示层，不访问真实会话、文件或 Electron API。 */
function renderRail(expanded: boolean): string {
  return renderToStaticMarkup(<WorkspaceToolRail expanded={expanded} items={items} onExpandedChange={() => {}} onSelect={() => {}} onAppearance={() => {}} />)
}

describe('统一工具菜单', () => {
  test('Given 收起状态 When 渲染 Then 保留工具名称和展开搜索入口且占用 78px', () => {
    const markup = renderRail(false)
    expect(markup).toContain('width:78px')
    expect(markup).toContain('aria-label="新建浏览器标签"')
    expect(markup).toContain('aria-label="展开并搜索工具"')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).not.toContain('type="search"')
  })
  test('Given 展开状态 When 渲染 Then 显示分组与搜索并占用 208px', () => {
    const markup = renderRail(true)
    expect(markup).toContain('width:208px')
    expect(markup).toContain('type="search"')
    expect(markup).toContain('工作区')
    expect(markup).toContain('专业工具')
    expect(markup).toContain('aria-label="外观设置"')
  })
  test('Given 工具数量超出可视区域 When 渲染 Then 保留滚动能力但隐藏滚动条', () => {
    const markup = renderRail(false)
    expect(markup).toContain('overflow-y-auto')
    expect(markup).toContain('scrollbar-none')
    expect(markup).not.toContain('[scrollbar-width:thin]')
  })
  test('Given 选中和禁用工具 When 渲染 Then 沿用主题选中态并明确禁用原因', () => {
    const markup = renderRail(false)
    expect(markup).toContain('bg-accent-foreground/[0.10]')
    expect(markup).toContain('text-accent-foreground')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).toContain('title="画布：请先选择项目"')
    expect(markup).toContain('disabled=""')
  })
  test('Given 已接入 Session 模块 When 展开工具菜单 Then 提供独立的移除按钮并保留主入口', () => {
    const markup = renderToStaticMarkup(<WorkspaceToolRail expanded items={[{
      ...items[0]!, moduleState: 'attached', statusLabel: '已接入', onRemove: () => {},
    }]} onExpandedChange={() => {}} onSelect={() => {}} onAppearance={() => {}} />)
    expect(markup).toContain('data-tool-state="attached"')
    expect(markup).toContain('aria-label="从本会话移除新建浏览器标签"')
    expect(markup).toContain('title="新建浏览器标签：已接入"')
    // 状态仍保留在无障碍语义和悬浮提示中，但不再占用菜单行的可视空间。
    expect(markup).not.toMatch(/<span[^>]*>已接入<\/span>/)
    // 移除按钮占用右侧空间时，主按钮不能再用 px-2 覆盖右侧预留。
    expect(markup).toMatch(/data-tool-id="browser"[^>]*class="[^"]*pl-2 pr-14[^"]*"/)
    expect(markup).not.toMatch(/data-tool-id="browser"[^>]*class="[^"]*px-2[^"]*"/)
  })
  test('Given 已接入但未打开面板的 Session 模块 When 渲染 Then 图标使用绿色表达当前会话权限', () => {
    const markup = renderToStaticMarkup(<WorkspaceToolRail expanded items={[{
      ...items[0]!, active: false, moduleState: 'attached', statusLabel: '已接入',
    }]} onExpandedChange={() => {}} onSelect={() => {}} onAppearance={() => {}} />)
    expect(markup).toContain('text-emerald-500 dark:text-emerald-400')
    expect(markup).toContain('aria-label="新建浏览器标签，已接入"')
    expect(markup).not.toContain('bg-accent-foreground/[0.10]')
  })
  test('Given 已接入且当前面板已打开的 Session 模块 When 渲染 Then 同时保留绿色权限图标和面板选中态', () => {
    const markup = renderToStaticMarkup(<WorkspaceToolRail expanded items={[{
      ...items[0]!, active: true, moduleState: 'attached', statusLabel: '已接入',
    }]} onExpandedChange={() => {}} onSelect={() => {}} onAppearance={() => {}} />)
    expect(markup).toContain('text-emerald-500 dark:text-emerald-400')
    expect(markup).toContain('bg-accent-foreground/[0.10]')
  })
  test('Given 查询 When 过滤 Then 按名称关键词和分组匹配、忽略大小写空白且无匹配为空', () => {
    expect(filterWorkspaceTools(items, ' WEB ')).toEqual([items[0]!])
    expect(filterWorkspaceTools(items, '专业')).toEqual([items[1]!])
    expect(filterWorkspaceTools(items, '不存在')).toEqual([])
    expect(filterWorkspaceTools(items, ' ')).toEqual(items)
  })
})
