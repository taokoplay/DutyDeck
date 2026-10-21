import type { PrototypeDraft, PrototypePresentation } from '../types/interaction-design'

/** 四边控件避让距离，单位为设计视口 CSS px，不是机身边框。 */
export interface PrototypeSafeArea { top: number; right: number; bottom: number; left: number }
/** 屏幕坐标内的物理遮挡；用于独立导出模拟，不重复绘制外壳已有摄像头。 */
export interface PrototypeCutout { top: number; left: number; width: number; height: number; radius: number }
/** 锁定外壳库的模拟参数，不代表真实设备操作系统返回的安全区。 */
export interface PrototypeDeviceProfile {
  /** 与设备菜单一致的稳定型号。 */
  id: string
  /** 原始屏幕尺寸。 */
  width: number
  height: number
  /** 控件安全区与系统栏的几何参数。 */
  safeArea: PrototypeSafeArea
  statusBarHeight: number
  /** 当前硬件是否需要底部手势提示。 */
  homeIndicator: boolean
  /** 屏幕内的刘海、灵动岛或打孔。 */
  cutout?: PrototypeCutout
}
/** 已应用方向和目标系统的视口，可直接用于预览、导出和交接。 */
export interface PrototypeViewport extends PrototypeDeviceProfile {
  /** 返回视口保留设备身份，id 兼容基础参数。 */
  deviceId: string
  /** 旋转只影响预览，不改写页面导航。 */
  orientation: 'portrait' | 'landscape'
  /** 设计目标独立于选择的物理设备。 */
  target: 'ios' | 'android' | 'web'
}

/** 输入原始设备几何和当前状态栏样式，返回控件实际避让区域；函数无外部依赖，可原样嵌入沙箱。 */
export function getPrototypeSafeArea(viewport: Pick<PrototypeViewport, 'safeArea' | 'statusBarHeight' | 'target'>, statusBar: PrototypePresentation['statusBar']): PrototypeSafeArea {
  /** 隐藏状态栏不会移除物理遮挡；显示状态栏时额外占用顶部空间。 */
  const visible = viewport.target !== 'web' && statusBar !== 'hidden'
  return { ...viewport.safeArea, top: Math.max(viewport.safeArea.top, visible ? viewport.statusBarHeight : 0) }
}

/** 构造只读预设；入参是尺寸/上下安全区与可选遮挡，返回完整四边参数。 */
function profile(id: string, width: number, height: number, top: number, bottom: number, cutout?: PrototypeCutout): PrototypeDeviceProfile {
  return { id, width, height, safeArea: { top, right: 0, bottom, left: 0 }, statusBarHeight: top, homeIndicator: bottom > 0, ...(cutout ? { cutout } : {}) }
}

/** 所有尺寸与 react-mockframe@1.3.0 对齐；安全区为显式可审查的模拟预设。 */
export const PROTOTYPE_DEVICE_PROFILES: readonly PrototypeDeviceProfile[] = [
  profile('iPhone 17', 402, 874, 62, 34, { top: 14.34, left: 138.665, width: 124.67, height: 36, radius: 18 }),
  profile('iPhone 18 Pro', 402, 874, 62, 34, { top: 14.33, left: 154, width: 94, height: 36, radius: 18 }),
  profile('iPhone X', 375, 812, 44, 34, { top: 0, left: 82.5, width: 210, height: 30, radius: 20 }),
  profile('iPhone 8', 375, 667, 20, 0),
  profile('iPhone 8 Plus', 414, 736, 20, 0),
  profile('iPhone Duo', 466, 678, 74, 34, { top: 29.83, left: 400.33, width: 36, height: 36, radius: 18 }),
  profile('Pixel 10', 412, 924, 52, 24, { top: 15, left: 192, width: 28, height: 28, radius: 14 }),
  profile('Galaxy S25', 360, 780, 36, 24, { top: 11, left: 172, width: 16, height: 16, radius: 8 }),
  profile('iPad Mini', 576, 768, 24, 0),
  profile('iPad Pro', 512, 683, 24, 20),
  profile('MacBook Pro', 960, 624, 0, 0),
  profile('MacBook Pro 2020', 960, 600, 0, 0),
  profile('浏览器 Web', 1280, 800, 0, 0),
]

/** 输入设备身份并返回独立参数副本；未知身份显式失败，避免静默交接错误机型。 */
export function getPrototypeDeviceProfile(deviceId: string): PrototypeDeviceProfile {
  /** 只有受支持目录可决定遮挡参数。 */
  const value = PROTOTYPE_DEVICE_PROFILES.find(item => item.id === deviceId)
  if (!value) throw new Error('不支持的原型设备')
  return { ...value, safeArea: { ...value.safeArea }, ...(value.cutout ? { cutout: { ...value.cutout } } : {}) }
}

/** 输入设计基线、页面布局及临时设备/方向，返回统一几何；旧交接继续使用历史尺寸。 */
export function getPrototypeViewport(draft: Pick<PrototypeDraft, 'platform' | 'environment'>, presentation?: PrototypePresentation, deviceIdOverride?: string, orientationOverride?: 'portrait' | 'landscape'): PrototypeViewport {
  /** 临时设备选择不修改设计目标；未声明的新移动布局沿用默认 iOS 模板。 */
  const target = draft.environment?.target ?? (draft.platform === 'mobile' ? 'ios' : 'web')
  const deviceId = deviceIdOverride ?? draft.environment?.deviceId ?? (draft.platform === 'mobile' ? 'iPhone 17' : '浏览器 Web')
  const device = getPrototypeDeviceProfile(deviceId)
  /** 桌面设备已经是横向屏幕，不再把笔记本旋转成竖屏。 */
  const orientation = device.width > device.height ? 'landscape' : orientationOverride ?? presentation?.orientation ?? 'portrait'
  const rotated = orientation === 'landscape' && device.width < device.height
  /** 旧原型缺少显式布局，独立交接保持历史视口；实际预览传入 override 后按外壳尺寸。 */
  if (!draft.environment && !presentation && !deviceIdOverride && draft.platform === 'mobile') return { ...device, width: 390, height: 844, deviceId, target, orientation, safeArea: { top: 0, right: 0, bottom: 0, left: 0 }, statusBarHeight: 0, cutout: undefined, homeIndicator: false }
  /** 逆时针旋转物理遮挡，与 renderer 外壳的变换使用同一坐标规则。 */
  const reflow = deviceId === 'iPhone Duo'
  const cutout = device.cutout && (rotated ? reflow ? { ...device.cutout, left: device.cutout.left + device.height - device.width } : { top: device.width - device.cutout.left - device.cutout.width, left: device.cutout.top, width: device.cutout.height, height: device.cutout.width, radius: device.cutout.radius } : device.cutout)
  /** 横屏两侧对称预留控件空间，底部继续保留手势边缘。 */
  const safeArea = rotated && !reflow ? { top: 0, right: device.safeArea.top, bottom: device.homeIndicator ? 21 : 0, left: device.safeArea.top } : device.safeArea
  /** Web 不模拟 OS 状态栏；选择有物理遮挡的设备时仍保留对应的硬件避让。 */
  const statusBarHeight = target === 'web' ? 0 : rotated && !reflow && device.statusBarHeight ? 24 : device.statusBarHeight
  return { ...device, width: rotated ? device.height : device.width, height: rotated ? device.width : device.height, deviceId, target, orientation, safeArea, statusBarHeight, ...(cutout ? { cutout } : {}) }
}
