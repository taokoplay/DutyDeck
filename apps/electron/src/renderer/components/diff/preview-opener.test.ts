import { expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { getPreviewContentRefreshKey, previewContentRefreshVersionAtom } from '@/atoms/preview-atoms'
import { getPreviewContentCache, setPreviewContentCache } from '@/lib/preview-content-cache'
import * as preview from './preview-opener'

test('Given 同路径计划已有旧缓存 When 重提或重新查看 Then 清除各版本缓存并仅刷新所属会话文件', () => {
  const store = createStore()
  const file = { filePath: '/plan/review.md', previewOnly: true, readOnly: true }
  const key = getPreviewContentRefreshKey('B', file)
  const oldKey = 'B:preview:/plan/review.md@v0:{}'
  const otherKey = 'A:preview:/plan/review.md@v0:{}'
  setPreviewContentCache(oldKey, { oldContent: '', newContent: '# 旧计划' })
  setPreviewContentCache(otherKey, { oldContent: '', newContent: '# 其它会话' })
  preview.refreshPreviewContent(store, 'B', file)
  expect(getPreviewContentCache(oldKey)).toBeUndefined()
  expect(getPreviewContentCache(otherKey)?.newContent).toBe('# 其它会话')
  expect(store.get(previewContentRefreshVersionAtom).get(key)).toBe(1)
  const nextKey = 'B:preview:/plan/review.md@v1:{}'
  setPreviewContentCache(nextKey, { oldContent: '', newContent: '# 新计划' })
  preview.refreshPreviewContent(store, 'B', file)
  expect(getPreviewContentCache(nextKey)).toBeUndefined()
  expect(store.get(previewContentRefreshVersionAtom).get(key)).toBe(2)
  expect(store.get(previewContentRefreshVersionAtom).size).toBe(1)
})
