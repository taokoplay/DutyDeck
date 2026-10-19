import type { ContentPluginPreview, ContentPluginSnapshot } from '@dutydeck/shared'

/** 将缺少插件 IPC 的异常转为恢复指引；其余错误保留原因，未知异常使用调用方兜底文案。 */
export function contentPluginErrorMessage(cause: unknown, fallback: string): string {
  const message = cause instanceof Error ? cause.message : fallback
  return /No handler registered for ['"]content-plugin:/.test(message)
    ? '插件服务尚未就绪，请重启应用后重试。开发环境更新后，需要同时重启主进程。'
    : message
}

/** 只有已验证签名且用户确认来源的预览才可提交，返回精确的签名者指纹。 */
export function confirmedPluginKey(preview: ContentPluginPreview | null, confirmed: boolean): string | null {
  return confirmed && preview?.signatureVerified && preview.signer?.keyId ? preview.signer.keyId : null
}
/** 并发刷新返回顺序不应让界面倒退到旧修订号。 */
export function mergeContentPluginSnapshot(current: ContentPluginSnapshot | null, incoming: ContentPluginSnapshot): ContentPluginSnapshot {
  return current && current.revision > incoming.revision ? current : incoming
}
