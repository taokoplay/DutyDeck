import { describe, expect, test } from 'bun:test'
import {
  PLUGIN_SURFACE_THEME_MESSAGE,
  createPluginSurfaceTheme,
  isPluginSurfaceThemeMessage,
  pluginSurfaceThemeVariables,
} from '../src/index.js'

describe('Given 插件 Surface 主题合同', () => {
  test('When 宿主提供 CSS 计算值 Then 生成统一设计令牌', () => {
    const theme = createPluginSurfaceTheme({
      mode: 'dark',
      className: 'dark theme-ocean-dark',
      fontFamily: 'Inter, sans-serif',
      monoFontFamily: 'JetBrains Mono, monospace',
      colors: {
        background: '210 12% 13%',
        foreground: '#f2f5f7',
        card: '210 12% 16%',
        'card-foreground': '210 14% 92%',
        popover: '210 12% 17%',
        'popover-foreground': '210 14% 94%',
        dialog: '210 12% 21%',
        'dialog-foreground': '210 14% 92%',
        primary: '210 80% 66%',
        'primary-foreground': '210 20% 8%',
        secondary: '210 12% 20%',
        'secondary-foreground': '210 14% 92%',
        muted: '210 12% 17%',
        'muted-foreground': '210 10% 60%',
        accent: '210 15% 25%',
        'accent-foreground': '210 14% 94%',
        destructive: '0 65% 58%',
        'destructive-foreground': '0 0% 100%',
        border: '210 12% 24%',
        input: '210 12% 22%',
        ring: '210 80% 66%',
        'content-area': '210 12% 10%',
        'sidebar-surface': '210 12% 13%',
        'tabbar-surface': '210 12% 13%',
      },
      radius: { base: '6px', cap: '6px', xl: '8px', xxl: '10px' },
      shadows: { xs: 'shadow-xs', sm: 'shadow-sm', md: 'shadow-md', lg: 'shadow-lg', xl: 'shadow-xl' },
    })
    const variables = pluginSurfaceThemeVariables(theme)
    expect(variables['--dutydeck-background']).toBe('hsl(210 12% 13%)')
    expect(variables['--dutydeck-foreground']).toBe('#f2f5f7')
    expect(variables['--dutydeck-radius']).toBe('6px')
    expect(variables['--dutydeck-font-family']).toBe('Inter, sans-serif')
    expect(variables['--dutydeck-color-scheme']).toBe('dark')
  })

  test('When 收到主题消息 Then 只接受完整合同', () => {
    const valid = {
      type: PLUGIN_SURFACE_THEME_MESSAGE,
      theme: createPluginSurfaceTheme({
        mode: 'light',
        className: '',
        fontFamily: 'system-ui',
        monoFontFamily: 'monospace',
        colors: Object.fromEntries(
          ['background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground', 'dialog', 'dialog-foreground', 'primary', 'primary-foreground', 'secondary', 'secondary-foreground', 'muted', 'muted-foreground', 'accent', 'accent-foreground', 'destructive', 'destructive-foreground', 'border', 'input', 'ring', 'content-area', 'sidebar-surface', 'tabbar-surface']
            .map(token => [token, '0 0% 50%']),
        ) as never,
        radius: { base: '6px', cap: '6px', xl: '8px', xxl: '10px' },
        shadows: { xs: 'none', sm: 'none', md: 'none', lg: 'none', xl: 'none' },
      }),
    }
    expect(isPluginSurfaceThemeMessage(valid)).toBe(true)
    expect(isPluginSurfaceThemeMessage({ ...valid, extra: true })).toBe(false)
    expect(isPluginSurfaceThemeMessage({ type: PLUGIN_SURFACE_THEME_MESSAGE, theme: { mode: 'light' } })).toBe(false)
    expect(isPluginSurfaceThemeMessage({
      ...valid,
      theme: {
        ...valid.theme,
        radius: { base: '6px', cap: '6px', xl: '8px' },
      },
    })).toBe(false)
  })

  test('When 宿主颜色为空或已解析 Then 保留合法 CSS 值而不生成无效 hsl 包装', () => {
    const colors = Object.fromEntries(
      ['background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground', 'dialog', 'dialog-foreground', 'primary', 'primary-foreground', 'secondary', 'secondary-foreground', 'muted', 'muted-foreground', 'accent', 'accent-foreground', 'destructive', 'destructive-foreground', 'border', 'input', 'ring', 'content-area', 'sidebar-surface', 'tabbar-surface']
        .map(token => [token, token === 'background' ? '' : token === 'foreground' ? 'currentColor' : '0 0% 50%']),
    ) as never
    const theme = createPluginSurfaceTheme({
      mode: 'light',
      className: '',
      fontFamily: 'system-ui',
      monoFontFamily: 'monospace',
      colors,
      radius: { base: '6px', cap: '6px', xl: '8px', xxl: '10px' },
      shadows: { xs: 'none', sm: 'none', md: 'none', lg: 'none', xl: 'none' },
    })
    expect(theme.colors.background).toBe('transparent')
    expect(theme.colors.foreground).toBe('currentColor')
  })
})
