import {
  PLUGIN_SURFACE_COLOR_TOKENS,
  createPluginSurfaceTheme,
  type PluginSurfaceColorToken,
  type PluginSurfaceTheme,
} from '@dutydeck/plugin-sdk'

/** 读取主题所需的最小计算样式接口，便于测试而不依赖浏览器。 */
export interface PluginSurfaceComputedStyles {
  fontFamily: string
  getPropertyValue(name: string): string
}

/** 读取单个主题变量，缺失时使用 Surface 安全回退。 */
function read(styles: PluginSurfaceComputedStyles, name: string, fallback = ''): string {
  return styles.getPropertyValue(name).trim() || fallback
}

/**
 * 从宿主计算样式生成 Surface 主题；颜色保持宿主最终解析值。
 * @param input 当前模式、主题类与计算样式。
 * @returns 可安全序列化到 iframe 的主题合同。
 */
export function pluginSurfaceThemeFromStyles(input: {
  mode: 'light' | 'dark'
  className: string
  fontFamily: string
  getPropertyValue(name: string): string
}): PluginSurfaceTheme {
  const colors = Object.fromEntries(
    PLUGIN_SURFACE_COLOR_TOKENS.map(token => [
      token,
      read(input, `--${token}`, token === 'foreground' ? '#000' : 'transparent'),
    ]),
  ) as Record<PluginSurfaceColorToken, string>
  const radiusBase = read(input, '--radius', '0.375rem')
  const radiusCap = read(input, '--radius-cap', radiusBase)
  const radiusXlExtra = read(input, '--radius-xl-extra', '2px')
  const radius2xlExtra = read(input, '--radius-2xl-extra', '4px')
  return createPluginSurfaceTheme({
    mode: input.mode,
    className: input.className,
    colors,
    radius: {
      base: radiusBase,
      cap: radiusCap,
      xl: `calc(${radiusBase} + ${radiusXlExtra})`,
      xxl: `calc(${radiusBase} + ${radius2xlExtra})`,
    },
    shadows: {
      xs: read(input, '--shadow-xs', 'none'),
      sm: read(input, '--shadow-sm', 'none'),
      md: read(input, '--shadow-md', 'none'),
      lg: read(input, '--shadow-lg', 'none'),
      xl: read(input, '--shadow-xl', 'none'),
    },
    fontFamily: input.fontFamily || 'system-ui, sans-serif',
    monoFontFamily: read(input, '--font-mono', 'ui-monospace, SFMono-Regular, Menlo, monospace'),
  })
}

/** 从当前 documentElement 读取主题；只在 renderer 浏览器环境调用。 */
export function readPluginSurfaceTheme(root: HTMLElement = document.documentElement): PluginSurfaceTheme {
  const styles = window.getComputedStyle(root)
  return pluginSurfaceThemeFromStyles({
    mode: root.classList.contains('dark') ? 'dark' : 'light',
    className: root.className,
    fontFamily: styles.fontFamily,
    getPropertyValue: name => styles.getPropertyValue(name),
  })
}
