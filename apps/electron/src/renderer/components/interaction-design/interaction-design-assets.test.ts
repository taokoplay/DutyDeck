import { describe, expect, test } from 'bun:test'
import type { PrototypeAsset } from '@dutydeck/shared'
import { createPrototypePreviewAssetReader, loadPrototypePreviewAssets } from './interaction-design-assets'

/** 测试资源正文，仅保留队列需要的资源身份与数据。 */
interface PreviewAsset { assetId: string; dataUrl: string }

/** 根据数量生成有序资源，返回独立测试输入。 */
function createAssets(count: number): PrototypeAsset[] {
  return Array.from({ length: count }, (_, index) => ({ id: String(index), name: String(index), hash: String(index), mime: 'image/png', byteSize: 1, createdAt: 1 }))
}

/** 创建可手动完成的请求，以真实 Promise 检查调度顺序。 */
function deferredAsset() {
  /** 保存请求的成功入口。 */
  let resolve!: (value: PreviewAsset) => void
  /** 保存请求的失败入口。 */
  let reject!: (reason: Error) => void
  /** 待测试驱动完成的真实请求。 */
  const promise = new Promise<PreviewAsset>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

/** 清空本轮微任务，让队列观察请求完成；不依赖定时等待。 */
async function flushMicrotasks(): Promise<void> { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

describe('原型预览资源并发队列', () => {
  test('Given 超过四张资源 When 部分请求很慢 Then 并发最多四个且任一完成立即补位', async () => {
    /** 资源、可控读取与观察记录。 */
    const assets = createAssets(7)
    const pending = assets.map(() => deferredAsset())
    const started: string[] = []
    const completed: string[] = []
    let active = 0
    let maximumActive = 0
    const loading = loadPrototypePreviewAssets({ assets, isCurrent: () => true, read: asset => {
      started.push(asset.id); active += 1; maximumActive = Math.max(maximumActive, active)
      return pending[Number(asset.id)]!.promise.finally(() => { active -= 1 })
    }, onSettled: asset => { completed.push(asset.id) } })
    expect(started).toEqual(['0', '1', '2', '3'])
    pending[1]!.resolve({ assetId: '1', dataUrl: 'data:1' })
    await flushMicrotasks(); await flushMicrotasks()
    expect(completed).toEqual(['1'])
    expect(started).toEqual(['0', '1', '2', '3', '4'])
    for (const [index, pendingAsset] of pending.entries()) pendingAsset.resolve({ assetId: String(index), dataUrl: `data:${index}` })
    await loading
    expect(maximumActive).toBe(4)
    expect(completed).toHaveLength(7)
  })

  test('Given 同步抛错或异步失败 When 读取资源 Then 错误逐项回传且其他资源继续完成', async () => {
    /** 记录每项结算状态与失败原因。 */
    const results = new Map<string, PromiseSettledResult<PreviewAsset>>()
    const failure = new Error('读取失败')
    await loadPrototypePreviewAssets({ assets: createAssets(6), isCurrent: () => true, read: asset => {
      if (asset.id === '0') throw failure
      if (asset.id === '1') return Promise.reject(failure)
      return Promise.resolve({ assetId: asset.id, dataUrl: `data:${asset.id}` })
    }, onSettled: (asset, result) => { results.set(asset.id, result) } })
    expect(results.size).toBe(6)
    expect(results.get('0')).toEqual({ status: 'rejected', reason: failure })
    expect(results.get('1')).toEqual({ status: 'rejected', reason: failure })
    expect(results.get('5')).toEqual({ status: 'fulfilled', value: { assetId: '5', dataUrl: 'data:5' } })
  })

  test('Given 四项读取在途 When 当前页面失效 Then 迟到成功失败均不回调且不启动后续资源', async () => {
    /** 当前代次、可控请求与调用记录。 */
    let current = true
    const pending = deferredAsset()
    const started: string[] = []
    const completed: string[] = []
    const loading = loadPrototypePreviewAssets({ assets: createAssets(8), isCurrent: () => current, read: asset => {
      started.push(asset.id)
      return asset.id === '0' ? pending.promise.then(() => { throw new Error('迟到失败') }) : pending.promise
    }, onSettled: asset => { completed.push(asset.id) } })
    current = false
    pending.resolve({ assetId: 'late', dataUrl: 'data:late' })
    await loading
    expect(started).toEqual(['0', '1', '2', '3'])
    expect(completed).toEqual([])
  })

  test('Given 已取消或空资源 When 启动队列 Then 不调用读取和回调', async () => {
    /** 累计所有意外操作，覆盖初始取消与空输入。 */
    let calls = 0
    for (const assets of [createAssets(3), []]) {
      await loadPrototypePreviewAssets({ assets, isCurrent: () => assets.length === 0, read: async asset => {
        calls += 1; return { assetId: asset.id, dataUrl: 'data:' }
      }, onSettled: () => { calls += 1 } })
    }
    expect(calls).toBe(0)
  })
})


describe('跨缓存页共享的资源读取器', () => {
  test('Given A/B/A 快速切页 When A资源仍在途 Then 复用同一 Promise 且只读取一次', async () => {
    /** 同一缓存实例内的读取计数与首个请求。 */
    const pending = deferredAsset(); let calls = 0, firstActive = true
    const read = createPrototypePreviewAssetReader(() => { calls++; return pending.promise })
    const asset = createAssets(1)[0]!
    const first = read(asset, () => firstActive)
    firstActive = false
    const returned = read(asset, () => true)
    expect(returned).toBe(first); expect(calls).toBe(1)
    pending.resolve({ assetId: asset.id, dataUrl: 'data:image' })
    expect(await returned).toEqual({ assetId: asset.id, dataUrl: 'data:image' })
  })
  test('Given 多个页面同时请求 When 总量超过四路 Then 所有页面共享并发预算且完成后立即补位', async () => {
    /** 阻塞首批请求，观察真正进入 IPC 的总量。 */
    const assets = createAssets(9), pending = assets.map(() => deferredAsset()), started: string[] = []
    let active = 0, peak = 0
    const read = createPrototypePreviewAssetReader(asset => {
      started.push(asset.id); active++; peak = Math.max(peak, active)
      return pending[Number(asset.id)]!.promise.finally(() => { active-- })
    })
    const results = assets.map(asset => read(asset, () => true))
    expect(started).toEqual(['0', '1', '2', '3'])
    pending[1]!.resolve({ assetId: '1', dataUrl: 'data:1' })
    await flushMicrotasks(); await flushMicrotasks(); expect(started).toEqual(['0', '1', '2', '3', '4'])
    pending.forEach((item, index) => item.resolve({ assetId: String(index), dataUrl: 'data:' }))
    await Promise.all(results); expect(peak).toBe(4); expect(started).toHaveLength(9)
  })
  test('Given 排队页失效 When 等到空槽 Then 无有效消费者的任务不发 IPC但共享有效消费者仍启动', async () => {
    /** 第五项完全失效，第六项由新页面重新订阅。 */
    const assets = createAssets(6), pending = deferredAsset(), started: string[] = []
    let current = true
    const read = createPrototypePreviewAssetReader(asset => { started.push(asset.id); return pending.promise })
    const requests = assets.map(asset => read(asset, () => current))
    const settled = Promise.allSettled(requests)
    current = false
    expect(read(assets[5]!, () => true)).toBe(requests[5]!)
    pending.resolve({ assetId: 'test', dataUrl: 'data:' })
    const results = await settled
    expect(started).toEqual(['0', '1', '2', '3', '5']); expect(results[4]!.status).toBe('rejected')
  })
  test('Given 失败或已完成读取 When 显式重新请求 Then 不保留正文和失败缓存且可以重试', async () => {
    /** 既覆盖同步失败，也验证成功后再次读取不永久缓存 dataUrl。 */
    let calls = 0
    const read = createPrototypePreviewAssetReader(async asset => { if (++calls === 1) throw new Error('失败'); return { assetId: asset.id, dataUrl: 'data:' } })
    const asset = createAssets(1)[0]!
    await expect(read(asset, () => true)).rejects.toThrow('失败')
    await read(asset, () => true); await read(asset, () => true); expect(calls).toBe(3)
  })
})

test('Given 相同 ID 内容哈希不同 When 同时读取 Then 不复用错误正文且初始失效请求不启动', async () => {
  /** 哈希不同视为不同实际内容；无有效消费者时不进入 IPC。 */
  const asset = createAssets(1)[0]!, pending = deferredAsset()
  let calls = 0
  const read = createPrototypePreviewAssetReader(() => { calls++; return pending.promise })
  const first = read(asset, () => true)
  const changed = read({ ...asset, hash: 'new' }, () => true)
  expect(changed).not.toBe(first)
  await expect(read({ ...asset, id: 'cancelled' }, () => false)).rejects.toThrow('已取消')
  expect(calls).toBe(2)
  pending.resolve({ assetId: asset.id, dataUrl: 'data:' }); await Promise.all([first, changed])
})
test('Given 大批排队读取同步失败 When 释放首批槽位 Then 不递归溢出且所有请求结算', async () => {
  /** 先堵住四个槽位，再让后续请求同步失败以覆盖补位异常路径。 */
  const pending = deferredAsset(), assets = createAssets(1000)
  const read = createPrototypePreviewAssetReader(asset => { if (Number(asset.id) >= 4) throw new Error('同步失败'); return pending.promise })
  const results = Promise.allSettled(assets.map(asset => read(asset, () => true)))
  pending.resolve({ assetId: 'test', dataUrl: 'data:' })
  expect((await results).filter(result => result.status === 'rejected')).toHaveLength(996)
})
