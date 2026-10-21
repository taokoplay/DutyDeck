import type { PrototypeEnvironment, PrototypePage } from '../types/interaction-design'

/** 根据页面身份、名称和目标系统创建空白页；所有新建入口共用显式安全区，不迁移已存页面。 */
export function createPrototypeBlankPage(id: string, groupId: string, name: string, target: PrototypeEnvironment['target']): PrototypePage {
  return {
    id, groupId, name,
    presentation: { schemaVersion: 1, contentLayout: 'safe', statusBar: target === 'web' ? 'hidden' : 'dark', navigation: 'none', orientation: 'portrait' },
    html: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>body{margin:0;font-family:system-ui;background:#fafafa;color:#242424}h1{font-size:24px}</style></head><body><main data-prototype-shell><section style="padding:20px"><h1 data-prototype-element="title">新页面</h1><p data-prototype-element="description">在主会话描述这个页面的内容和交互。</p></section></main></body></html>',
  }
}
