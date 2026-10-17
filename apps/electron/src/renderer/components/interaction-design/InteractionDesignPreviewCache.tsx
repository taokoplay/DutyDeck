import * as React from 'react'
import type { PrototypeAsset, PrototypeDraft } from '@dutydeck/shared'
import { InteractionDesignPreview, type InteractionDesignPreviewProps } from './InteractionDesignPreview'
import { createPrototypePreviewAssetReader, loadPrototypePreviewAssets } from './interaction-design-assets'
import { PROTOTYPE_PAGE_CACHE_LIMITS, retainPrototypePage, type PrototypePageCache } from './interaction-design-page-cache'

/** 页面缓存只驻留当前工作区；外层 key 在项目、正式版本或候选变化时清空它。 */
interface InteractionDesignPreviewCacheProps extends Omit<InteractionDesignPreviewProps, 'assets' | 'pendingAssets'> {
  /** 资源读取仍经过已授权会话与模块 IPC。 */
  sessionId: string
  prototypeId: string
  /** 当前模块资源摘要，不复制图片正文。 */
  assetMetadata: PrototypeAsset[]
  /** 手动刷新只替换当前页面实例。 */
  refresh: number
  /** 当前页面资源反馈，隐藏页面不得更新工作区提示。 */
  onAssetError: (message: string | null) => void
}

/** 所有驻留页共用读取器，快速切页时复用在途资源并共享四路并发上限。 */
interface CachedPreviewPageProps extends InteractionDesignPreviewCacheProps {
  /** 输入资源与消费者有效性，返回只存在于本缓存实例的读取 Promise。 */
  readAsset: ReturnType<typeof createPrototypePreviewAssetReader>
}

/** 输入当前页与已授权资源目录，按正文出现顺序返回去重资源，默认画板优先。 */
function pageAssets(draft: PrototypeDraft, pageId: string, metadata: PrototypeAsset[]): PrototypeAsset[] {
  /** 目标页与全部状态的资源身份。 */
  const page = draft.pages.find(item => item.id === pageId)
  /** 保留引用顺序，同时避免一页多个状态重复读取同一图片。 */
  const ids = new Set([page?.html ?? '', ...(page?.states ?? []).map(state => state.html)].flatMap(html => [...html.matchAll(/prototype-asset:([A-Za-z0-9_-]+)/g)].map(match => match[1]!)))
  /** 仅从授权目录读取，不对未知身份调用 IPC。 */
  const byId = new Map(metadata.map(asset => [asset.id, asset]))
  return [...ids].flatMap(id => { const asset = byId.get(id); return asset ? [asset] : [] })
}

/** 单页独立保留图片和沙箱；隐藏只停止未完成调度，已加载画面保持原交互现场。 */
function CachedPreviewPage(props: CachedPreviewPageProps): React.ReactElement {
  /** 图片字典与体验实例同生共灭，失败用空串表示，显式刷新才重试。 */
  const [assets, setAssets] = React.useState<Record<string, string>>({})
  /** 回调读最新缓存，避免每项结算后重启队列。 */
  const assetsRef = React.useRef(assets)
  assetsRef.current = assets
  /** 资源反馈只在本页活跃时发布给工作区。 */
  const [error, setError] = React.useState<string | null>(null)
  /** 渲染时即撤销隐藏页的回流，早于 effect 清理。 */
  const activeRef = React.useRef(props.active)
  activeRef.current = props.active
  /** 资源摘要变化不重新执行已经冻结的 iframe。 */
  const usedAssets = React.useMemo(() => pageAssets(props.draft, props.pageId, props.assetMetadata), [props.draft, props.pageId, props.assetMetadata])
  /** 尚未结算的引用才显示加载反馈。 */
  const pendingAssets = usedAssets.filter(asset => !Object.hasOwn(assets, asset.id)).map(asset => asset.id)

  React.useEffect(() => {
    if (props.active) props.onAssetError(error)
  }, [props.active, error, props.onAssetError])

  React.useEffect(() => {
    if (!props.active) return
    /** 只保留当前页资源，页面缓存淘汰时连同这些数据一起释放。 */
    const retained = usedAssets.reduce<Record<string, string>>((values, asset) => {
      if (Object.hasOwn(assetsRef.current, asset.id)) values[asset.id] = assetsRef.current[asset.id]!
      return values
    }, {})
    /** 单页超限仍显示页面与占位，不开始无界读取或无限转圈。 */
    const total = usedAssets.reduce((sum, asset) => sum + asset.byteSize, 0)
    if (usedAssets.some(asset => !Number.isFinite(asset.byteSize) || asset.byteSize < 0) || total > PROTOTYPE_PAGE_CACHE_LIMITS.assetBytes) {
      setAssets(Object.fromEntries(usedAssets.map(asset => [asset.id, ''])))
      setError('当前页图片超过 64 MiB 预览预算，请压缩图片后再预览。')
      return
    }
    setAssets(retained)
    /** 失败缓存保留到用户显式重试，切页不会触发失败资源重试风暴。 */
    const failures = usedAssets.filter(asset => Object.hasOwn(retained, asset.id) && !retained[asset.id]).map(asset => asset.name)
    setError(failures.length ? `部分图片加载失败：${failures.join('、')}` : null)
    /** 切页、切版本或卸载后拒绝迟到结果和后续请求补位。 */
    let disposed = false
    void loadPrototypePreviewAssets({
      assets: usedAssets.filter(asset => !Object.hasOwn(retained, asset.id)),
      read: asset => props.readAsset(asset, () => !disposed && activeRef.current),
      isCurrent: () => !disposed && activeRef.current,
      onSettled: (asset, outcome) => {
        /** 返回身份不符也按失败处理，不能替换另一张图片。 */
        const value = outcome.status === 'fulfilled' && outcome.value.assetId === asset.id ? outcome.value.dataUrl : ''
        setAssets(previous => ({ ...previous, [asset.id]: value }))
        if (!value) { failures.push(asset.name); setError(`部分图片加载失败：${failures.join('、')}`) }
      },
    })
    return () => { disposed = true }
  }, [props.active, props.readAsset, usedAssets])

  return <div className="id-cached-page" data-page-id={props.pageId} data-active={props.active} hidden={!props.active} aria-hidden={!props.active}>
    <InteractionDesignPreview {...props} assets={assets} pendingAssets={pendingAssets} />
  </div>
}

/** 最近页面保留真实 iframe；达到数量、画板或资源预算后按最近访问淘汰，DOM 顺序保持稳定。 */
export function InteractionDesignPreviewCache(props: InteractionDesignPreviewCacheProps): React.ReactElement {
  /** 共享读取器随工作区/版本缓存销毁；只合并在途请求，已完成资源仍由各页有界持有。 */
  const readAsset = React.useMemo(() => createPrototypePreviewAssetReader(asset => window.electronAPI.interactionDesign.invoke('assetContent', {
    sessionId: props.sessionId, prototypeId: props.prototypeId, assetId: asset.id,
  })), [props.sessionId, props.prototypeId])
  /** 当前页面成本仅在页面或资源目录变化时计算。 */
  const cost = React.useMemo(() => ({
    pageId: props.pageId,
    assetBytes: pageAssets(props.draft, props.pageId, props.assetMetadata).reduce((sum, asset) => sum + (asset.byteSize < 0 ? Infinity : asset.byteSize), 0),
    frames: 1 + (props.draft.pages.find(page => page.id === props.pageId)?.states?.length ?? 0),
  }), [props.draft, props.pageId, props.assetMetadata])
  /** 有界的实例列表只保存身份和成本，不复制整个设计稿。 */
  const [cache, setCache] = React.useState<PrototypePageCache>({ entries: [], activePageId: '', refresh: props.refresh, clock: 0 })
  /** 在渲染提交前同步页面集合，避免先显示旧页一帧或将旧页的资源给新页。 */
  const next = retainPrototypePage(cache, cost, props.refresh)
  if (next !== cache) setCache(next)
  return <div className="id-preview-cache">{next.entries.map(entry => <CachedPreviewPage {...props} key={`${entry.pageId}:${entry.instance}`} readAsset={readAsset} pageId={entry.pageId} identity={`${props.identity}:${entry.instance}`} active={props.active && entry.pageId === props.pageId} />)}</div>
}
