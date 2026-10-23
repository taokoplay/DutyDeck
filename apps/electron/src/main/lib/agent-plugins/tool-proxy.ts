import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { RegisteredPluginTool } from './contribution-registry'

/** 构造工具代理所需的宿主运行上下文。 */
export interface PluginToolProxyContext {
  sessionId: string
  projectId: string | null
  runId: string
  settingsRevision: number
  settings: Record<string, unknown>
  deadline: number
}

/** 代理调用依赖；runtime 和 Supervisor 由宿主注入。 */
export interface BuildPluginToolProxiesInput {
  sdk: {
    defineTool(definition: ToolDefinition): ToolDefinition
  }
  contributions: readonly RegisteredPluginTool[]
  context: PluginToolProxyContext
  invokeTool: (input: {
    toolId: string
    input: unknown
    context: {
      moduleId: string
      sessionId: string
      projectId: string | null
      runId: string
      settingsRevision: number
      settings: Record<string, unknown>
      deadline: number
    }
    signal: AbortSignal
  }) => Promise<unknown>
}

/**
 * 将签名 manifest 中的工具声明转换为 Pi 工具闭包。
 * 模型只能提供业务参数，插件、模块、会话和 run 全部来自宿主上下文。
 */
export function buildPluginToolProxies(input: BuildPluginToolProxiesInput): ToolDefinition[] {
  return input.contributions.map((tool) => input.sdk.defineTool({
    name: tool.agentName,
    label: tool.title,
    description: tool.description,
    parameters: tool.inputSchema,
    annotations: {
      readOnlyHint: tool.annotations.readOnly,
      destructiveHint: tool.annotations.destructive,
      idempotentHint: tool.annotations.idempotent,
      openWorldHint: tool.annotations.openWorld,
    },
    executionMode: tool.concurrencyKey ? 'sequential' : 'parallel',
    async execute(_toolCallId, params, signal) {
      const controller = new AbortController()
      const abort = (): void => controller.abort()
      if (signal?.aborted) controller.abort()
      else signal?.addEventListener('abort', abort, { once: true })
      try {
        const result = await input.invokeTool({
          toolId: tool.id,
          input: params,
          context: {
            moduleId: tool.ownerModuleId,
            sessionId: input.context.sessionId,
            projectId: input.context.projectId,
            runId: input.context.runId,
            settingsRevision: input.context.settingsRevision,
            settings: input.context.settings,
            deadline: input.context.deadline,
          },
          signal: controller.signal,
        })
        const text = JSON.stringify(result)
        return {
          content: [{ type: 'text' as const, text }],
          details: result,
        }
      } finally {
        signal?.removeEventListener('abort', abort)
      }
    },
  }))
}
