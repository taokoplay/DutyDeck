/** 插件运行时根目录与签名模式。 */
export interface PluginRuntimeMode {
  development: boolean
  rootDirectory: 'plugin-runtime-v3-development' | 'plugin-runtime-v3'
}

/**
 * 未打包源码始终进入隔离开发根；打包版只有显式开关才开启未签名插件。
 * @param input 当前打包状态和显式环境开关。
 * @returns 运行时签名模式与数据目录名。
 */
export function resolvePluginRuntimeMode(input: {
  isPackaged: boolean
  forceDevelopment: boolean
}): PluginRuntimeMode {
  const development = !input.isPackaged || input.forceDevelopment
  return {
    development,
    rootDirectory: development ? 'plugin-runtime-v3-development' : 'plugin-runtime-v3',
  }
}
