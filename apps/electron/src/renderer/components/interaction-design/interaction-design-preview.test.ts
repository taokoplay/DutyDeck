import { describe, expect, test } from 'bun:test'
import { calculatePrototypePreviewScale } from './InteractionDesignPreview'

describe('交互设计预览默认尺寸', () => {
  test('Given 单台手机有接近完整机身的空间 When 计算自动比例 Then 优先保持较大的可读尺寸并只保留很小的上下留白', () => {
    const scale = calculatePrototypePreviewScale({ device: 'mobile', multiple: false, stateCount: 0, availableWidth: 620, availableHeight: 820, shellWidth: 420, shellHeight: 873 })
    expect(scale).toBe(0.9)
  })

  test('Given 单台手机竖向空间不足 When 计算自动比例 Then 按剩余高度收缩而不裁掉机身', () => {
    const scale = calculatePrototypePreviewScale({ device: 'mobile', multiple: false, stateCount: 0, availableWidth: 620, availableHeight: 500, shellWidth: 420, shellHeight: 873 })
    expect(scale).toBeCloseTo((500 - 8) / 873)
  })

  test('Given 窄窗口无法容纳完整手机 When 计算自动比例 Then 按宽度收缩且不超过可用空间', () => {
    const scale = calculatePrototypePreviewScale({ device: 'mobile', multiple: false, stateCount: 0, availableWidth: 240, availableHeight: 700, shellWidth: 420, shellHeight: 873 })
    expect(scale).toBeCloseTo(240 / 420)
  })

  test('Given 桌面画板或多状态手机 When 计算自动比例 Then 继续同时约束宽高和列间距', () => {
    const desktopScale = calculatePrototypePreviewScale({ device: 'desktop', multiple: false, stateCount: 0, availableWidth: 900, availableHeight: 500, shellWidth: 1280, shellHeight: 800 })
    expect(desktopScale).toBeCloseTo((500 - 24) / 800)
    const stateScale = calculatePrototypePreviewScale({ device: 'mobile', multiple: true, stateCount: 1, availableWidth: 700, availableHeight: 700, shellWidth: 420, shellHeight: 873 })
    expect(stateScale).toBeCloseTo((700 - 28) / 873)
  })
})
