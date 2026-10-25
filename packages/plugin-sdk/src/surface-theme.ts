/** 宿主与 Surface 建立 MessagePort 的协议消息。 */
export const PLUGIN_SURFACE_CONNECTED_MESSAGE = 'dutydeck.plugin.surface.connected'

/** Surface 脚本就绪、请求宿主补发连接的协议消息。 */
export const PLUGIN_SURFACE_READY_MESSAGE = 'dutydeck.plugin.surface.ready'

/** 宿主推送给插件 Surface 的主题消息。 */
export const PLUGIN_SURFACE_THEME_MESSAGE = 'dutydeck.plugin.surface.theme'

/** 插件 Surface 可依赖的语义色令牌。 */
export const PLUGIN_SURFACE_COLOR_TOKENS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'dialog',
  'dialog-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'border',
  'input',
  'ring',
  'content-area',
  'sidebar-surface',
  'tabbar-surface',
] as const

/** 插件 Surface 颜色令牌名称。 */
export type PluginSurfaceColorToken = typeof PLUGIN_SURFACE_COLOR_TOKENS[number]

/** 插件 Surface 可依赖的圆角令牌。 */
export const PLUGIN_SURFACE_RADIUS_TOKENS = ['base', 'cap', 'xl', 'xxl'] as const

/** 插件 Surface 可依赖的阴影令牌。 */
export const PLUGIN_SURFACE_SHADOW_TOKENS = ['xs', 'sm', 'md', 'lg', 'xl'] as const

/** 宿主当前实际生效的 Surface 设计令牌。 */
export interface PluginSurfaceTheme {
  mode: 'light' | 'dark'
  className: string
  colors: Record<PluginSurfaceColorToken, string>
  radius: {
    base: string
    cap: string
    xl: string
    xxl: string
  }
  shadows: {
    xs: string
    sm: string
    md: string
    lg: string
    xl: string
  }
  fontFamily: string
  monoFontFamily: string
}

/** 新 Surface 创建主题所需的宿主计算值。 */
export interface CreatePluginSurfaceThemeInput {
  mode: 'light' | 'dark'
  className: string
  colors: Record<PluginSurfaceColorToken, string>
  radius: PluginSurfaceTheme['radius']
  shadows: PluginSurfaceTheme['shadows']
  fontFamily: string
  monoFontFamily: string
}

/** Surface 主题消息只接受精确的 type/theme 字段。 */
export interface PluginSurfaceThemeMessage {
  type: typeof PLUGIN_SURFACE_THEME_MESSAGE
  theme: PluginSurfaceTheme
}

/** HSL 组件值转为 CSS 颜色，已计算好的颜色原样保留。 */
function cssColor(value: string): string {
  const normalized = value.trim()
  if (!normalized) return 'transparent'
  return /^(?:#|rgb|hsl|lab|lch|oklab|oklch|color\(|color-mix\(|light-dark\(|transparent$|currentcolor$)/i.test(normalized)
    ? normalized
    : `hsl(${normalized})`
}

/**
 * 把宿主 CSS 自定义属性转换为 Surface 主题合同。
 * @param input 当前解析模式、主题类和计算样式。
 * @returns 可跨 iframe 传递的纯 JSON 主题。
 */
export function createPluginSurfaceTheme(input: CreatePluginSurfaceThemeInput): PluginSurfaceTheme {
  const colors = Object.fromEntries(
    PLUGIN_SURFACE_COLOR_TOKENS.map(token => [token, cssColor(input.colors[token])]),
  ) as Record<PluginSurfaceColorToken, string>
  return {
    mode: input.mode,
    className: input.className,
    colors,
    radius: { ...input.radius },
    shadows: { ...input.shadows },
    fontFamily: input.fontFamily,
    monoFontFamily: input.monoFontFamily,
  }
}

/**
 * 生成 Surface 根节点使用的稳定 CSS 变量。
 * @param theme 宿主主题合同。
 * @returns `--dutydeck-*` 变量映射。
 */
export function pluginSurfaceThemeVariables(theme: PluginSurfaceTheme): Record<string, string> {
  const variables: Record<string, string> = {
    '--dutydeck-color-scheme': theme.mode,
    '--dutydeck-font-family': theme.fontFamily,
    '--dutydeck-font-mono': theme.monoFontFamily,
    '--dutydeck-radius': theme.radius.base,
    '--dutydeck-radius-cap': theme.radius.cap,
    '--dutydeck-radius-xl': theme.radius.xl,
    '--dutydeck-radius-2xl': theme.radius.xxl,
    '--dutydeck-shadow-xs': theme.shadows.xs,
    '--dutydeck-shadow-sm': theme.shadows.sm,
    '--dutydeck-shadow-md': theme.shadows.md,
    '--dutydeck-shadow-lg': theme.shadows.lg,
    '--dutydeck-shadow-xl': theme.shadows.xl,
  }
  for (const token of PLUGIN_SURFACE_COLOR_TOKENS) {
    variables[`--dutydeck-${token}`] = theme.colors[token]
  }
  return variables
}

/** 判断主题对象结构是否完整且全部为字符串。 */
function isSurfaceTheme(value: unknown): value is PluginSurfaceTheme {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if ((record.mode !== 'light' && record.mode !== 'dark')
    || typeof record.className !== 'string'
    || typeof record.fontFamily !== 'string'
    || typeof record.monoFontFamily !== 'string') return false
  if (!record.colors || typeof record.colors !== 'object' || Array.isArray(record.colors)) return false
  const colors = record.colors as Record<string, unknown>
  if (PLUGIN_SURFACE_COLOR_TOKENS.some(token => typeof colors[token] !== 'string')) return false
  for (const [group, tokens] of [
    ['radius', PLUGIN_SURFACE_RADIUS_TOKENS],
    ['shadows', PLUGIN_SURFACE_SHADOW_TOKENS],
  ] as const) {
    const entry = record[group]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
    const values = entry as Record<string, unknown>
    if (tokens.some(token => typeof values[token] !== 'string')) return false
  }
  return true
}

/** 判断来自宿主窗口的主题消息是否满足公开合同。 */
export function isPluginSurfaceThemeMessage(value: unknown): value is PluginSurfaceThemeMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).sort().join(',') === 'theme,type'
    && record.type === PLUGIN_SURFACE_THEME_MESSAGE
    && isSurfaceTheme(record.theme)
}

/**
 * 将宿主主题写入 Surface 根节点。
 * @param theme 宿主主题合同。
 * @param root Surface 根元素，默认当前 documentElement。
 */
export function applyPluginSurfaceTheme(theme: PluginSurfaceTheme, root: HTMLElement = document.documentElement): void {
  for (const [name, value] of Object.entries(pluginSurfaceThemeVariables(theme))) {
    root.style.setProperty(name, value)
  }
  root.style.colorScheme = theme.mode
  root.dataset.pluginSurfaceTheme = theme.mode
  root.dataset.pluginSurfaceThemeClass = theme.className
}
