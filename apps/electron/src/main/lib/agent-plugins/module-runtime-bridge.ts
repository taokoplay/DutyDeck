import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ModuleRuntimeManager } from './module-runtime-manager'

/** 当前主进程唯一 V3 runtime manager；未安装插件时保持为空。 */
let runtimeManager: ModuleRuntimeManager | undefined

/** IPC 初始化后注入生产 manager；测试或纯任务可恢复为空。 */
export function setModuleRuntimeManager(manager: ModuleRuntimeManager | undefined): void {
  runtimeManager = manager
}

/** 返回当前 manager，供目录与 Surface IPC 复用。 */
export function getModuleRuntimeManager(): ModuleRuntimeManager | undefined {
  return runtimeManager
}

/**
 * 为激活模块构造插件 Agent 工具。
 * 无 manager 或无激活贡献时返回空数组，不扫描插件目录。
 */
export async function buildModuleRuntimeAgentTools(input: {
  sdk: { defineTool(definition: ToolDefinition): ToolDefinition }
  moduleIds: readonly string[]
  sessionId: string
  projectId: string | null
  runId: string
  settingsRevision?: number
  settings?: Record<string, unknown>
  deadline?: number
}): Promise<ToolDefinition[]> {
  if (!runtimeManager || input.moduleIds.length === 0) return []
  return runtimeManager.buildToolsForModules({
    sdk: input.sdk,
    moduleIds: input.moduleIds,
    context: {
      sessionId: input.sessionId,
      projectId: input.projectId,
      runId: input.runId,
      settingsRevision: input.settingsRevision ?? 1,
      settings: structuredClone(input.settings ?? {}),
      deadline: input.deadline ?? Date.now() + 10 * 60_000,
    },
  })
}
