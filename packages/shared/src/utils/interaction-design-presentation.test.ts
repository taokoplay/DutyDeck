import { describe, expect, test } from 'bun:test'
import type { PrototypeDraft, PrototypePresentation } from '../types/interaction-design'
import { buildPrototypeExport, buildPrototypePreview } from './interaction-design-preview'

/** 最小新布局，附加状态可以覆盖系统栏和方向。 */
const presentation: PrototypePresentation = { schemaVersion: 1, contentLayout: 'safe', statusBar: 'dark', navigation: 'inline', orientation: 'portrait' }
/** 同一份业务正文用于验证只改变显式布局、不删除自定义导航。 */
const draft: PrototypeDraft = { name: '派对', platform: 'mobile', brief: '', groups: [{ id: 'g', name: '开始' }], pages: [{ id: 'home', groupId: 'g', name: '首页', html: '<html><body><main data-prototype-shell><nav data-prototype-navigation>派对</nav><input></main></body></html>' }], flows: [], entryPageId: 'home' }
/** 可重复的受管预览输入，不启动真实会话。 */
const options = { mode: 'play' as const, token: 'preview-test', revision: 1, assets: {} }

describe('移动布局预览与导出', () => {
  test('Given 旧页面 When 构建预览 Then 不添加系统栏或修改原有正文', () => {
    /** 老页面仍保留原导航及其布局。 */
    const html = buildPrototypePreview(draft, 'home', options)
    expect(html).toContain(draft.pages[0]!.html)
    expect(html).not.toContain('data-prototype-system-chrome')
  })
  test('Given 显式移动布局 When 构建预览 Then 注入统一系统区域并保留自定义导航', () => {
    /** 安全区来自设备而不是硬编码页面padding。 */
    const current: PrototypeDraft = { ...draft, pages: [{ ...draft.pages[0]!, presentation }] }
    const html = buildPrototypePreview(current, 'home', options)
    expect(html).toContain('data-prototype-system-chrome')
    expect(html).toContain('--prototype-safe-top')
    expect(html).toContain('"width":402')
    expect(html).toContain(draft.pages[0]!.html)
  })
  test('Given 普通页的游戏状态 When 预览该状态 Then 使用全屏隐藏系统栏配置并保留硬件遮挡', () => {
    /** 状态可以独立选择横向沉浸布局。 */
    const current: PrototypeDraft = { ...draft, pages: [{ ...draft.pages[0]!, presentation, states: [{ id: 'game', name: '游戏', html: '<main data-prototype-shell>游戏</main>', presentation: { ...presentation, contentLayout: 'edge-to-edge', statusBar: 'hidden', navigation: 'none', orientation: 'landscape' } }] }] }
    const html = buildPrototypePreview(current, 'home', { ...options, stateId: 'game' })
    expect(html).toContain('"contentLayout":"edge-to-edge"')
    expect(html).toContain('"statusBar":"hidden"')
    expect(html).toContain('"width":874')
    expect(html).toContain('"cutout":')
  })
  test('Given 独立导出 When 页面采用新合同 Then 保留基准视口和硬件模拟而旧导出保持自适应', () => {
    /** 导出的可控缩放不得改变设计内的CSS视口。 */
    const current: PrototypeDraft = { ...draft, environment: { schemaVersion: 1, target: 'ios', deviceId: 'iPhone 17' }, pages: [{ ...draft.pages[0]!, presentation }] }
    expect(buildPrototypeExport(current, {})).toContain('"width":402')
    expect(buildPrototypeExport(current, {})).toContain('\\"simulateHardware\\":true')
    expect(buildPrototypeExport(draft, {})).not.toContain('data-prototype-system-chrome')
  })
})
