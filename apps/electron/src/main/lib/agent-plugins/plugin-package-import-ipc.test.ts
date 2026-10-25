import { describe, expect, test } from 'bun:test'
import { createModuleRuntimePluginFiles, createStandardPluginFiles } from '@dutydeck/plugin-kit'
import { createPluginPackage } from '@dutydeck/plugin-kit/package'
import type { ContentPluginPreview, ModuleRuntimePluginPreviewView } from '@dutydeck/shared'
import { previewPluginPackageBytes } from './plugin-package-import'

/** 构造可被主进程分类的最小 V2 或 V3 包。 */
function packageBytes(formatVersion: 2 | 3): Uint8Array {
  if (formatVersion === 2) return createPluginPackage(createStandardPluginFiles('acme.content', '内容插件'))
  const files = createModuleRuntimePluginFiles('acme.runtime', '运行插件')
  files.set('runtime/main.mjs', new TextEncoder().encode('export default { activate() {} }'))
  files.set('surfaces/workspace/index.html', new TextEncoder().encode('<!doctype html><html></html>'))
  return createPluginPackage(files)
}

describe('Given 统一插件包导入', () => {
  test('When V2 内容包 Then 只调用内容插件预览', () => {
    let contentCalls = 0
    let runtimeCalls = 0
    const contentPreview = { token: 'content-token' } as ContentPluginPreview
    const result = previewPluginPackageBytes({
      contentManager: {
        previewBytes: () => {
          contentCalls += 1
          return contentPreview
        },
      },
      runtimeService: {
        previewBytes: () => {
          runtimeCalls += 1
          return { token: 'runtime-token' } as ModuleRuntimePluginPreviewView
        },
      },
    }, packageBytes(2))
    expect(result).toEqual({ kind: 'content', preview: contentPreview })
    expect(contentCalls).toBe(1)
    expect(runtimeCalls).toBe(0)
  })

  test('When V3 可执行包 Then 只调用 runtime 预览', () => {
    let contentCalls = 0
    let runtimeCalls = 0
    const runtimePreview = { token: 'runtime-token' } as ModuleRuntimePluginPreviewView
    const result = previewPluginPackageBytes({
      contentManager: {
        previewBytes: () => {
          contentCalls += 1
          return { token: 'content-token' } as ContentPluginPreview
        },
      },
      runtimeService: {
        previewBytes: () => {
          runtimeCalls += 1
          return runtimePreview
        },
      },
    }, packageBytes(3))
    expect(result).toEqual({ kind: 'runtime', preview: runtimePreview })
    expect(contentCalls).toBe(0)
    expect(runtimeCalls).toBe(1)
  })
})
