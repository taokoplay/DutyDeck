/** 文件预览支持的媒体类别。 */
export type PreviewMediaKind = 'image' | 'video' | 'audio'

/** 媒体文件的渲染信息，用于选择 HTML 媒体元素和 MIME 类型。 */
export interface PreviewMediaInfo {
  kind: PreviewMediaKind
  mimeType: string
}

/** 文件后缀与媒体元素类别、MIME 的对应关系，不用于扩大文件读取授权。 */
const PREVIEW_MEDIA_BY_EXTENSION: Readonly<Record<string, PreviewMediaInfo>> = {
  '.png': { kind: 'image', mimeType: 'image/png' },
  '.jpg': { kind: 'image', mimeType: 'image/jpeg' },
  '.jpeg': { kind: 'image', mimeType: 'image/jpeg' },
  '.gif': { kind: 'image', mimeType: 'image/gif' },
  '.webp': { kind: 'image', mimeType: 'image/webp' },
  '.svg': { kind: 'image', mimeType: 'image/svg+xml' },
  '.bmp': { kind: 'image', mimeType: 'image/bmp' },
  '.ico': { kind: 'image', mimeType: 'image/x-icon' },
  '.mp4': { kind: 'video', mimeType: 'video/mp4' },
  '.webm': { kind: 'video', mimeType: 'video/webm' },
  '.mov': { kind: 'video', mimeType: 'video/quicktime' },
  '.m4v': { kind: 'video', mimeType: 'video/x-m4v' },
  '.mp3': { kind: 'audio', mimeType: 'audio/mpeg' },
  '.wav': { kind: 'audio', mimeType: 'audio/wav' },
  '.ogg': { kind: 'audio', mimeType: 'audio/ogg' },
  '.oga': { kind: 'audio', mimeType: 'audio/ogg' },
  '.m4a': { kind: 'audio', mimeType: 'audio/mp4' },
  '.flac': { kind: 'audio', mimeType: 'audio/flac' },
}

/** 根据文件扩展名返回媒体预览信息；文本、Office 和未知文件返回 null。 */
export function getPreviewMediaInfo(filePath: string): PreviewMediaInfo | null {
  /** 去掉目录后只按文件名后缀识别媒体类型。 */
  const fileName = filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath
  /** 文件名中最后一个点的位置，用于提取大小写不敏感的扩展名。 */
  const extensionStart = fileName.lastIndexOf('.')
  if (extensionStart <= 0) return null
  return PREVIEW_MEDIA_BY_EXTENSION[fileName.slice(extensionStart).toLowerCase()] ?? null
}

/** 解析文件入口的展示模式；媒体文件必须绕过文本 Diff。 */
export function resolvePreviewMode(filePath: string, requestedPreviewOnly: boolean): boolean {
  return requestedPreviewOnly || getPreviewMediaInfo(filePath) !== null
}
