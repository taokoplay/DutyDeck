import { describe, expect, test } from 'bun:test'
import { pluginSurfaceThemeFromStyles } from './plugin-surface-theme'

describe('Given 宿主计算样式', () => {
  test('When 读取深色主题 Then 生成与软件一致的 Surface 令牌', () => {
    const values: Record<string, string> = {
      '--background': '210 12% 13%',
      '--foreground': '210 14% 92%',
      '--card': '210 12% 16%',
      '--card-foreground': '210 14% 92%',
      '--popover': '210 12% 17%',
      '--popover-foreground': '210 14% 94%',
      '--dialog': '210 12% 21%',
      '--dialog-foreground': '210 14% 92%',
      '--primary': '210 80% 66%',
      '--primary-foreground': '210 20% 8%',
      '--secondary': '210 12% 20%',
      '--secondary-foreground': '210 14% 92%',
      '--muted': '210 12% 17%',
      '--muted-foreground': '210 10% 60%',
      '--accent': '210 15% 25%',
      '--accent-foreground': '210 14% 94%',
      '--destructive': '0 65% 58%',
      '--destructive-foreground': '0 0% 100%',
      '--border': '210 12% 24%',
      '--input': '210 12% 22%',
      '--ring': '210 80% 66%',
      '--content-area': '210 12% 10%',
      '--sidebar-surface': '210 12% 13%',
      '--tabbar-surface': '210 12% 13%',
      '--radius': '6px',
      '--radius-cap': '6px',
      '--radius-xl-extra': '2px',
      '--radius-2xl-extra': '4px',
      '--shadow-xs': 'none',
      '--shadow-sm': 'small',
      '--shadow-md': 'medium',
      '--shadow-lg': 'large',
      '--shadow-xl': 'xlarge',
      '--font-mono': 'JetBrains Mono',
    }
    const theme = pluginSurfaceThemeFromStyles({
      mode: 'dark',
      className: 'dark theme-ocean-dark',
      fontFamily: 'Inter',
      getPropertyValue: name => values[name] ?? '',
    })
    expect(theme.colors.background).toBe('hsl(210 12% 13%)')
    expect(theme.colors.dialog).toBe('hsl(210 12% 21%)')
    expect(theme.radius.xl).toBe('calc(6px + 2px)')
    expect(theme.fontFamily).toBe('Inter')
    expect(theme.className).toBe('dark theme-ocean-dark')
  })
})
