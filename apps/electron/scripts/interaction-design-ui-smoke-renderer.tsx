import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { createStore, Provider } from 'jotai'
import type { InteractionDesignApi, InteractionDesignChanged, InteractionDesignInputs, InteractionDesignMethod, InteractionDesignResults, PrototypeAsset, PrototypeCandidate, PrototypeDocument, PrototypeHandoff, PrototypePageComparison, PrototypeSnapshot } from '@dutydeck/shared'
import { agentPendingPromptAtom } from '../src/renderer/atoms/agent-atoms'
import { TooltipProvider } from '../src/renderer/components/ui/tooltip'
import '../src/renderer/styles/globals.css'
/** 内存测试正文，绝不访问真实项目。 */
const initial: PrototypeDocument = { schemaVersion: 1, id: 'proto-a', revision: 1, createdAt: 1, updatedAt: 1, name: '拾光测试', brief: '', platform: 'mobile', groups: [{ id: 'group-a', name: '开始' }, { id: 'group-b', name: '核心', parentId: 'group-a' }], pages: [{ id: 'home', groupId: 'group-a', name: '欢迎', html: '<html><head><style>body{font:18px system-ui;background:#f3f6ed;padding:28px}button{padding:15px;background:#557b60;color:white;border:0;border-radius:12px}</style></head><body><h1 data-prototype-element="title">拾光</h1><img alt="可用图片" src="prototype-asset:asset-good"><img alt="损坏图片" src="prototype-asset:asset-broken"><input placeholder="你的名字"><button data-prototype-element="next" data-prototype-page="detail">开始体验</button></body></html>' }, { id: 'detail', groupId: 'group-b', name: '今日习惯', html: '<html><body><h1 data-prototype-element="title">今日习惯</h1><button data-prototype-page="home">返回首页</button></body></html>' }], entryPageId: 'home', flows: [] }
/** 1×1 PNG 用于验证 renderer 已将 IPC 返回的数据 URL 注入 iframe。 */
const fixturePngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
/** 内存 fixture 的资源元数据，覆盖可读资产与读取失败资产两条路径。 */
const fixtureAssets: PrototypeAsset[] = [
  { id: 'asset-good', name: '可用图片', hash: 'a'.repeat(64), mime: 'image/png', byteSize: 68, createdAt: 1 },
  { id: 'asset-broken', name: '损坏图片', hash: 'b'.repeat(64), mime: 'image/png', byteSize: 68, createdAt: 1 },
]
/** 六面体仅验证离线场景与可信输入传递，不代表真实家具或制造精度。 */
const geometryHtml = `<!doctype html><html><head><style>
body{margin:0;font:16px system-ui;background:#eef3ee}#viewport{height:300px;display:grid;place-items:center;perspective:600px;touch-action:none;cursor:grab}#cube{position:relative;width:100px;height:100px;transform-style:preserve-3d;pointer-events:none}.face{position:absolute;inset:0;background:#8caa8b;border:2px solid #234;box-sizing:border-box;backface-visibility:hidden}.face:nth-child(1){transform:translateZ(50px)}.face:nth-child(2){transform:rotateY(180deg) translateZ(50px)}.face:nth-child(3){transform:rotateY(90deg) translateZ(50px)}.face:nth-child(4){transform:rotateY(-90deg) translateZ(50px)}.face:nth-child(5){transform:rotateX(90deg) translateZ(50px)}.face:nth-child(6){transform:rotateX(-90deg) translateZ(50px)}button{padding:16px;margin:8px}
</style></head><body><h1>近似模型 / 交互演示</h1><div id="viewport" data-prototype-element="scene"><div id="cube"><div class="face">前</div><div class="face">后</div><div class="face">右</div><div class="face">左</div><div class="face">上</div><div class="face">下</div></div></div><button id="reset" data-prototype-element="reset">复位</button><form id="form"><button type="submit" data-prototype-element="submit">本地提交</button><output id="result">0</output></form><script>
// 场景状态仅保存在当前状态页内，两个 iframe 不共享变量。
const viewport=document.getElementById('viewport'),cube=document.getElementById('cube');let angle=25,scale=1,previous=null,submissions=0;
// 根据当前视角与缩放更新真实六面体的投影矩阵，无外部资源。
function render(){cube.style.transform='rotateX(-20deg) rotateY('+angle+'deg) scale('+scale+')';}
viewport.addEventListener('pointerdown',event=>{previous=event.clientX;viewport.setPointerCapture(event.pointerId);});
viewport.addEventListener('pointermove',event=>{if(previous===null)return;angle+=event.clientX-previous;previous=event.clientX;render();});
viewport.addEventListener('pointerup',()=>{previous=null;});
viewport.addEventListener('wheel',event=>{event.preventDefault();scale=Math.max(.5,Math.min(2,scale-event.deltaY/500));render();},{passive:false});
document.getElementById('reset').onclick=()=>{angle=25;scale=1;render();};
document.getElementById('form').onsubmit=()=>{document.getElementById('result').textContent=String(++submissions);};
render();
</script></body></html>`
/** 候选与 head 不同以检验不自动采用。 */
const candidate: PrototypeCandidate = { id: 'candidate-a', prototypeId: 'proto-a', baseRevision: 1, summary: '明确欢迎文案', affectedPageIds: ['home'], status: 'ready', createdAt: 2, draft: { ...structuredClone(initial), pages: initial.pages.map(page => ({ ...page, html: page.html.replace('拾光</h1>', '开始你的第一天</h1>') })) } }
/** 调用记录和延迟开关只存在 fixture 内存。 */
const state = { snapshot: { document: structuredClone(initial), versions: [{ revision: 1, summary: '初始版本', createdAt: 1 }], candidates: [candidate], assets: structuredClone(fixtureAssets), jobs: [], checks: [] } as PrototypeSnapshot, calls: [] as string[], assetReadCounts: {} as Record<string, number>, assetsInFlight: 0, maxAssetsInFlight: 0, holdCandidate: false, pendingCandidate: false, failNext: false }
/** 可控的资源延迟用于验证每个画板的加载状态与迟到隔离。 */
const heldAssets = new Map<string, Array<() => void>>()
/** 待暂缓的资源身份，只有测试显式释放时才完成读取。 */
const delayedAssets = new Set<string>()
/** 测试恢复读取失败的资源，验证显式重试会刷新占位图。 */
const recoveredAssets = new Set<string>()
const listeners = new Set<(event: InteractionDesignChanged) => void>()
let releaseCandidate: (() => void) | undefined
let switchHost: (() => void) | undefined
/** 切换到没有任何原型的隔离项目，覆盖新建入口回归。 */
let switchEmpty: (() => void) | undefined
/** 测试切到其他模块时保留组件挂载，验证隐藏期间暂停。 */
let switchPaneActive: ((active: boolean) => void) | undefined
const store = createStore()
/** mock 保留身份和 CAS，未知调用显式失败。 */
const api: InteractionDesignApi = {
  onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  async invoke<M extends InteractionDesignMethod>(method: M, input: InteractionDesignInputs[M]): Promise<InteractionDesignResults[M]> {
    state.calls.push(`${method}:${input.sessionId}`)
    if (state.failNext) { state.failNext = false; throw new Error('fixture 读取失败') }
    let result: unknown
    /** fixture 当前请求的项目；list/create 等命令也沿用同一唯一模块。 */
    const current = input.sessionId === 'session-b' ? { ...state.snapshot, document: { ...initial, id: 'proto-b', name: '新项目原型' }, candidates: [] } : state.snapshot
    switch (method) {
      case 'list': result = input.sessionId === 'session-c' ? [] : [{ id: current.document.id, name: current.document.name, platform: current.document.platform, revision: current.document.revision, pageCount: current.document.pages.length, updatedAt: current.document.updatedAt }]; break
      case 'load': result = structuredClone(current); break
      case 'create': {
        const request = input as InteractionDesignInputs['create']
        /** 新建结果模拟主进程返回的空原型首个版本。 */
        const created = { ...structuredClone(initial), id: 'proto-created', name: request.name, platform: request.platform, revision: 1, pages: [{ ...structuredClone(initial.pages[0]!), name: request.pageName ?? initial.pages[0]!.name }], entryPageId: 'home' }
        state.snapshot = { ...state.snapshot, document: created, versions: [{ revision: 1, summary: '创建原型', createdAt: 3 }], candidates: [] }
        result = structuredClone(state.snapshot)
        break
      }
      case 'getCandidate': {
        /** 保留延迟读取开关，以验证切项目后的旧响应隔离。 */
        const request = input as InteractionDesignInputs['getCandidate']
        if (state.holdCandidate) { state.pendingCandidate = true; await new Promise<void>(resolve => { releaseCandidate = resolve }); state.pendingCandidate = false }
        /** 实际选中的候选摘要携带独立状态，默认候选正文允许测试修改。 */
        const selected = current.candidates.find(item => item.id === request.candidateId)
        if (!selected) throw new Error('fixture 候选不存在')
        result = { ...structuredClone(selected), draft: structuredClone(candidate.draft) }
        break
      }
      case 'getCandidateImpact': {
        /** 旧候选兼容查询只返回页面身份，不把整个候选正文传给目录。 */
        const request = input as InteractionDesignInputs['getCandidateImpact']
        const selected = current.candidates.find(item => item.id === request.candidateId)
        if (!selected) throw new Error('fixture 候选不存在')
        result = { pageIds: selected.affectedPageIds ?? ['home'] }
        break
      }
      case 'discardCandidate': {
        /** 取消仅改变候选状态，正式页面保持原样。 */
        const request = input as InteractionDesignInputs['discardCandidate']
        state.snapshot.candidates = state.snapshot.candidates.map(item => item.id === request.candidateId ? { ...item, status: 'discarded' } : item)
        result = structuredClone(state.snapshot)
        break
      }
      case 'deleteHistory': {
        /** 删除夹具遵循正式服务的版本和运行态边界。 */
        const request = input as InteractionDesignInputs['deleteHistory']
        if (request.baseRevision !== state.snapshot.document.revision) throw new Error('fixture 版本冲突')
        if (request.kind === 'candidate') {
          const selected = state.snapshot.candidates.find(item => item.id === request.recordId)
          if (!selected) throw new Error('fixture 候选不存在')
          state.snapshot.candidates = state.snapshot.candidates.filter(item => item.id !== request.recordId)
          if (selected.jobId) state.snapshot.jobs = state.snapshot.jobs.filter(item => item.id !== selected.jobId)
        } else {
          const selected = state.snapshot.jobs.find(item => item.id === request.recordId)
          if (!selected) throw new Error('fixture 任务不存在')
          if (selected.status === 'running') throw new Error('运行中的任务不能删除')
          state.snapshot.jobs = state.snapshot.jobs.filter(item => item.id !== request.recordId)
        }
        result = structuredClone(state.snapshot)
        break
      }
      case 'assetContent': {
        /** 当前 smoke 请求的资源身份。 */
        const request = input as InteractionDesignInputs['assetContent']
        // 每个资源的次数与并发峰值用于证明切页不重复读取同一张在途图片。
        state.assetReadCounts[request.assetId] = (state.assetReadCounts[request.assetId] ?? 0) + 1
        state.assetsInFlight += 1
        state.maxAssetsInFlight = Math.max(state.maxAssetsInFlight, state.assetsInFlight)
        try {
          if (delayedAssets.has(request.assetId)) await new Promise<void>(resolve => heldAssets.set(request.assetId, [...(heldAssets.get(request.assetId) ?? []), resolve]))
          if (request.assetId === 'asset-broken' && !recoveredAssets.has(request.assetId)) throw new Error('fixture 图片读取失败')
          result = { assetId: request.assetId, dataUrl: fixturePngDataUrl }
        } finally { state.assetsInFlight -= 1 }
        break
      }
      case 'save': { const request = input as InteractionDesignInputs['save']; if (request.baseRevision !== state.snapshot.document.revision) throw new Error('fixture 版本冲突'); state.snapshot.document = { ...state.snapshot.document, ...request.draft, revision: request.baseRevision + 1 }; state.snapshot.versions.push({ revision: state.snapshot.document.revision, summary: request.summary, createdAt: 3 }); result = structuredClone(state.snapshot); break }
      case 'adopt': {
        /** 采纳绑定候选及正式版本，保留其他候选以覆盖历史合并。 */
        const request = input as InteractionDesignInputs['adopt']
        const selected = state.snapshot.candidates.find(item => item.id === request.candidateId)
        if (!selected || selected.status !== 'ready') throw new Error('fixture 候选不可采纳')
        state.snapshot.document = { ...state.snapshot.document, ...candidate.draft, revision: state.snapshot.document.revision + 1 }
        state.snapshot.candidates = state.snapshot.candidates.map(item => item.id === selected.id ? { ...item, status: 'adopted', adoptedRevision: state.snapshot.document.revision } : item)
        state.snapshot.versions.push({ revision: state.snapshot.document.revision, summary: '采纳候选', createdAt: 4 })
        result = structuredClone(state.snapshot)
        break
      }
      case 'comparePage': {
        /** 历史对比 fixture 只返回目标页，验证 UI 不会回传邻页正文。 */
        const request = input as InteractionDesignInputs['comparePage']
        const selectedPage = current.document.pages.find(page => page.id === request.pageId) ?? current.document.pages[0]!
        const selectedCandidate = current.candidates.find(item => item.id === request.right.candidateId) ?? candidate
        const candidatePage = selectedCandidate.draft.pages.find(page => page.id === request.pageId) ?? selectedPage
        const comparison: PrototypePageComparison = {
          prototypeId: current.document.id,
          pageId: selectedPage.id,
          left: { kind: 'version', id: String(request.left.revision ?? current.document.revision), globalRevision: request.left.revision ?? current.document.revision, pageRevision: selectedPage.pageRevision ?? 1, name: selectedPage.name, html: selectedPage.html },
          right: { kind: 'candidate', id: selectedCandidate.id, globalRevision: selectedCandidate.baseRevision, pageRevision: candidatePage.pageRevision ?? 1, name: candidatePage.name, html: candidatePage.html },
          defaultHtml: { changed: selectedPage.html !== candidatePage.html, before: selectedPage.html, after: candidatePage.html, addedLines: candidatePage.html === selectedPage.html ? [] : [candidatePage.html], removedLines: candidatePage.html === selectedPage.html ? [] : [selectedPage.html] },
          states: { added: [], removed: [], changed: [] }, assets: { added: [], removed: [] }, flows: { added: [], removed: [] },
        }
        result = comparison
        break
      }
      case 'restore': state.snapshot.document = { ...structuredClone(initial), revision: 1 }; result = structuredClone(state.snapshot); break
      case 'deleteVersion': {
        /** 删除请求使用打开确认时冻结的基线；模拟真实服务的冲突校验。 */
        const request = input as InteractionDesignInputs['deleteVersion']
        if (request.baseRevision !== state.snapshot.document.revision) throw new Error('fixture 版本冲突')
        if (request.revision === state.snapshot.document.revision) throw new Error('当前版本不能删除')
        state.snapshot.versions = state.snapshot.versions.filter(version => version.revision !== request.revision)
        result = structuredClone(state.snapshot)
        break
      }
      case 'createHandoff': {
        const request = input as InteractionDesignInputs['createHandoff']
        const handoff: PrototypeHandoff = {
          schemaVersion: 1, id: 'handoff-a', prototypeId: request.prototypeId, revision: request.revision, createdAt: 4, name: initial.name, platform: 'mobile', brief: '主路径',
          groups: [{ id: 'group-a', name: '开始', path: '开始' }, { id: 'group-b', name: '核心', parentId: 'group-a', path: '开始 / 核心' }],
          pages: [{ id: 'home', name: '欢迎', groupId: 'group-a', groupPath: '开始', elementIds: ['title', 'next'], flowIds: [] }, { id: 'detail', name: '今日习惯', groupId: 'group-b', groupPath: '开始 / 核心', elementIds: ['title'], flowIds: [] }],
          entryPageId: 'home', flows: [], assets: [], designTokens: {}, visualContract: { viewport: { width: 390, height: 844 }, preserve: ['布局比例'] }, manifestHash: 'a'.repeat(64),
        }
        result = handoff
        break
      }
      case 'inspectProject': result = { projectName: '当前项目', frameworks: ['React'], files: [{ path: 'src/App.tsx', kind: 'code', byteSize: 120 }], warnings: [], truncated: false }; break
      default: throw new Error(`fixture 未实现命令：${method}`)
    }
    return result as InteractionDesignResults[M]
  },
}
Object.defineProperty(window, 'electronAPI', { value: { interactionDesign: api }, configurable: true })
Object.defineProperty(window, '__interactionSmoke', { value: { state, candidate, geometryHtml, switchPaneActive: (active: boolean) => switchPaneActive?.(active), delayedAssets, recoveredAssets, releaseAsset: (id: string) => { delayedAssets.delete(id); heldAssets.get(id)?.forEach(resolve => resolve()); heldAssets.delete(id) }, switchHost: () => switchHost?.(), switchEmpty: () => switchEmpty?.(), release: () => { state.holdCandidate = false; releaseCandidate?.() }, prompt: () => store.get(agentPendingPromptAtom), change: (workspaceId = 'workspace-a', prototypeId?: string) => { for (const listener of listeners) listener({ workspaceId, prototypeId }) } } })
/** API 安装后再载入真实组件。 */
const { InteractionDesignWorkspace } = await import('../src/renderer/components/interaction-design/InteractionDesignWorkspace')
function Fixture(): React.ReactElement {
  const [host, setHost] = React.useState('a')
  /** 当前模块可见性受测试控制，不卸载工作区。 */
  const [paneActive, setPaneActive] = React.useState(true)
  switchPaneActive = setPaneActive
  switchHost = () => setHost('b')
  switchEmpty = () => setHost('c')
  return <Provider store={store}><TooltipProvider><div style={{ height: '100vh', display: 'flex', padding: 12 }}><div className="smoke-shell-line" style={{ position: 'absolute', left: '25%', top: 0, bottom: 0, width: 1, background: 'red', zIndex: 61, pointerEvents: 'none' }} /><div className="agent-right-panel-host relative z-[60] flex min-w-0 flex-1"><div className="smoke-shell-line" style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'red', zIndex: 10, pointerEvents: 'none' }} /><div className="agent-side-panel relative z-0 flex min-w-0 flex-1"><InteractionDesignWorkspace projectId={`workspace-${host}`} sessionId={`session-${host}`} paneActive={paneActive} /></div></div></div></TooltipProvider></Provider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
