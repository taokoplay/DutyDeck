import type { PluginJsonSchema } from '@dutydeck/plugin-sdk'
import { adaptDshParameters, adaptDshValueSchema, validateDshValue } from './tool-schema-adapter'

export interface DshCallContext { signal: AbortSignal; deadline: number }
export interface DshToolResult { canonical: unknown; content: Array<{ type: 'text'; text: string }> }
export interface DshToolAdapter {
  name: string
  description: string
  inputSchema: PluginJsonSchema
  invoke(input: unknown, context: DshCallContext): Promise<DshToolResult>
}

/** 只检查已审查模块的普通声明，不提供动态getter/完整DSH对象协议。 */
function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('DSH_TOOL_UNSUPPORTED')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.includes(key) || !descriptors[key]!.enumerable || !Object.hasOwn(descriptors[key]!, 'value')) throw new Error('DSH_TOOL_UNSUPPORTED')
  }
  return value as Record<string, unknown>
}
/** 只在有界纯JSON快照上递归，冻结执行输入与规范输出以保持投影一致。 */
function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child)
    Object.freeze(value)
  }
  return value
}
function assertCurrent(context: DshCallContext): void {
  if (context.signal.aborted) throw new Error('DSH_TOOL_CANCELLED')
  if (!Number.isFinite(context.deadline) || context.deadline <= Date.now()) throw new Error('DSH_TOOL_DEADLINE')
}

/** 等待只限制结果接纳；不能中断同步Node代码，进程硬超时仍由原Supervisor负责。 */
function waitForResult(effect: () => unknown, context: DshCallContext): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const abort = (): void => settle(false, new Error('DSH_TOOL_CANCELLED'))
    let settled = false
    const timer = setTimeout(() => settle(false, new Error('DSH_TOOL_DEADLINE')), Math.max(1, context.deadline - Date.now()))
    function settle(ok: boolean, value: unknown): void {
      if (settled) return
      settled = true; clearTimeout(timer); context.signal.removeEventListener('abort', abort)
      if (ok) resolve(value); else reject(value)
    }
    context.signal.addEventListener('abort', abort, { once: true })
    // preflight错误来自宿主检查；与工具体异常分开，避免将到期误报为业务失败。
    try { assertCurrent(context) } catch (error) { settle(false, error); return }
    try {
      Promise.resolve(effect()).then(value => settle(true, value), () => settle(false, new Error('DSH_TOOL_EXECUTION_FAILED')))
    } catch { settle(false, new Error(context.signal.aborted ? 'DSH_TOOL_CANCELLED' : 'DSH_TOOL_EXECUTION_FAILED')) }
  })
}

/**
 * 仅供固定hash、入口和依赖已审查的纯工具配方调用；本函数不是运行任意DSH代码的准入检查。
 * 不传DSH agent/session/scope/policy，不支持动态presenter或finalizeContent；render仅允许已审查文本投影。
 */
export function createDshToolAdapter(definition: unknown): DshToolAdapter {
  const value = fields(definition, ['name', 'description', 'parameters', 'output', 'execute', 'timeoutMs'])
  const output = fields(value.output, ['schema', 'render'])
  if (typeof value.name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value.name)
    || typeof value.description !== 'string' || !value.description || value.description.length > 4096
    || typeof value.execute !== 'function' || typeof output.render !== 'function'
    || (value.timeoutMs !== undefined && (typeof value.timeoutMs !== 'number' || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 900000))) throw new Error('DSH_TOOL_UNSUPPORTED')
  const inputSchema = adaptDshParameters(value.parameters)
  const outputSchema = adaptDshValueSchema(output.schema)
  const execute = value.execute as (args: Record<string, unknown>) => unknown
  const render = output.render as (args: Record<string, unknown>, canonical: unknown) => unknown
  const timeoutMs = typeof value.timeoutMs === 'number' ? value.timeoutMs : 30000
  return {
    name: value.name, description: value.description,
    inputSchema: JSON.parse(JSON.stringify(inputSchema)) as PluginJsonSchema,
    async invoke(input, caller) {
      const context = { signal: caller.signal, deadline: Math.min(caller.deadline, Date.now() + timeoutMs) }
      assertCurrent(context)
      if (validateDshValue(inputSchema, input).length) throw new Error('DSH_TOOL_INPUT_INVALID')
      const args = freezeJson(JSON.parse(JSON.stringify(input)) as Record<string, unknown>)
      const raw = await waitForResult(() => execute(args), context)
      assertCurrent(context)
      if (validateDshValue(outputSchema, raw).length) throw new Error('DSH_TOOL_OUTPUT_INVALID')
      const canonical: unknown = freezeJson(JSON.parse(JSON.stringify(raw)))
      let content: unknown
      try { content = render(args, canonical) } catch { throw new Error('DSH_TOOL_RENDER_FAILED') }
      // 收束域仅为同realm、未装饰的原生Promise；不支持subclass/动态constructor/species。
      // 两个分支都丢弃值，避免清理子Promise再次求值后来添加的thenable协议。
      // 这不支持异步render，也不是阻止恶意JS创建未处理拒绝的沙箱。
      if (content instanceof Promise) {
        if (Object.getPrototypeOf(content) === Promise.prototype && Reflect.ownKeys(content).length === 0) {
          try { Promise.prototype.then.call(content, () => undefined, () => undefined) }
          catch { throw new Error('DSH_TOOL_RENDER_UNSUPPORTED') }
        }
        throw new Error('DSH_TOOL_RENDER_UNSUPPORTED')
      }
      assertCurrent(context)
      if (validateDshValue({}, content).length || !Array.isArray(content) || content.length > 32
        || content.some(block => !block || typeof block !== 'object' || Array.isArray(block)
          || Object.keys(block).some(key => key !== 'type' && key !== 'text') || block.type !== 'text' || typeof block.text !== 'string')) throw new Error('DSH_TOOL_RENDER_UNSUPPORTED')
      const result = { canonical, content }
      // 完整包装也必须满足宿主RPC预算；不能只分别检查canonical与render。
      if (validateDshValue({}, result).length) throw new Error('DSH_TOOL_OUTPUT_INVALID')
      const snapshot = JSON.parse(JSON.stringify(result)) as DshToolResult
      assertCurrent(context)
      return snapshot
    },
  }
}
