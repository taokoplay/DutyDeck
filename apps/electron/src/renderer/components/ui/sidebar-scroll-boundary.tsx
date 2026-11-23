import * as React from 'react'

/** 服务端使用普通 effect，浏览器端在布局提交后同步滚动边界，避免 SSR 警告。 */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect

interface SidebarScrollBoundaryProps {
  /** 唯一直接 DOM 子元素必须是列表的原生滚动容器。 */
  children: React.ReactNode
}

/**
 * 为侧栏滚动列表提供局部顶部边界反馈。
 *
 * 滚动状态只在该组件内部更新，避免每次滚动都让 LeftSidebar 重新渲染；
 * 列表本身仍保留原生滚动与虚拟化行为。
 */
export function SidebarScrollBoundary({ children }: SidebarScrollBoundaryProps): React.ReactElement {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const scrolledRef = React.useRef(false)
  const [isScrolled, setIsScrolled] = React.useState(false)

  /** 根据列表实际滚动位置同步顶部反馈状态。 */
  const syncScrollState = React.useCallback((): void => {
    const scrollContainer = rootRef.current?.firstElementChild
    if (!(scrollContainer instanceof HTMLElement)) return

    // 忽略回弹负值和亚像素偏移；只有跨越顶部边界时才触发 React 更新。
    const nextIsScrolled = scrollContainer.scrollTop > 1
    if (scrolledRef.current === nextIsScrolled) return
    scrolledRef.current = nextIsScrolled
    setIsScrolled(nextIsScrolled)
  }, [])

  // 挂载、切换内容及列表缩短后同步实际位置，不重置用户滚动位置。
  useIsomorphicLayoutEffect(syncScrollState)

  /** 只响应直接列表容器的滚动，避免嵌套预览滚动影响边界提示。 */
  const handleScrollCapture = React.useCallback((event: React.UIEvent<HTMLDivElement>): void => {
    if (event.target === rootRef.current?.firstElementChild) syncScrollState()
  }, [syncScrollState])

  return (
    <div
      ref={rootRef}
      className="relative flex min-h-0 flex-1 flex-col"
      onScrollCapture={handleScrollCapture}
    >
      {children}
      <div
        aria-hidden="true"
        data-sidebar-scroll-boundary={isScrolled ? 'scrolled' : 'top'}
        className={`pointer-events-none absolute inset-x-0 top-0 z-10 h-4 border-t-[0.5px] border-border bg-[linear-gradient(to_bottom,hsl(var(--sidebar-surface)/0.85)_0%,hsl(var(--sidebar-surface)/0)_100%)] transition-opacity duration-150 motion-reduce:transition-none ${isScrolled ? 'opacity-100' : 'opacity-0'}`}
      />
    </div>
  )
}
