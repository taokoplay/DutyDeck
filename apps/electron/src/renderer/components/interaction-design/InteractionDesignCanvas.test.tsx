import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PrototypeDocument } from '@dutydeck/shared'
import { InteractionDesignCanvas } from './InteractionDesignCanvas'

const document: PrototypeDocument = {
  schemaVersion: 1, id: 'p', revision: 1, createdAt: 1, updatedAt: 1, name: '原型', platform: 'mobile', brief: '',
  groups: [{ id: 'g', name: '页面' }], entryPageId: 'home',
  pages: [{ id: 'home', groupId: 'g', name: '首页', html: '<h1>首页</h1>' }],
  flows: [],
}

test('Given 当前页面 When 渲染交互图 Then 显示设备尺寸与页面打开入口且不生成分组组件', () => {
  const markup = renderToStaticMarkup(<InteractionDesignCanvas
    document={document}
    assets={[]}
    revision={1}
    active
    deviceId="iPhone 17"
    selectedPageId="home"
    readAsset={async asset => ({ assetId: asset.id, dataUrl: 'data:image/png;base64,AAAA' })}
    onSelectPage={() => undefined}
    onOpenPage={() => undefined}
    onOpenReferences={() => undefined}
  />)
  expect(markup).toContain('iPhone 17')
  expect(markup).toContain('打开预览')
  expect(markup).toContain('参考图')
  expect(markup).not.toContain('分组')
})
