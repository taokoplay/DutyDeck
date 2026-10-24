import { atom } from 'jotai'
import type { PrototypeDeviceId } from '../components/interaction-design/interaction-design-devices'

/** 视图偏好只驻留 renderer，正式设计版本由主进程保存。 */
export interface InteractionDesignView {
  /** 当前原型与页面身份，不依赖名称匹配。 */
  prototypeId: string | null
  pageId: string | null
  /** 设备与目录折叠不会改写设计版本。 */
  device: 'mobile' | 'desktop'
  /** 当前预览机型，仅驻留项目视图，不改写原型平台。 */
  previewDevice?: PrototypeDeviceId
  /** 模块主视图；顺序固定为原型预览、画布、参考图。 */
  moduleTab?: 'preview' | 'canvas' | 'references'
  /** 横竖屏仅是临时预览偏好，不覆盖页面的正式布局。 */
  previewOrientation?: 'portrait' | 'landscape'
  /** 手动预览比例；缺省自动适应可用区域，不改变设计视口。 */
  zoom?: number
  collapsedGroups: string[]
}

/** 以真实项目身份隔离最近选择；不保存 HTML、候选或图片字节。 */
export const interactionDesignViewsAtom = atom<Record<string, InteractionDesignView>>({})
