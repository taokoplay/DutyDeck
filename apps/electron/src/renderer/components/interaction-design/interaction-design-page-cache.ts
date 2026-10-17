/** 缓存至少受页面数、画板数和原始图片字节三项约束；GPU/解码内存仍由浏览器管理。 */
export const PROTOTYPE_PAGE_CACHE_LIMITS = { pages: 3, frames: 16, assetBytes: 64 * 1024 * 1024 } as const

/** 当前页面的缓存成本，不复制页面正文。 */
export interface PrototypePageCost {
  /** 页面稳定身份。 */
  pageId: string
  /** 当前页面全部状态引用的去重资源字节估计。 */
  assetBytes: number
  /** 默认画板与附加状态总数，未进入视口的状态也预留预算。 */
  frames: number
}

/** DOM 顺序与最近访问顺序分离，避免移动已挂载 iframe 导致浏览器重新加载。 */
export interface CachedPrototypePage extends PrototypePageCost {
  /** 新建或手动刷新的体验代次。 */
  instance: number
  /** 用于最久未用淘汰，不用来排序 DOM。 */
  lastUsed: number
}

/** 同一项目、版本与候选空间内的易失缓存，不写入业务数据。 */
export interface PrototypePageCache {
  /** 稳定插入顺序的页面实例。 */
  entries: CachedPrototypePage[]
  /** 当前可交互页面。 */
  activePageId: string
  /** 已处理的用户刷新代次。 */
  refresh: number
  /** 单调访问序号，确保同毫秒操作的淘汰顺序稳定。 */
  clock: number
}

/** 输入旧缓存、当前页面成本和刷新代次，返回有界缓存；相同输入复用引用且不修改旧数据。 */
export function retainPrototypePage(cache: PrototypePageCache, page: PrototypePageCost, refresh: number): PrototypePageCache {
  /** 非法成本按超限处理，不能绕过缓存预算。 */
  const cost = { ...page, assetBytes: Number.isFinite(page.assetBytes) && page.assetBytes >= 0 ? page.assetBytes : Infinity, frames: Number.isSafeInteger(page.frames) && page.frames > 0 ? page.frames : Infinity }
  /** 已打开的当前页；刷新只更换这一页的实例。 */
  const existing = cache.entries.find(entry => entry.pageId === page.pageId)
  if (cache.activePageId === page.pageId && cache.refresh === refresh && existing?.assetBytes === cost.assetBytes && existing?.frames === cost.frames) return cache
  /** 所有访问与刷新共享单调代次。 */
  const clock = cache.clock + 1
  /** 保持已有顺序，仅新页追加到末尾；淘汰不会移动其他 DOM 节点。 */
  let entries = cache.entries.map(entry => entry.pageId === page.pageId ? { ...cost, instance: cache.refresh === refresh ? entry.instance : clock, lastUsed: clock } : entry)
  if (!existing) entries.push({ ...cost, instance: clock, lastUsed: clock })
  while (entries.length > 1 && (entries.length > PROTOTYPE_PAGE_CACHE_LIMITS.pages || entries.reduce((sum, entry) => sum + entry.frames, 0) > PROTOTYPE_PAGE_CACHE_LIMITS.frames || entries.reduce((sum, entry) => sum + entry.assetBytes, 0) > PROTOTYPE_PAGE_CACHE_LIMITS.assetBytes)) {
    /** 当前页必须可查看；优先移除其他页面里最久未访问的一项。 */
    const oldest = entries.filter(entry => entry.pageId !== page.pageId).reduce((left, right) => left.lastUsed < right.lastUsed ? left : right)
    entries = entries.filter(entry => entry !== oldest)
  }
  return { entries, activePageId: page.pageId, refresh, clock }
}
