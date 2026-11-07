import { expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { usePluginManagement } from './usePluginManagement'

function harness(refreshAction: () => Promise<void> = async () => undefined) {
  const store = createStore()
  let current!: ReturnType<typeof usePluginManagement>
  const Probe = () => { current = usePluginManagement(refreshAction, cause => String(cause)); return null }
  renderToStaticMarkup(<Provider store={store}><Probe /></Provider>)
  return current
}

test('Given 授权失败 When 刷新真实状态 Then 返回失败给编辑器且刷新不先于错误落定', async () => {
  const order: string[] = []
  const state = harness(async () => { order.push('refresh') })
  let closed = false
  const result = await state.manage(async () => { throw new Error('CAS_CONFLICT') })
  if (result) closed = true
  expect(result).toBe(false)
  expect(closed).toBe(false)
  expect(order).toEqual(['refresh'])
})

test('Given 操作处理中 When 同时保存 Then 拒绝第二次保存且只有第一次成功', async () => {
  const state = harness()
  let release!: () => void
  const first = state.manage(() => new Promise<void>(resolve => { release = resolve }))
  let duplicate = false
  expect(await state.manage(async () => { duplicate = true })).toBe(false)
  expect(duplicate).toBe(false)
  release()
  expect(await first).toBe(true)
})
