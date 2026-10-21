import { DeviceOptions } from 'react-mockframe'
import type { MockFrameProps } from 'react-mockframe'

/** 设备分类用于菜单分组；平板仍属于原型已有的 mobile 平台。 */
export type PrototypeDeviceGroup = '手机' | '平板' | '电脑'

/** 外观参数对应锁定的 react-mockframe@1.3.0 CSS，内容尺寸直接读取库配置。 */
interface PrototypeDeviceDefinition {
  /** 机型与配色由库的判别联合校验。 */
  frame: MockFrameProps
  /** 菜单分类。 */
  group: PrototypeDeviceGroup
  /** 屏幕到机身边缘的左、上、右、下距离，单位为 CSS px。 */
  bezel: readonly [number, number, number, number]
  /** 唯一内容裁剪层与库内屏幕保持一致。 */
  radius: string
  /** 笔记本底座超出机身的左右及底部尺寸，参与自动适应。 */
  outset?: readonly [number, number]
  /** 全面屏 iPhone 的底部手势条仅作装饰。 */
  homeIndicator?: boolean
}

/** 全部库模型均提供可交互预览；Duo 使用闭合外屏，避免半折姿态复制业务脚本。 */
const DEVICE_DEFINITIONS: PrototypeDeviceDefinition[] = [
  { frame: { device: 'iPhone 17', color: 'black' }, group: '手机', bezel: [14.67, 14.33, 14.67, 14.33], radius: '63.5px', homeIndicator: true },
  { frame: { device: 'iPhone 18 Pro', color: 'black' }, group: '手机', bezel: [15.83, 15.67, 15.83, 15.67], radius: '63.6px', homeIndicator: true },
  { frame: { device: 'iPhone X' }, group: '手机', bezel: [26, 26, 26, 26], radius: '40px', homeIndicator: true },
  { frame: { device: 'iPhone 8', color: 'black' }, group: '手机', bezel: [24, 105, 24, 105], radius: '1px' },
  { frame: { device: 'iPhone 8 Plus', color: 'black' }, group: '手机', bezel: [26, 112, 26, 112], radius: '1px' },
  { frame: { device: 'iPhone Duo', color: 'night-sky', pose: 'closed' }, group: '手机', bezel: [25.67, 16, 16, 16], radius: '7.97px 58.04px 58.04px 7.97px' },
  { frame: { device: 'Pixel 10', color: 'obsidian' }, group: '手机', bezel: [21.5, 21.5, 21.5, 21.5], radius: '50px' },
  { frame: { device: 'Galaxy S25', color: 'blue-black' }, group: '手机', bezel: [12.5, 12.5, 12.5, 12.5], radius: '36px' },
  { frame: { device: 'iPad Mini', color: 'black' }, group: '平板', bezel: [25, 90, 25, 90], radius: '1px' },
  { frame: { device: 'iPad Pro', color: 'space-black' }, group: '平板', bezel: [22.33, 22.33, 22.33, 22.33], radius: '14.4px' },
  { frame: { device: 'MacBook Pro', color: 'space-black' }, group: '电脑', bezel: [17.6, 17.5, 17.6, 45.4], radius: '11.9px 11.9px 0 0', outset: [106, 41.5] },
  { frame: { device: 'MacBook Pro 2020' }, group: '电脑', bezel: [44, 44, 44, 76], radius: '1px', outset: [70, 0] },
]

/** 菜单、内容视口、缩放和页脚共用同一份派生数据，避免分辨率与显示不符。 */
export const PROTOTYPE_DEVICES = [...DEVICE_DEFINITIONS.map(definition => {
  /** 库给出的默认屏幕尺寸是 CSS 视口，不是硬件物理像素。 */
  const { width, height } = DeviceOptions[definition.frame.device]
  /** 机身内边距与超出机身的底座一并计入缩放占位。 */
  const [left, top, right, bottom] = definition.bezel
  const [outsetX, outsetBottom] = definition.outset ?? [0, 0]
  return {
    ...definition, id: definition.frame.device, width, height, outsetX,
    screenLeft: left + outsetX, screenTop: top,
    shellWidth: width + left + right + 2 * outsetX,
    shellHeight: height + top + bottom + outsetBottom,
    platform: definition.group === '电脑' ? 'desktop' as const : 'mobile' as const,
  }
}), {
  /** 浏览器不是硬件模型；顶栏和边框占位独立于 1280×800 的网页内容视口。 */
  id: '浏览器 Web' as const, frame: null, group: '电脑' as const,
  width: 1280, height: 800, outsetX: 0,
  screenLeft: 1, screenTop: 45, shellWidth: 1282, shellHeight: 846,
  radius: '0px 0px 11px 11px', homeIndicator: false, platform: 'desktop' as const,
}]

/** 预览身份同时包含库机型与应用提供的浏览器外观，不影响原型平台类型。 */
export type PrototypeDeviceId = (typeof PROTOTYPE_DEVICES)[number]['id']

/** 输入可选机型与旧平台偏好，返回有效设备；兼容未选择具体机型的旧视图状态。 */
export function getPrototypeDevice(device?: string, platform: 'mobile' | 'desktop' = 'mobile', orientation: 'portrait' | 'landscape' = 'portrait') {
  /** 原始库参数保持不可变，横屏派生值仅属于当前预览实例。 */
  const base = PROTOTYPE_DEVICES.find(item => item.id === device)
    ?? PROTOTYPE_DEVICES.find(item => item.id === (platform === 'desktop' ? 'MacBook Pro' : 'iPhone 17'))!
  /** 库组件仍接收未旋转尺寸，由自身的 landscape 样式交换宽高。 */
  const frameSize = { frameWidth: base.width, frameHeight: base.height }
  if (orientation !== 'landscape' || base.group === '电脑') return { ...base, ...frameSize }
  /** Duo闭合外屏是库的横向重排，边框与摄像头不旋转；其他模型沿用库的旋转样式。 */
  const reflow = base.id === 'iPhone Duo'
  return {
    ...base, ...frameSize, width: base.height, height: base.width,
    frame: { ...base.frame, landscape: true } as MockFrameProps,
    shellWidth: reflow ? base.shellWidth - base.width + base.height : base.shellHeight,
    shellHeight: reflow ? base.shellHeight - base.height + base.width : base.shellWidth,
    screenLeft: reflow ? base.screenLeft : base.screenTop,
    screenTop: reflow ? base.screenTop : base.screenLeft,
  }
}

/** 输入菜单值，校验后返回支持的预览身份，未知值不修改视图。 */
export function isPrototypeDevice(device: string): device is PrototypeDeviceId {
  return PROTOTYPE_DEVICES.some(item => item.id === device)
}
