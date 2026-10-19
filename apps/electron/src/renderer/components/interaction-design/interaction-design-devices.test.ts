import { describe, expect, test } from 'bun:test'
import { DeviceNames, DeviceOptions } from 'react-mockframe'
import { getPrototypeDevice, isPrototypeDevice, PROTOTYPE_DEVICES } from './interaction-design-devices'

describe('预览设备目录', () => {
  test('Given 库的全部模型 When 构建设备菜单 Then 每种模型恰好出现一次且使用库的内容分辨率', () => {
    expect(PROTOTYPE_DEVICES.flatMap(device => device.frame ? [device.frame.device] : []).sort()).toEqual([...DeviceNames].sort())
    for (const device of PROTOTYPE_DEVICES) {
      if (device.frame) expect([device.width, device.height]).toEqual([DeviceOptions[device.frame.device].width, DeviceOptions[device.frame.device].height])
      expect(device.screenLeft + device.width).toBeLessThan(device.shellWidth)
      expect(device.screenTop + device.height).toBeLessThan(device.shellHeight)
    }
  })

  test('Given 浏览器 Web When 选择预览 Then 使用桌面视口且顶栏不占用网页高度', () => {
    /** 网页尺寸与窗口装饰分别声明，缩放或换设备不改写原型平台。 */
    const device = getPrototypeDevice('浏览器 Web')
    expect(isPrototypeDevice('浏览器 Web')).toBe(true)
    expect(device.id).toBe('浏览器 Web')
    expect(device.frame).toBeNull()
    expect(device.platform).toBe('desktop')
    expect([device.width, device.height]).toEqual([1280, 800])
    expect(device.shellHeight - device.screenTop - device.height).toBe(1)
  })

  test('Given 旧平台偏好或失效机型 When 恢复视图 Then 回退到对应平台的有效模型', () => {
    expect(getPrototypeDevice().id).toBe('iPhone 17')
    expect(getPrototypeDevice(undefined, 'desktop').id).toBe('MacBook Pro')
    expect(getPrototypeDevice('missing', 'desktop').id).toBe('MacBook Pro')
    expect(isPrototypeDevice('missing')).toBe(false)
    expect(isPrototypeDevice('iPhone Duo')).toBe(true)
    expect(getPrototypeDevice('iPad Pro', 'desktop').id).toBe('iPad Pro')
  })

  test('Given 笔记本底座比屏幕宽 When 计算适应范围 Then 包含完整底座与底部脚垫', () => {
    const device = getPrototypeDevice('MacBook Pro')
    expect(device.shellWidth).toBeCloseTo(960 + 2 * 17.6 + 2 * 106)
    expect(device.shellHeight).toBeCloseTo(624 + 17.5 + 45.4 + 41.5)
  })
})
