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
import { registerMediaToolProviderRuntime } from '../src/main/lib/media/media-tool-runtime'
import { getInactiveModuleSkillSlugs } from '../src/main/lib/agent-modules/module-skill-resolver'
import { createAgentModuleToolPolicy } from '../src/main/lib/agent-modules/module-tool-policy'
import type { AgentRunExtensions } from '../src/main/lib/agent-run-extensions'

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
  getWorkspaceSkills: forbidden,
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
/** 共享媒体入口独立注册；Canvas 仅提供自己的专业入口。 */
const disposeMedia = registerMediaToolProviderRuntime({ createRun: (context) => {
  contexts.push(context)
  return createMediaToolRun(mediaDependencies, context)
} })
/** 导入生产入口而不是重写其分支逻辑。 */
const { prepareAgentRun } = await import('../src/main/lib/agent-service')
/** 每个场景从独立的权威普通会话开始，输入只影响当前轮次。 */
async function prepare(input: Partial<AgentSendInput> = {}, metadata: Partial<AgentSessionMeta> = {}, extensions: AgentRunExtensions = {}) {
  session = { id: 'session-local', title: '离线回归', workspaceId: 'project-local', createdAt: 1, updatedAt: 1, ...metadata }
  contexts.length = 0
  return prepareAgentRun({ sessionId: session.id, channelId: 'offline', userMessage: '生成图片', startedAt: 123,
    mentionedMediaModelRefs: ['media:image:openai:offline:gpt-image-2'], ...input }, extensions, 42)
}
/** 检查仅媒体能力进入生产准备结果，并验证权限上下文未丢失。 */
const selected = await prepare()
assert.equal(contexts.length, 1)
assert.deepEqual(contexts[0], { mediaOnly: true, mediaToolScope: 'standalone', projectId: 'project-local', sessionId: 'session-local',
  runStartedAt: 123, explicitReferences: [], permissionCeiling: 'execute', dialogOwnerWebContentsId: 42 })
/** Provider 实际产生的工具名，用来防止空扩展或专业模块权限泄漏。 */
const names = selected.extensions.piCustomTools?.map(tool => tool.name) ?? []
assert(names.includes('media_prepare_generation'))
assert(names.includes('media_execute_generation'))
assert(selected.extensions.allowedToolNames?.includes('media_prepare_generation'))
assert(selected.extensions.allowedToolNames?.includes('media_execute_generation'))
assert(selected.extensions.toolApprovalPolicy, '媒体审批策略必须随工具传入运行')
assert(names.includes('media_discover_workflows'), '普通对话应装配受管 ComfyUI 工作流链')
assert(!names.includes('media_publish_workflow'), '普通对话不开放旧公共发布入口')
assert(!names.some(name => name.startsWith('canvas_') || name.startsWith('visual_production_')))
/** 模拟生产 Orchestrator 使用实际工具精确签发，不能只验证 prepare 中看得见。 */
const ordinaryPolicy = createAgentModuleToolPolicy({ activeModuleIds: [], toolMode: 'standard', trustedToolNames: names })
for (const name of names) assert.equal(ordinaryPolicy.denyTool(name), undefined)
for (const name of ['canvas_read', 'visual_production_begin_job', 'media_publish_workflow', 'media_save_profile']) {
  assert.equal(ordinaryPolicy.denyTool(name)?.behavior, 'deny')
}
assert.equal(ordinaryPolicy.hasModule('canvas'), false)
assert.equal(ordinaryPolicy.hasModule('visual-production'), false)
/** Given 自然语言请求且未选模块 When 真实准备运行 Then 媒体 Skill 可发现且其它模块仍隐藏。 */
for (const userMessage of [
  '帮我画一张科技风封面', '把这张图片做成视频', '给这段文字配音', '有哪些图片模型？',
  '用 GPT 生成一张蓝色纸船的图片', '用 gpt-image-2 生成一张方形蓝色纸船插画',
  '用 gpt-image-2.5-flare 生成一张蓝色纸船插画', '用 gpt-image-2.5-sunburst 生成一张蓝色纸船插画',
  '用 ComfyUI 生成一张蓝色纸船的图片', '用即梦 5.0 生成一张蓝色纸船插画',
  '只帮我写 GPT 生图提示词，不要生成', '比较 GPT 和 ComfyUI 生图，不要执行',
]) {
  for (const refs of [undefined, [], ['invalid-model-ref']]) {
    const natural = await prepare({ userMessage, mentionedMediaModelRefs: refs })
    assert.equal(contexts.length, 1, '无选择或无效引用仍保留普通对话媒体入口')
    assert.deepEqual(natural.extensions.explicitSkillSlugs, ['media-models', 'comfyui-workflows'], '宿主媒体入口应提供可自然发现的媒体 Skill')
    const excluded = getInactiveModuleSkillSlugs([], undefined, natural.extensions.explicitSkillSlugs)
    assert(!excluded.includes('media-models'))
    assert(!excluded.includes('comfyui-workflows'))
    assert(excluded.includes('canvas-production'))
    assert(excluded.includes('interaction-design'))
    assert.equal(natural.input.mentionedSkills, undefined, '自然发现不能伪造用户显式 Skill 选择或强制加载正文')
  }
}
/** 普通及专业会话共享工作流链；不因提及 ComfyUI 就开启专业管理工具。 */
for (const moduleIds of [[], ['canvas'], ['visual-production']]) {
  const comfy = await prepare({ userMessage: '用 ComfyUI 生成一张蓝色纸船的图片', mentionedMediaModelRefs: [], moduleIds })
  const tools = comfy.extensions.piCustomTools?.map(tool => tool.name) ?? []
  assert.equal(tools.includes('media_discover_workflows'), true)
  assert.equal(tools.includes('media_prepare_run'), true)
  assert.equal(tools.includes('media_execute_run'), true)
  assert(tools.includes('media_prepare_generation'), '专业流程仍可使用统一 API 生图入口')
}
/** 本段只验证宿主暴露能力，不把消息文本循环当作 LLM 自动触发或禁止生成的证据。 */
console.log('PASS: GPT、ComfyUI、即梦及非生成请求的宿主装配矩阵（非 LLM 触发评测）')
/** 宿主既有签发项须去重保留；普通消息中的 Skill 名不能升级成宿主授权。 */
const merged = await prepare({}, {}, { explicitSkillSlugs: ['notes', 'media-models', 'comfyui-workflows'] })
assert.deepEqual(merged.extensions.explicitSkillSlugs, ['notes', 'media-models', 'comfyui-workflows'])
const mentioned = await prepare({ mentionedSkills: ['canvas-production'] })
assert.deepEqual(mentioned.extensions.explicitSkillSlugs, ['media-models', 'comfyui-workflows'])
const skillsDisabled = await prepare({}, {}, { skillsMode: 'disabled' })
assert.equal(skillsDisabled.extensions.skillsMode, 'disabled', '媒体入口不能重新开启禁用的 Skills')
await prepare({}, { explorationParentSessionId: 'parent-local' })
assert.equal(contexts.length, Number(isEligibleProjectAgent(session, 'project-local')), '模型选择不能绕过既有探索分支准入规则')
for (const metadata of [{ archived: true }, { sourceAutomationId: 'automation' },
  { parentSessionId: 'parent', sourceDelegationId: 'delegation' }]) {
  const restricted = await prepare({}, metadata)
  assert.equal(contexts.length, 0, '归档和内部运行不得扩权')
  assert.equal(restricted.extensions.explicitSkillSlugs, undefined, '内部运行不得额外发现媒体 Skill')
}
for (const triggeredBy of ['automation', 'external', 'delegation'] as const) {
  const restricted = await prepare({ triggeredBy })
  assert.equal(contexts.length, 0)
  assert.equal(restricted.extensions.explicitSkillSlugs, undefined)
}
await prepare({ workspaceId: 'renderer-forged-project' })
assert.equal(contexts[0]?.projectId, 'project-local', '不能使用 Renderer 声称的跨项目身份')
/** 计划权限不只透传上下文，也必须改变真实 Provider 暴露的可执行工具。 */
const planned = await prepare({}, { permissionMode: 'plan' })
assert.equal(contexts[0]?.permissionCeiling, 'plan')
assert.deepEqual(planned.extensions.explicitSkillSlugs, ['media-models', 'comfyui-workflows'], '计划模式可发现媒体 Skill，但不能执行生成')
assert(!planned.extensions.piCustomTools?.some(tool => tool.name === 'media_execute_generation'), '计划模式不得暴露收费执行工具')
for (const name of ['media_execute_run', 'media_cancel_run', 'media_save_local_workflow', 'media_import_assets', 'media_import_remote_asset']) {
  assert(!planned.extensions.piCustomTools?.some(tool => tool.name === name), `计划模式不得暴露 ${name}`)
}
assert(planned.extensions.piCustomTools?.some(tool => tool.name === 'media_discover_workflows'))
for (const name of ['media_list_models', 'media_list_workflows', 'media_discover_workflows', 'media_list_resources', 'media_read_remote_workflow', 'media_get_node_schema', 'media_inspect_workflow']) {
  assert(planned.extensions.readOnlyToolNames?.includes(name), `计划模式须将 ${name} 作为真实只读工具传给通用权限层`)
}
for (const name of ['media_use_remote_workflow', 'media_prepare_run', 'media_save_local_workflow', 'media_execute_run']) {
  assert(!planned.extensions.readOnlyToolNames?.includes(name), `${name} 不能冒充只读工具`)
}
await prepare({ permissionModeOverride: 'plan' })
assert.equal(contexts[0]?.permissionCeiling, 'plan')
await prepare({ mentionedMediaModelRefs: [], moduleIds: ['canvas'] })
assert.equal(contexts[0]?.mediaOnly, false, '显式画布选择仍传递完整模式')
await prepare({ mentionedMediaModelRefs: [], moduleIds: ['visual-production'] })
assert.equal(contexts[0]?.mediaOnly, true, '显式影像选择仍使用媒体模式')
assert.equal(contexts[0]?.mediaToolScope, undefined, '影像保留专业媒体工具')
/** 无项目对话收到可操作诊断，不能进入实际服务。 */
const unbound = await prepare({}, { workspaceId: undefined })
assert.equal(contexts.length, 0)
assert.deepEqual(unbound.extensions.allowedToolNames, ['media_list_models'])
assert(unbound.extensions.systemPromptAppend?.includes('选择项目'))
assert.deepEqual(unbound.extensions.explicitSkillSlugs, ['media-models'], '诊断入口保留使用说明，但不添加执行工具')
/** 独立媒体服务未就绪不能悄悄借用Canvas运行或声称密钥无效。 */
disposeMedia()
const unavailable = await prepare()
assert.equal(contexts.length, 0)
assert.deepEqual(unavailable.extensions.allowedToolNames, ['media_list_models'])
assert(unavailable.extensions.systemPromptAppend?.includes('尚未就绪'))
assert.deepEqual(unavailable.extensions.explicitSkillSlugs, ['media-models'])
/** 没有媒体目录工具的旧 runtime 不得仅凭会话来源开放媒体 Skill。 */
const disposeEmpty = registerMediaToolProviderRuntime({ createRun: () => ({
  piCustomTools: [], allowedToolNames: [], singleApprovalToolNames: [],
}) })
const emptyRuntime = await prepare()
assert.equal(emptyRuntime.extensions.explicitSkillSlugs, undefined)
disposeEmpty()
/** Skill 可见性须同时有真实注册和允许调用，不能从工具名称或 allowed 单方面推断。 */
for (const registered of [true, false]) {
  const workflowTool = createMediaToolRun(mediaDependencies, { projectId: 'project-local', sessionId: 'session-local',
    runStartedAt: 123, explicitReferences: [], permissionCeiling: 'execute' }).piCustomTools.find(tool => tool.name === 'media_discover_workflows')!
  const disposePartial = registerMediaToolProviderRuntime({ createRun: () => ({
    piCustomTools: registered ? [workflowTool] : [], allowedToolNames: registered ? [] : [workflowTool.name], singleApprovalToolNames: [],
  }) })
  assert.equal((await prepare()).extensions.explicitSkillSlugs, undefined)
  disposePartial()
}
console.log('PASS: prepareAgentRun 真实入口与媒体 Provider 离线装配，全部场景通过')
