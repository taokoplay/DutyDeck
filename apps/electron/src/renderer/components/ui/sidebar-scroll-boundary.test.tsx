import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SidebarScrollBoundary } from './sidebar-scroll-boundary'

describe('侧栏滚动边界', () => {
  test('Given 侧栏列表 When 首次渲染 Then 局部边界提示挂在列表容器外且默认隐藏', () => {
    const markup = renderToStaticMarkup(
      <SidebarScrollBoundary>
        <div className="overflow-y-auto">会话列表</div>
      </SidebarScrollBoundary>,
    )

    expect(markup).toContain('data-sidebar-scroll-boundary="top"')
    expect(markup).toContain('opacity-0')
    expect(markup).toContain('会话列表')
  })
})
