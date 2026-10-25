/** 把宿桥稳定错误码转换为用户可执行的 Surface 提示。 */
export function surfaceErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('PLUGIN_CAPABILITY_READ_ONLY')) {
    return '当前会话尚未启用交互设计插件。请关闭此标签，再从右侧工具菜单重新接入后重试。'
  }
  if (message.includes('PLUGIN_PROJECT_UNAVAILABLE')) {
    return '当前会话没有可用的项目目录，请先打开或绑定项目。'
  }
  if (message.includes('PLUGIN_PROJECT_DIRECTORY_UNSAFE')) {
    return '项目产物目录不是安全目录，请检查 .dutydeck 路径是否被文件或符号链接占用。'
  }
  if (message.includes('PLUGIN_ARTIFACT_REVISION_CONFLICT')) {
    return '原型已被其他操作更新，请刷新后重新提交。'
  }
  if (message.includes('PLUGIN_SURFACE_BRIDGE_DENIED') || message.includes('PLUGIN_SURFACE_FAILED')) {
    return `${fallback}。请刷新后重试；若仍失败，重新接入插件模块。`
  }
  return message.trim() ? `${fallback}：${message}` : fallback
}
