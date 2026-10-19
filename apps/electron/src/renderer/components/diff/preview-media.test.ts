import { describe, expect, test } from 'bun:test'

import { getPreviewMediaInfo, resolvePreviewMode } from './preview-media'

describe('文件媒体预览类型识别', () => {
  test('Given 图片路径 When 识别预览类型 Then 返回图片 MIME', () => {
    expect(getPreviewMediaInfo('/workspace/icon.PNG')).toEqual({ kind: 'image', mimeType: 'image/png' })
  })

  test('Given 视频和音频路径 When 识别预览类型 Then 返回对应媒体 MIME', () => {
    expect(getPreviewMediaInfo('/workspace/demo.mp4')).toEqual({ kind: 'video', mimeType: 'video/mp4' })
    expect(getPreviewMediaInfo('/workspace/voice.MP3')).toEqual({ kind: 'audio', mimeType: 'audio/mpeg' })
  })

  test('Given 文本或未知扩展名 When 识别预览类型 Then 返回 null', () => {
    expect(getPreviewMediaInfo('/workspace/readme.md')).toBeNull()
    expect(getPreviewMediaInfo('/workspace/archive.zip')).toBeNull()
  })

  test('Given 媒体文件从改动入口打开 When 解析预览模式 Then 强制使用媒体预览', () => {
    expect(resolvePreviewMode('/workspace/icon.png', false)).toBe(true)
    expect(resolvePreviewMode('/workspace/demo.mp4', false)).toBe(true)
    expect(resolvePreviewMode('/workspace/readme.md', false)).toBe(false)
  })
})
