import { describe, expect, test } from 'bun:test'
import { createDshRegistrationScope } from './supported-contract'

const definition = () => ({ name: 'calc', description: '自有fixture', parameters: {}, output: { schema: { type: 'number' }, render: () => [{ type: 'text', text: '1' }] }, execute: async () => 1 })
describe('Given 只提供tools.register的固定工具合同', () => {
  test('When 注册、调用与释放 Then 使用宿主命名空间，停止后拒绝且不残留handler', async () => {
    const scope = createDshRegistrationScope('fixture.calc', ['tools'])
    const unregister = scope.context.tools.register(definition())
    expect(scope.list().map(tool => ({ name: tool.name, upstreamName: tool.upstreamName }))).toEqual([{ name: 'plugin_fixture_calc_calc', upstreamName: 'calc' }])
    const tool = scope.list()[0]!
    expect(await tool.invoke({}, { signal: new AbortController().signal, deadline: Date.now() + 1000 })).toEqual({ canonical: 1, content: [{ type: 'text', text: '1' }] })
    unregister(); unregister()
    expect(scope.list()).toEqual([])
    await expect(tool.invoke({}, { signal: new AbortController().signal, deadline: Date.now() + 1000 })).rejects.toThrow('DSH_TOOL_DISPOSED')
    scope.context.tools.register(definition()); scope.dispose(); scope.dispose()
    expect(scope.list()).toEqual([])
    expect(() => scope.context.tools.register(definition())).toThrow('DSH_TOOL_DISPOSED')
  })
  test('When 缺服务、重复名或截断后冲突 Then 失败关闭，不覆盖现有工具', () => {
    for (const services of [['tools', 'session'], ['tools', 'systemPrompt'], ['tools', 'client'], []]) expect(() => createDshRegistrationScope('fixture.calc', services)).toThrow('DSH_SERVICE_UNSUPPORTED')
    const scope = createDshRegistrationScope('fixture.calc', ['tools'])
    scope.context.tools.register(definition())
    expect(() => scope.context.tools.register(definition())).toThrow('DSH_TOOL_NAME_CONFLICT')
    expect(scope.list()).toHaveLength(1)
    const long = createDshRegistrationScope('fixture.' + 'a'.repeat(54), ['tools'])
    long.context.tools.register({ ...definition(), name: 'one' })
    expect(() => long.context.tools.register({ ...definition(), name: 'two' })).toThrow('DSH_TOOL_NAME_CONFLICT')
    expect(() => createDshRegistrationScope('not_a_plugin', ['tools'])).toThrow('DSH_PLUGIN_ID_INVALID')
  })
  test('When adapter已完成但scope尚未接纳时释放 Then 外层仍拒绝成功', async () => {
    const scope = createDshRegistrationScope('fixture.calc', ['tools'])
    scope.context.tools.register({ ...definition(), execute: () => 1 })
    const pending = scope.list()[0]!.invoke({}, { signal: new AbortController().signal, deadline: Date.now() + 1000 })
    queueMicrotask(() => queueMicrotask(() => scope.dispose()))
    await expect(pending).rejects.toThrow('DSH_TOOL_CANCELLED')
    expect(scope.list()).toEqual([])
  })
  test('When scope释放或独立实例调用 Then 在途迟到结果拒绝，另一实例不受影响', async () => {
    let finish: (value: unknown) => void = () => { throw new Error('not started') }
    const a = createDshRegistrationScope('fixture.calc', ['tools']); const b = createDshRegistrationScope('fixture.calc', ['tools'])
    a.context.tools.register({ ...definition(), execute: async () => await new Promise(resolve => { finish = resolve }) })
    b.context.tools.register(definition())
    const context = { signal: new AbortController().signal, deadline: Date.now() + 1000 }
    const pending = a.list()[0]!.invoke({}, context)
    a.dispose(); finish(1)
    await expect(pending).rejects.toThrow('DSH_TOOL_CANCELLED')
    expect((await b.list()[0]!.invoke({}, context)).canonical).toBe(1)
  })
})
