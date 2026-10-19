/**
 * 独立进程装配回归：bun run apps/electron/scripts/agent-media-selection-smoke.ts
 * mock.module 仅存在于该脚本进程；不作为 bun test 文件加载，避免污染全仓模块缓存。
 * 真实执行 prepareAgentRun 与媒体工具 Provider，所有生命周期、持久化及生成出口均隔离。
 */
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import type { AgentSendInput, AgentSessionMeta } from '@dutydeck/shared'
import type { CanvasToolRunContext } from '../src/main/lib/design/canvas-tool-provider'
import { createMediaToolRun, type MediaToolProviderDependencies } from '../src/main/lib/media/media-tool-provider'
import { isEligibleProjectAgent } from '../src/main/lib/agent-session-visibility'

/** 禁止准备流程访问真实存储、生成服务或未声明的运行生命周期。 */
function forbidden(): never { throw new Error('离线装配测试禁止调用外部能力') }
/** 生命周期构造占位；prepareAgentRun 不应启动 Agent。 */
class InertRuntime { use(): void {} }
/** 按主进程绝对路径注册隔离替身，参数为模块相对路径及导出对象。 */
function isolate(path: string, exports: Record<string, unknown>): void {
  mock.module(resolve(import.meta.dir, '../src/main/lib', path), () => exports)
}
/** 当前用例的权威会话，完全保存在内存。 */
let session: AgentSessionMeta
/** 捕获生产装配函数传给 runtime 的权威参数。 */
const contexts: CanvasToolRunContext[] = []
/** 所有非本轮测试的媒体操作立即失败；构造工具无需读取业务配置。 */
const mediaDependencies: MediaToolProviderDependencies = {
  configuration: { listProject: forbidden, read: forbidden, getWorkflow: forbidden, saveWorkflow: forbidden,
    cacheRemoteWorkflow: forbidden, saveProfile: forbidden, resolveProfile: forbidden },
  resources: { list: forbidden, getSchema: forbidden, readWorkflow: forbidden, readRemoteAsset: forbidden },
  runs: { prepare: forbidden, get: forbidden, getOrigin: forbidden, cancel: forbidden },
  supervisor: { start: forbidden, watch: forbidden, wait: forbidden },
  authorize: forbidden, listAssets: forbidden, registerRemoteAsset: forbidden, listModels: forbidden,
  generation: { listModels: forbidden, prepare: forbidden, execute: forbidden, get: forbidden, wait: forbidden, cancel: forbidden },
}
mock.module('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
isolate('adapters/pi-agent-adapter', { PiAgentAdapter: InertRuntime })
isolate('adapters/pi-utility-adapter', { PiUtilityAdapter: InertRuntime })
isolate('agent-orchestrator', { AgentOrchestrator: InertRuntime })
isolate('agent-event-bus', { AgentEventBus: InertRuntime })
isolate('agent-queue-coordinator', { AgentQueueCoordinator: InertRuntime })
isolate('agent-session-manager', { getAgentSessionMeta: () => session, isAgentSessionDeleting: () => false,
  markAgentSessionDeleting: forbidden, listAgentSessions: forbidden, updateAgentSessionMeta: forbidden })
isolate('agent-workspace-manager', { getAgentWorkspace: forbidden, getAgentWorkspaceBySlug: forbidden,
  getLocalProjectRootStatus: forbidden, getProjectFilesPath: forbidden, getWorkspaceAttachedDirectories: forbidden,
  getWorkspaceAttachedFiles: forbidden })
isolate('config-paths', { getAgentSessionWorkspacePath: forbidden })
isolate('project-knowledge-runtime', { getProjectKnowledgeService: forbidden })
isolate('workspace-operation-lock', { getWorkspaceOperationBlockReason: forbidden, acquireWorkspaceWriteLease: forbidden })
isolate('agent-run-lifecycle', { runAgentServiceTerminalEffects: forbidden })
isolate('agent-collaboration-tools', { registerCollaborationEventBus: () => {} })
isolate('visual-production/integration', { createProductionVisualProductionAccess: forbidden })
isolate('design/design-session-bridge', { openAuthorizedAgentMediaSource: forbidden })
isolate('agent-media-attachment-preparation', { prepareAgentMediaAttachmentsForSend: forbidden })
isolate('design/canvas-document-ipc', { getCanvasToolProviderRuntime: () => ({
  referenceResolver: { resolveForSend: forbidden },
  createRun: (context: CanvasToolRunContext) => {
    contexts.push(context)
    return createMediaToolRun(mediaDependencies, context)
  },
}) })
/** 导入生产入口而不是重写其分支逻辑。 */
const { prepareAgentRun } = await import('../src/main/lib/agent-service')
/** 每个场景从独立的权威普通会话开始，输入只影响当前轮次。 */
async function prepare(input: Partial<AgentSendInput> = {}, metadata: Partial<AgentSessionMeta> = {}) {
  session = { id: 'session-local', title: '离线回归', workspaceId: 'project-local', createdAt: 1, updatedAt: 1, ...metadata }
  contexts.length = 0
  return prepareAgentRun({ sessionId: session.id, channelId: 'offline', userMessage: '生成图片', startedAt: 123,
    mentionedMediaModelRefs: ['media:image:openai:offline:gpt-image-2'], ...input }, {}, 42)
}
/** 检查仅媒体能力进入生产准备结果，并验证权限上下文未丢失。 */
const selected = await prepare()
assert.equal(contexts.length, 1)
assert.deepEqual(contexts[0], { mediaOnly: true, projectId: 'project-local', sessionId: 'session-local',
  runStartedAt: 123, explicitReferences: [], permissionCeiling: 'execute', dialogOwnerWebContentsId: 42 })
/** Provider 实际产生的工具名，用来防止空扩展或专业模块权限泄漏。 */
const names = selected.extensions.piCustomTools?.map(tool => tool.name) ?? []
assert(names.includes('media_prepare_generation'))
assert(names.includes('media_execute_generation'))
assert(selected.extensions.allowedToolNames?.includes('media_prepare_generation'))
assert(selected.extensions.allowedToolNames?.includes('media_execute_generation'))
assert(selected.extensions.toolApprovalPolicy, '媒体审批策略必须随工具传入运行')
assert(!names.some(name => name.startsWith('canvas_') || name.startsWith('visual_production_')))
for (const refs of [undefined, [], ['invalid-model-ref']]) {
  await prepare({ mentionedMediaModelRefs: refs })
  assert.equal(contexts.length, 0, '无选择或无效引用不能开启工具')
}
await prepare({}, { explorationParentSessionId: 'parent-local' })
assert.equal(contexts.length, Number(isEligibleProjectAgent(session, 'project-local')), '模型选择不能绕过既有探索分支准入规则')
for (const metadata of [{ workspaceId: undefined }, { archived: true }, { sourceAutomationId: 'automation' },
  { parentSessionId: 'parent', sourceDelegationId: 'delegation' }]) {
  await prepare({}, metadata)
  assert.equal(contexts.length, 0, '无项目、归档和内部运行不得扩权')
}
await prepare({ triggeredBy: 'automation' })
assert.equal(contexts.length, 0)
await prepare({ workspaceId: 'renderer-forged-project' })
assert.equal(contexts[0]?.projectId, 'project-local', '不能使用 Renderer 声称的跨项目身份')
/** 计划权限不只透传上下文，也必须改变真实 Provider 暴露的可执行工具。 */
const planned = await prepare({}, { permissionMode: 'plan' })
assert.equal(contexts[0]?.permissionCeiling, 'plan')
assert(!planned.extensions.piCustomTools?.some(tool => tool.name === 'media_execute_generation'), '计划模式不得暴露收费执行工具')
await prepare({ permissionModeOverride: 'plan' })
assert.equal(contexts[0]?.permissionCeiling, 'plan')
await prepare({ mentionedMediaModelRefs: [], moduleIds: ['canvas'] })
assert.equal(contexts[0]?.mediaOnly, false, '显式画布选择仍传递完整模式')
await prepare({ mentionedMediaModelRefs: [], moduleIds: ['visual-production'] })
assert.equal(contexts[0]?.mediaOnly, true, '显式影像选择仍使用媒体模式')
console.log('PASS: prepareAgentRun 真实入口与媒体 Provider 离线装配，全部场景通过')
