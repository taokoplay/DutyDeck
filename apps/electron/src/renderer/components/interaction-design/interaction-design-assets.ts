import type { PrototypeAsset } from '@dutydeck/shared'

/** 已读取的预览资源正文。 */
export interface PrototypePreviewAssetData {
  /** 对应资源身份。 */
  assetId: string
  /** 可直接注入预览的本地数据 URL。 */
  dataUrl: string
}

/** 预览资源队列的输入与生命周期回调。 */
export interface LoadPrototypePreviewAssetsOptions {
  /** 按优先级排列的只读资源列表。 */
  assets: readonly PrototypeAsset[]
  /** 读取指定资源，返回资源身份与数据 URL。 */
  read: (asset: PrototypeAsset) => Promise<PrototypePreviewAssetData>
  /** 判断当前加载代次是否仍有效；失效后停止投递和补位。 */
  isCurrent: () => boolean
  /** 单项完成后立即回传资源及成功或失败结果。 */
  onSettled: (asset: PrototypeAsset, result: PromiseSettledResult<PrototypePreviewAssetData>) => void
}

/** 按输入顺序以最多四路并发读取资源；全部在途请求结束后返回。 */
export async function loadPrototypePreviewAssets(options: LoadPrototypePreviewAssetsOptions): Promise<void> {
  /** 下一个尚未启动的资源位置，由各并发槽在同步阶段领取。 */
  let nextIndex = 0

  /** 一个并发槽持续领取资源；每项完成即回传，失效后安静退出。 */
  async function consume(): Promise<void> {
    while (options.isCurrent() && nextIndex < options.assets.length) {
      /** 当前槽位负责读取的资源。 */
      const asset = options.assets[nextIndex++]!
      /** 独立封装此资源结果，避免失败中断其他资源。 */
      let result: PromiseSettledResult<PrototypePreviewAssetData>
      try {
        result = { status: 'fulfilled', value: await options.read(asset) }
      } catch (reason: unknown) {
        result = { status: 'rejected', reason }
      }
      if (!options.isCurrent()) return
      options.onSettled(asset, result)
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, options.assets.length) }, () => consume()))
}

/** 一个缓存实例内等待或正在读取的资源；只保留未结算请求。 */
interface SharedAssetRead {
  /** 资源身份与内容哈希共同避免同 ID 内容替换串用。 */
  key: string
  /** 已授权资源摘要。 */
  asset: PrototypeAsset
  /** 同一在途请求的所有消费者当前性判断。 */
  consumers: Array<() => boolean>
  /** 所有消费者复用同一个 Promise。 */
  promise: Promise<PrototypePreviewAssetData>
  /** 完成入口；结算前释放内部索引。 */
  resolve: (value: PrototypePreviewAssetData) => void
  /** 失败或排队取消入口，交给既有加载器统一处理。 */
  reject: (reason: unknown) => void
}

/**
 * 为一个缓存实例创建共享读取器；输入授权 IPC 函数，返回接受资源与消费者当前性的 read。
 * 总在途 IPC 最多四个；复用同资源未结算请求，结算后不持有正文，允许显式重试。
 */
export function createPrototypePreviewAssetReader(read: (asset: PrototypeAsset) => Promise<PrototypePreviewAssetData>): (asset: PrototypeAsset, isCurrent: () => boolean) => Promise<PrototypePreviewAssetData> {
  /** 等待和在途请求索引，不跨工作区/版本共享。 */
  const requests = new Map<string, SharedAssetRead>()
  /** FIFO 排队；启动前重新检查消费者，取消任务不占用 IPC。 */
  const queue: SharedAssetRead[] = []
  /** 真实 IPC 在途数，包含已切走页面尚未结束的读取。 */
  let active = 0

  /** 填充空槽；输入无，任务结算后继续补位。 */
  function pump(): void {
    while (active < 4 && queue.length) {
      /** 当前等待项只在至少一个消费者仍有效时启动。 */
      const request = queue.shift()!
      if (!request.consumers.some(isCurrent => isCurrent())) {
        requests.delete(request.key)
        request.reject(new Error('预览资源请求已取消'))
        continue
      }
      active += 1
      /** 同步抛错与异步失败都释放槽位，且不把失败永久缓存。 */
      void (async () => {
        try {
          /** 已授权的实际读取结果，仅交给该资源的消费者。 */
          const value = await read(request.asset)
          requests.delete(request.key)
          request.resolve(value)
        } catch (error: unknown) {
          requests.delete(request.key)
          request.reject(error)
        } finally {
          active -= 1
          queueMicrotask(pump)
        }
      })()
    }
  }

  return (asset, isCurrent) => {
    /** JSON 元组避免资源 ID 与哈希的分隔符碰撞。 */
    const key = JSON.stringify([asset.id, asset.hash])
    /** 在途请求允许新页面接管；不因旧消费者失效重新读取。 */
    const existing = requests.get(key)
    if (existing) { existing.consumers.push(isCurrent); return existing.promise }
    /** 先创建结算入口，再原子加入索引和队列。 */
    let resolve!: SharedAssetRead['resolve']
    let reject!: SharedAssetRead['reject']
    const promise = new Promise<PrototypePreviewAssetData>((accept, fail) => { resolve = accept; reject = fail })
    const request: SharedAssetRead = { key, asset, consumers: [isCurrent], promise, resolve, reject }
    requests.set(key, request)
    queue.push(request)
    pump()
    return promise
  }
}
