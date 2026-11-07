import type { AgentSessionModulePolicy } from '@dutydeck/shared'
import type { AgentRunIdentity } from '../agent-run-identity'
import { isPluginModuleAttached, type PluginModuleIdentity } from './plugin-session-access'

interface RunModule extends PluginModuleIdentity { explicit: boolean }
interface BoundRun { identity: AgentRunIdentity; modules: readonly RunModule[] }
const runs = new Map<string, BoundRun>()

/** 执行和提交前核对本轮明确选择与精确包；不把一次性选择写入 Session 长期策略。 */
export function assertPluginRunModule(sessionId: string, runId: string, module: PluginModuleIdentity, policy: AgentSessionModulePolicy): void {
  const run = runs.get(runId)
  if (!run || run.identity.sessionId !== sessionId || policy.disabledModuleIds.includes(module.moduleId)) throw new Error('PLUGIN_CAPABILITY_STALE')
  run.identity.assertActive()
  const selected = run.modules.find(item => item.moduleId === module.moduleId)
  if (!selected || selected.moduleVersion !== module.moduleVersion || selected.packageHash !== module.packageHash
    || !selected.explicit && !isPluginModuleAttached(module, policy)) throw new Error('PLUGIN_CAPABILITY_STALE')
}

/** 准备阶段不伪造运行身份；编排器准入后只能绑定一次真实代次。 */
export function createPluginRunBinding(sessionId: string, modules: readonly RunModule[] = []): {
  bind(identity: AgentRunIdentity): void
  current(): { runId: string; signal: AbortSignal }
} {
  let identity: AgentRunIdentity | undefined
  const snapshot = structuredClone(modules)
  return {
    bind(next) {
      if (identity) throw new Error('PLUGIN_RUN_ALREADY_BOUND')
      if (next.sessionId !== sessionId || !Number.isSafeInteger(next.generation) || next.generation < 1) throw new Error('PLUGIN_RUN_IDENTITY_INVALID')
      next.assertActive()
      const key = `${sessionId}:${next.generation}`
      if (runs.has(key)) throw new Error('PLUGIN_RUN_ALREADY_BOUND')
      identity = next
      const run = { identity: next, modules: snapshot }
      runs.set(key, run)
      next.signal.addEventListener('abort', () => { if (runs.get(key) === run) runs.delete(key) }, { once: true })
    },
    current() {
      if (!identity) throw new Error('PLUGIN_RUN_NOT_BOUND')
      identity.assertActive()
      return { runId: `${sessionId}:${identity.generation}`, signal: identity.signal }
    },
  }
}
