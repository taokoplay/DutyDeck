import { describe, expect, test } from 'bun:test'
import { createPluginStateApi } from '../src/runtime-state.js'

describe('Given SDK 私有状态 API', () => {
  test('When 旧 read(key) 和显式 schema 读取 Then 提交 schema 并解开 value 封套', async () => {
    const observed: unknown[] = []
    const state = createPluginStateApi({ request: async <T>(_capability: string, input: unknown): Promise<T> => {
      observed.push(input)
      return { schemaVersion: (input as { schemaVersion: number }).schemaVersion, revision: 2, value: 'content' } as T
    } })
    expect(await state.read('key')).toBe('content')
    expect(await state.read('key', { schemaVersion: 3 })).toBe('content')
    expect(observed).toEqual([{ key: 'key', schemaVersion: 1 }, { key: 'key', schemaVersion: 3 }])
  })
  test('When 状态缺失或封套错误 Then 返回 null 或稳定错误', async () => {
    const missing = createPluginStateApi({ request: async <T>() => null as T })
    expect(await missing.read('missing')).toBeNull()
    const wrong = createPluginStateApi({ request: async <T>() => ({ schemaVersion: 2, revision: 1, value: 'bad' }) as T })
    await expect(wrong.read('key')).rejects.toThrow('PLUGIN_STATE_RESULT_INVALID')
  })
})

test('Given 已存在状态 When 新实例读取记录后 CAS 更新 Then 使用宿主 revision 而非猜测', async () => {
  const state = createPluginStateApi({ request: async <T>(capability: string, input: unknown): Promise<T> => {
    if (capability === 'plugin.state.read') return { schemaVersion: 1, revision: 7, value: { count: 2 } } as T
    expect(input).toMatchObject({ expectedRevision: 7 })
    return { revision: 8 } as T
  } })
  const record = await state.readRecord<{ count: number }>('counter')
  expect(record?.revision).toBe(7)
  expect(await state.write('counter', { count: record!.value.count + 1 }, { schemaVersion: 1, expectedRevision: record!.revision })).toEqual({ revision: 8 })
})

test('Given 新状态没有 revision When 传入可选 undefined revision Then SDK 省略该字段保持严格 JSON 合同', async () => {
  const state = createPluginStateApi({ request: async <T>(_capability: string, input: unknown): Promise<T> => {
    expect(Object.hasOwn(input as object, 'expectedRevision')).toBe(false)
    return { revision: 1 } as T
  } })
  await state.write('counter', 1, { schemaVersion: 1, expectedRevision: undefined })
})
