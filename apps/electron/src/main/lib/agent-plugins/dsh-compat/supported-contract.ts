import { pluginAgentToolName } from '@dutydeck/plugin-sdk'
import type { DshCallContext, DshToolResult, DshToolAdapter } from './tool-result-adapter'
import { createDshToolAdapter } from './tool-result-adapter'

export const DSH_SUPPORTED_CONTRACT_VERSION = '0.1.0' as const
export interface RegisteredDshTool extends Omit<DshToolAdapter, 'name'> {
  name: string
  upstreamName: string
}
export interface DshRegistrationScope {
  context: { tools: { register(value: unknown): () => void } }
  list(): RegisteredDshTool[]
  dispose(): void
}

/**
 * 不实现Cordis容器，只提供已审查纯工具入口所需的注册和释放。
 * 工具名称由SDK命名空间生成；本scope不替代manifest比对、grant、Pi审批或Supervisor。
 */
export function createDshRegistrationScope(pluginId: string, inject: readonly string[]): DshRegistrationScope {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(pluginId) || pluginId.length > 129) throw new Error('DSH_PLUGIN_ID_INVALID')
  if (inject.length !== 1 || inject[0] !== 'tools') throw new Error('DSH_SERVICE_UNSUPPORTED')
  const entries = new Map<string, RegisteredDshTool>()
  const releases = new Set<() => void>()
  let disposed = false
  function register(value: unknown): () => void {
    if (disposed) throw new Error('DSH_TOOL_DISPOSED')
    if (entries.size >= 128) throw new Error('DSH_TOOL_LIMIT')
    const adapter = createDshToolAdapter(value)
    const name = pluginAgentToolName(pluginId, adapter.name)
    if (entries.has(name)) throw new Error('DSH_TOOL_NAME_CONFLICT')
    const controller = new AbortController()
    let released = false
    const tool: RegisteredDshTool = {
      name, upstreamName: adapter.name, description: adapter.description, inputSchema: adapter.inputSchema,
      async invoke(input: unknown, context: DshCallContext): Promise<DshToolResult> {
        if (released || disposed) throw new Error('DSH_TOOL_DISPOSED')
        const call = new AbortController()
        const abort = (): void => call.abort()
        controller.signal.addEventListener('abort', abort, { once: true })
        context.signal.addEventListener('abort', abort, { once: true })
        if (controller.signal.aborted || context.signal.aborted) call.abort()
        try {
          const result = await adapter.invoke(input, { signal: call.signal, deadline: context.deadline })
          // adapter完成与scope接纳之间仍可释放；每个异步权威边界各自复核。
          if (released || disposed || call.signal.aborted) throw new Error('DSH_TOOL_CANCELLED')
          if (!Number.isFinite(context.deadline) || context.deadline <= Date.now()) throw new Error('DSH_TOOL_DEADLINE')
          return result
        }
        finally { controller.signal.removeEventListener('abort', abort); context.signal.removeEventListener('abort', abort) }
      },
    }
    const release = (): void => {
      if (released) return
      released = true; controller.abort(); entries.delete(name); releases.delete(release)
    }
    entries.set(name, tool); releases.add(release)
    return release
  }
  return {
    context: Object.freeze({ tools: Object.freeze({ register }) }),
    list: () => [...entries.values()],
    dispose() { disposed = true; for (const release of [...releases]) release() },
  }
}
