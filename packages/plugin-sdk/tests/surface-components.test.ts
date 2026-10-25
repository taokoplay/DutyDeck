import { describe, expect, test } from 'bun:test'
import { PLUGIN_SURFACE_COMPONENT_STYLES } from '../src/index.js'

describe('Given 插件 Surface 组件规范', () => {
  test('When 生成样式 Then 弹窗、表单和按钮复用 DutyDeck 尺寸与主题令牌', () => {
    expect(PLUGIN_SURFACE_COMPONENT_STYLES).toContain('.dd-dialog')
    expect(PLUGIN_SURFACE_COMPONENT_STYLES).toContain('width: min(32rem')
    expect(PLUGIN_SURFACE_COMPONENT_STYLES).toContain('padding: 1.5rem')
    expect(PLUGIN_SURFACE_COMPONENT_STYLES).toContain('border-radius: var(--dutydeck-radius-cap, 6px)')
    expect(PLUGIN_SURFACE_COMPONENT_STYLES).toContain('var(--dutydeck-dialog')
    expect(PLUGIN_SURFACE_COMPONENT_STYLES).toContain('var(--dutydeck-shadow-xl')
    expect(PLUGIN_SURFACE_COMPONENT_STYLES).toContain('height: 2.25rem')
    expect(PLUGIN_SURFACE_COMPONENT_STYLES).toContain('border-radius: calc(var(--dutydeck-radius, 6px) - 2px)')
    expect(PLUGIN_SURFACE_COMPONENT_STYLES).toContain('box-shadow: 0 0 0 4px')
    expect(PLUGIN_SURFACE_COMPONENT_STYLES).toContain('.dd-button:not([data-variant])')
    expect(PLUGIN_SURFACE_COMPONENT_STYLES).toContain('color: var(--dutydeck-foreground, #111827);\n  opacity: .6;')
    expect(PLUGIN_SURFACE_COMPONENT_STYLES).toContain('.dd-button[data-variant="outline"]')
  })

  test('When Surface 自带主题 Then 组件规范不另设固定深浅色判断', () => {
    expect(PLUGIN_SURFACE_COMPONENT_STYLES).not.toContain('prefers-color-scheme')
    expect(PLUGIN_SURFACE_COMPONENT_STYLES).toContain('@media (prefers-reduced-motion: reduce)')
  })
})
