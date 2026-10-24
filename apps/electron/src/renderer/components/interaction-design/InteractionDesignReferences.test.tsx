import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PrototypeAsset, PrototypeDocument } from '@dutydeck/shared'
import { InteractionDesignReferences } from './InteractionDesignReferences'

const asset: PrototypeAsset = { id: 'asset-1', name: 'home.png', hash: 'a'.repeat(64), mime: 'image/png', byteSize: 10, createdAt: 1 }
const document: PrototypeDocument = {
  schemaVersion: 1, id: 'prototype-1', revision: 3, createdAt: 1, updatedAt: 2,
  name: '原型', platform: 'mobile', brief: '', groups: [{ id: 'g', name: '页面' }], entryPageId: 'home',
  pages: [{ id: 'home', groupId: 'g', name: '首页', html: '<h1>首页</h1>' }, { id: 'detail', groupId: 'g', name: '详情', html: '<h1>详情</h1>' }],
  flows: [],
  references: [{ id: 'reference-1', assetId: 'asset-1', title: '首页结构', role: 'structure', source: 'Figma', usages: [{ pageId: 'home' }] }],
}

describe('参考图工作区', () => {
  test('Given 页面参考图 When 渲染 Then 显示用途、关联页和 Agent 可读取提示', () => {
    const markup = renderToStaticMarkup(<InteractionDesignReferences
      document={document}
      assets={[asset]}
      active
      selectedPageId="home"
      readAsset={async () => ({ assetId: asset.id, dataUrl: 'data:image/png;base64,AAAA' })}
      onSave={() => undefined}
      onImportAsset={() => undefined}
      onImportFiles={() => undefined}
      onReference={() => undefined}
    />)
    expect(markup).toContain('首页结构')
    expect(markup).toContain('结构参考')
    expect(markup).toContain('首页结构参考图')
    expect(markup).toContain('Agent 可读取用途与原图')
    expect(markup).toContain('拖入图片即可添加')
  })
})
