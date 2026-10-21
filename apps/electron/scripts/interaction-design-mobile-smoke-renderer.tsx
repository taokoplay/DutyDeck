import * as React from 'react'
import { createRoot } from 'react-dom/client'
import type { PrototypeDraft } from '@dutydeck/shared'
import { buildPrototypeExport } from '@dutydeck/shared'
import interactionSkill from '../default-skills/interaction-design/SKILL.md?raw'
import { InteractionDesignPreview } from '../src/renderer/components/interaction-design/InteractionDesignPreview'
import type { PrototypeDeviceId } from '../src/renderer/components/interaction-design/interaction-design-devices'
import '../src/renderer/styles/globals.css'
import '../src/renderer/components/interaction-design/interaction-design.css'

/** 隔离页面形态，所有数据仅在当前 smoke renderer 内存中存在。 */
type Scene = 'normal' | 'live' | 'game' | 'legacy' | 'states' | 'skill'
/** 测试控制入口，不接入 preload 或真实业务数据。 */
interface MobileSmoke {
  /** 切换机型和方向，要求保留已有 iframe。 */
  device: (device: PrototypeDeviceId, orientation?: 'portrait' | 'landscape') => void
  /** 重新挂载独立测试场景。 */
  scene: (scene: Scene) => void
  /** 返回真实导出器生成的离线 HTML。 */
  exportHtml: () => string
}
declare global { interface Window { __mobileSmoke: MobileSmoke } }

/** 可视化 fixture 共用正文：导航、内部滚动区与底部按钮均可独立测量。 */
const html = `<!doctype html><html><head><style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;font:16px system-ui;background:#efeaff;color:#202038}#shell{height:100%;display:flex;flex-direction:column}#nav{display:flex;align-items:center;justify-content:space-between;padding-left:18px;padding-right:18px;background:#d6ccff;font-weight:700}button{min-height:44px;border:0;border-radius:14px;padding:10px 16px;background:#bdff32;color:#202038;font-weight:700}#scroll{flex:1;min-height:0;overflow:auto;padding:20px}#long{height:1200px}#bottom{min-height:60px;padding:8px 18px}input{width:100%;padding:12px;border:1px solid #8b80b6;border-radius:12px}#scene{position:absolute;inset:0;background:radial-gradient(ellipse at 65% 40%,#8159ee,#231942);display:none;color:white}#scene::after{content:'LIVE / GAME';position:absolute;left:25%;top:45%;font-size:36px;font-weight:800}#controls{display:none;pointer-events:none}#hud{display:flex;justify-content:space-between;padding:12px}#hud button{pointer-events:auto}#live-input{position:absolute;left:16px;right:16px;bottom:12px;width:auto}html[data-prototype-layout="edge-to-edge"] #scene,html[data-prototype-layout="edge-to-edge"] #controls{display:block}html[data-prototype-navigation-mode="overlay"] #nav{background:transparent;color:white}html[data-prototype-navigation-mode="overlay"] #hud{padding-top:64px}html[data-prototype-layout="edge-to-edge"] #shell{position:relative;background:transparent}html[data-prototype-layout="edge-to-edge"] #scroll,html[data-prototype-layout="edge-to-edge"] #bottom{visibility:hidden}
</style></head><body><div id="scene"></div><main id="shell" data-prototype-shell><header id="nav" data-prototype-navigation><span>赛博派对 · 测试</span><button>本地</button></header><section id="scroll"><input id="entry" placeholder="输入内容保持不丢失"><h1>今晚，一起玩点什么？</h1><div id="long"><p>独立测试页面 · 无外部资源</p><button>发起一场聚会 →</button></div></section><footer id="bottom"><button style="width:100%">加入朋友的聚会</button></footer></main><section id="controls" data-prototype-safe-controls><div id="hud"><button>关闭</button><button>暂停 / 互动</button></div><input id="live-input" placeholder="发送弹幕"></section><script>window.fixtureBoots=(window.fixtureBoots||0)+1;window.fixtureMarker='alive';</script></body></html>`

/** 直接提取随应用分发的全屏示例，不改写 HTML/CSS，验证生成规范本身。 */
const skillHtml = [...interactionSkill.matchAll(/```html\s*([\s\S]*?)```/g)].map(match => match[1]!).find(block => block.includes('class="hud"'))
if (!skillHtml) throw new Error('默认 Skill 缺少全屏 HTML 示例')

/** 根据场景构建版本化移动合同，旧页故意不带环境和 presentation。 */
function makeDraft(scene: Scene): PrototypeDraft {
  /** 全屏场景使用覆盖导航，游戏同时隐藏系统状态栏。 */
  const presentation = { schemaVersion: 1 as const, contentLayout: scene === 'live' || scene === 'skill' || scene === 'game' ? 'edge-to-edge' as const : 'safe' as const, statusBar: scene === 'game' ? 'hidden' as const : scene === 'live' || scene === 'skill' ? 'light' as const : 'dark' as const, navigation: scene === 'game' ? 'none' as const : scene === 'live' || scene === 'skill' ? 'overlay' as const : 'inline' as const, orientation: 'portrait' as const }
  return {
    name: '移动安全区隔离测试', brief: '', platform: 'mobile', groups: [{ id: 'main', name: '主要页面' }], entryPageId: 'home', flows: [],
    ...(scene === 'legacy' ? {} : { environment: { schemaVersion: 1 as const, target: 'ios' as const, deviceId: 'iPhone 17' as const } }),
    pages: [{ id: 'home', groupId: 'main', name: '首页', html: scene === 'legacy' ? '<html><body style="padding:13px"><input id="entry"><p>旧页面保持原始布局</p></body></html>' : scene === 'skill' ? skillHtml! : html,
      ...(scene === 'legacy' ? {} : { presentation }),
      ...(scene === 'states' ? { states: [{ id: 'game', name: '全屏游戏', html, presentation: { ...presentation, contentLayout: 'edge-to-edge' as const, statusBar: 'hidden' as const, navigation: 'none' as const } }, { id: 'inherited', name: '继承页面', html }] } : {}),
    }],
  }
}

/** 独立真实预览组件，不挂载完整应用，不读取真实工作区或 IPC。 */
function Fixture(): React.ReactElement {
  /** 设备与方向独立于草稿身份变化，测试切机型不重建 iframe。 */
  const [device, setDevice] = React.useState<PrototypeDeviceId>('iPhone 17')
  const [orientation, setOrientation] = React.useState<'portrait' | 'landscape'>('portrait')
  /** 场景变化允许重建，以免把状态保留断言混入换正文操作。 */
  const [scene, setScene] = React.useState<Scene>('normal')
  /** 同一场景草稿引用稳定，防止测试自己引入无关重渲染。 */
  const draft = React.useMemo(() => makeDraft(scene), [scene])
  window.__mobileSmoke = { device: (value, direction = 'portrait') => { setDevice(value); setOrientation(direction) }, scene: value => { setScene(value); setDevice('iPhone 17'); setOrientation('portrait') }, exportHtml: () => buildPrototypeExport(draft, {}) }
  return <div className="interaction-design dark" style={{ width: '100vw', height: '100vh', background: '#202023' }}><InteractionDesignPreview key={scene} active draft={draft} pageId="home" revision={1} identity={scene} mode="play" device={device} orientation={orientation} assets={{}} pendingAssets={[]} onZoomChange={() => undefined} onSelect={() => undefined} onNavigate={() => undefined} /></div>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
