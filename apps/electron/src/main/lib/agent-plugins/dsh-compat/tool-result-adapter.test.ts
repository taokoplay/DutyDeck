import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createDshToolAdapter } from './tool-result-adapter'

function fixture() {
  return { name: 'sample', description: '自有纯计算fixture', parameters: { value: { type: 'number', required: true } }, output: { schema: { type: 'number' }, render: (_args: Record<string, unknown>, value: unknown) => [{ type: 'text', text: String(value) }] }, execute: async (args: Record<string, unknown>) => Number(args.value) * 2 }
}
describe('Given 审查后的纯工具调用适配', () => {
  test('When 合法输入 Then 先校验再执行和文本投影，保留canonical结果', async () => {
    const tool = createDshToolAdapter(fixture())
    expect(tool.inputSchema.required).toEqual(['value'])
    expect(await tool.invoke({ value: 4 }, { signal: new AbortController().signal, deadline: Date.now() + 1000 })).toEqual({ canonical: 8, content: [{ type: 'text', text: '8' }] })
    await expect(tool.invoke({ value: '4' }, { signal: new AbortController().signal, deadline: Date.now() + 1000 })).rejects.toThrow('DSH_TOOL_INPUT_INVALID')
  })
  test('When 错误输出、异常、深UI语义或未知render块 Then 不返回伪成功或泄露原始异常', async () => {
    expect(() => createDshToolAdapter({ ...fixture(), presentResult: () => ({}) })).toThrow('DSH_TOOL_UNSUPPORTED')
    const context = { signal: new AbortController().signal, deadline: Date.now() + 1000 }
    await expect(createDshToolAdapter({ ...fixture(), execute: async () => 'invalid' }).invoke({ value: 1 }, context)).rejects.toThrow('DSH_TOOL_OUTPUT_INVALID')
    await expect(createDshToolAdapter({ ...fixture(), execute: async () => { throw new Error('fixture-sensitive-content') } }).invoke({ value: 1 }, context)).rejects.toThrow('DSH_TOOL_EXECUTION_FAILED')
    await expect(createDshToolAdapter({ ...fixture(), output: { schema: { type: 'number' }, render: () => [{ type: 'image', url: 'https://example.com' }] } }).invoke({ value: 1 }, context)).rejects.toThrow('DSH_TOOL_RENDER_UNSUPPORTED')
    await expect(createDshToolAdapter({ ...fixture(), output: { schema: { type: 'number' }, render: () => [{ type: 'text', text: 'x'.repeat(256 * 1024) }] } }).invoke({ value: 1 }, context)).rejects.toThrow('DSH_TOOL_RENDER_UNSUPPORTED')
  })
  test('When 执行和render读取嵌套值 Then 收到冻结快照，不共享原输入与输出', async () => {
    const original = { value: { n: 1 } }; const raw = { n: 2 }
    let frozenInput = false; let frozenOutput = false
    const tool = createDshToolAdapter({ ...fixture(), parameters: { value: { type: 'json' } }, execute: async (args: Record<string, unknown>) => { frozenInput = Object.isFrozen(args) && Object.isFrozen(args.value); return raw }, output: { schema: { type: 'json' }, render: (_args: Record<string, unknown>, value: unknown) => { frozenOutput = Object.isFrozen(value); return [{ type: 'text', text: JSON.stringify(value) }] } } })
    const result = await tool.invoke(original, { signal: new AbortController().signal, deadline: Date.now() + 1000 })
    expect(frozenInput).toBe(true); expect(frozenOutput).toBe(true)
    expect(Object.isFrozen(original)).toBe(false); expect(Object.isFrozen(raw)).toBe(false)
    raw.n = 3
    expect(result.canonical).toEqual({ n: 2 })
  })
  test('When 异步body不返回 Then 到期有界结束，迟到拒绝无未处理Promise', async () => {
    const tool = createDshToolAdapter({ ...fixture(), execute: async () => await new Promise(() => undefined) })
    await expect(tool.invoke({ value: 1 }, { signal: new AbortController().signal, deadline: Date.now() + 20 })).rejects.toThrow('DSH_TOOL_DEADLINE')
  })
  test('When 同步render返回拒绝Promise Then 拒绝异步语义且不泄漏未处理异常', () => {
    const path = new URL('./tool-result-adapter.ts', import.meta.url).pathname
    const child = spawnSync(process.execPath, ['--eval', `
      import { createDshToolAdapter } from ${JSON.stringify(path)};
      const leaks = []; process.on('unhandledRejection', error => leaks.push(String(error)));
      const tool = createDshToolAdapter({ name:'calc', description:'fixture', parameters:{}, execute:()=>1, output:{ schema:{type:'number'}, render:()=>Promise.reject(new Error('OWN_SECRET')) } });
      let code; try { await tool.invoke({}, {signal:new AbortController().signal,deadline:Date.now()+1000}); } catch (e) { code = e.message; }
      await new Promise(resolve => setTimeout(resolve,10)); console.log(JSON.stringify({code,leaks}));
    `], { encoding: 'utf8', timeout: 5000 })
    expect(child.status).toBe(0)
    expect(JSON.parse(child.stdout.trim())).toEqual({ code: 'DSH_TOOL_RENDER_UNSUPPORTED', leaks: [] })
  })
  test('When render返回原生Promise且成功值随后变为thenable Then 收束不透传值或调用then', () => {
    const path = new URL('./tool-result-adapter.ts', import.meta.url).pathname
    const child = spawnSync(process.execPath, ['--eval', `
      import { createDshToolAdapter } from ${JSON.stringify(path)};
      const leaks = []; process.on('unhandledRejection', error => leaks.push(String(error)));
      const payload = {}; const native = Promise.resolve(payload); let thenCalls = 0;
      payload.then = (_resolve, reject) => { thenCalls++; reject(new Error('OWN_CLEANUP_CHILD_REJECTION')); };
      const tool = createDshToolAdapter({ name:'calc', description:'fixture', parameters:{}, execute:()=>1, output:{ schema:{type:'number'}, render:()=>native } });
      let code; try { await tool.invoke({}, {signal:new AbortController().signal,deadline:Date.now()+1000}); } catch (e) { code = e.message; }
      await new Promise(resolve => setTimeout(resolve,10)); console.log(JSON.stringify({code,thenCalls,leaks}));
    `], { encoding: 'utf8', timeout: 5000 })
    expect(child.status).toBe(0)
    expect(JSON.parse(child.stdout.trim())).toEqual({ code: 'DSH_TOOL_RENDER_UNSUPPORTED', thenCalls: 0, leaks: [] })
  })
  test('When 输入快照后到期 Then 不执行body且保留deadline分类', async () => {
    const now = Date.now; let reads = 0; let executed = 0
    Date.now = () => ++reads <= 2 ? 1000 : 1100
    try {
      const tool = createDshToolAdapter({ ...fixture(), execute: () => { executed++; return 1 } })
      await expect(tool.invoke({ value: 1 }, { signal: new AbortController().signal, deadline: 1050 })).rejects.toThrow('DSH_TOOL_DEADLINE')
      expect(executed).toBe(0)
    } finally { Date.now = now }
  })
  test('When 已取消、执行中取消或超过deadline Then 迟到结果不成功且不调用render', async () => {
    const controller = new AbortController(); let calls = 0; let renders = 0
    let finish: (value: unknown) => void = () => { throw new Error('not started') }
    const tool = createDshToolAdapter({ ...fixture(), execute: async () => { calls++; return await new Promise(resolve => { finish = resolve }) }, output: { schema: { type: 'number' }, render: () => { renders++; return [{ type: 'text', text: 'result' }] } } })
    const pending = tool.invoke({ value: 1 }, { signal: controller.signal, deadline: Date.now() + 1000 })
    controller.abort(); finish(2)
    await expect(pending).rejects.toThrow('DSH_TOOL_CANCELLED')
    expect(renders).toBe(0)
    await expect(tool.invoke({ value: 1 }, { signal: controller.signal, deadline: Date.now() + 1000 })).rejects.toThrow('DSH_TOOL_CANCELLED')
    await expect(tool.invoke({ value: 1 }, { signal: new AbortController().signal, deadline: Date.now() - 1 })).rejects.toThrow('DSH_TOOL_DEADLINE')
    expect(calls).toBe(1)
  })
})
