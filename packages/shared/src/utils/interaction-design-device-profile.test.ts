import { describe, expect, test } from 'bun:test'
import { getPrototypeDeviceProfile, getPrototypeSafeArea, getPrototypeViewport } from './interaction-design-device-profile'
import type { PrototypeDraft, PrototypePresentation } from '../types/interaction-design'

/** 最小旧原型用于验证新增设备合同不会改变旧交接基线。 */
const legacy: PrototypeDraft = { name: '测试', platform: 'mobile', brief: '', groups: [], pages: [], entryPageId: '', flows: [] }
/** 显式普通页面布局；系统栏隐藏不意味着物理遮挡消失。 */
const safe: PrototypePresentation = { schemaVersion: 1, contentLayout: 'safe', statusBar: 'dark', navigation: 'inline', orientation: 'portrait' }

describe('移动原型设备几何合同', () => {
  test('Given 灵动岛设备 When 解析普通与全屏布局 Then 屏幕尺寸相同且顶部安全区覆盖硬件遮挡', () => {
    /** 同一硬件上的普通页面与游戏页面。 */
    const normal = getPrototypeViewport(legacy, safe, 'iPhone 17')
    const game = getPrototypeViewport(legacy, { ...safe, contentLayout: 'edge-to-edge', statusBar: 'hidden', navigation: 'none' }, 'iPhone 17')
    expect([normal.width, normal.height]).toEqual([402, 874])
    expect(normal.safeArea.top).toBeGreaterThanOrEqual(normal.cutout!.top + normal.cutout!.height)
    expect(game.safeArea).toEqual(normal.safeArea)
    expect(game.cutout).toEqual(normal.cutout)
  })
  test('Given 横屏游戏 When 解析几何 Then 交换宽高且摄像头和控件避让转到侧边', () => {
    /** 横屏仍保留原设备的物理遮挡。 */
    const viewport = getPrototypeViewport(legacy, { ...safe, orientation: 'landscape', statusBar: 'hidden' }, 'iPhone X')
    expect([viewport.width, viewport.height]).toEqual([812, 375])
    expect(viewport.safeArea.left).toBeGreaterThan(0)
    expect(viewport.safeArea.left).toBeGreaterThanOrEqual(viewport.cutout!.left + viewport.cutout!.width)
    expect(viewport.cutout!.width).toBeLessThan(viewport.cutout!.height)
  })
  test('Given 经典手机 Android 和 Web When 切换模拟设备 Then 不套用灵动岛且Web没有系统占位', () => {
    expect(getPrototypeDeviceProfile('iPhone 8').cutout).toBeUndefined()
    expect(getPrototypeDeviceProfile('Pixel 10').cutout).toBeDefined()
    /** Web目标明确独立于原型的mobile历史字段。 */
    const web = getPrototypeViewport({ ...legacy, environment: { schemaVersion: 1, target: 'web', deviceId: '浏览器 Web' } }, safe)
    expect([web.width, web.height]).toEqual([1280, 800])
    expect(web.statusBarHeight).toBe(0)
    expect(web.safeArea).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
  })
  test('Given 横屏页面 When 显示再隐藏状态栏 Then 控件避让24px后恢复硬件安全区且原始参数不变', () => {
    /** 同一快照反复计算，避免切回全屏时残留状态栏留白。 */
    const viewport = getPrototypeViewport(legacy, { ...safe, orientation: 'landscape' }, 'iPhone 17')
    expect(getPrototypeSafeArea(viewport, 'dark')).toEqual({ top: 24, right: 62, bottom: 21, left: 62 })
    expect(getPrototypeSafeArea(viewport, 'light').top).toBe(24)
    expect(getPrototypeSafeArea(viewport, 'hidden').top).toBe(0)
    expect(viewport.safeArea.top).toBe(0)
    expect(getPrototypeSafeArea({ ...viewport, target: 'web' }, 'dark').top).toBe(0)
  })
  test('Given 历史原型和显式新基线 When 导出 Then 旧尺寸不被迁移而新基线精确保持', () => {
    expect(getPrototypeViewport(legacy)).toMatchObject({ width: 390, height: 844 })
    expect(getPrototypeViewport({ ...legacy, environment: { schemaVersion: 1, target: 'ios', deviceId: 'iPhone 17' } }, safe)).toMatchObject({ width: 402, height: 874 })
    expect(() => getPrototypeDeviceProfile('unknown')).toThrow()
  })
})
