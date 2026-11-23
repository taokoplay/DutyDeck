import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatSkillsForPrompt, loadSkills } from '@earendil-works/pi-coding-agent'

const root = join(import.meta.dir, '../../../default-skills/comfyui-workflows')

/** 验证分发文档与真实 Pi 发现；不把文档断言冒充远端生成或 LLM 触发。 */
function read(relative = 'SKILL.md'): string {
  const path = join(root, relative)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

test('Given 内置 ComfyUI Skill When Pi 按显式目录加载 Then 可按自然语言发现且正文按需读取', () => {
  const loaded = loadSkills({ cwd: root, agentDir: root, skillPaths: [root], includeDefaults: false })
  expect(loaded.diagnostics).toEqual([])
  expect(loaded.skills.map(skill => skill.name)).toEqual(['comfyui-workflows'])
  const skill = loaded.skills[0]!
  expect(skill.disableModelInvocation).toBe(false)
  const prompt = formatSkillsForPrompt(loaded.skills)
  expect(prompt).toContain('<name>comfyui-workflows</name>')
  expect(prompt).not.toContain(read())
  expect(read()).toMatch(/^version: "1\.0\.2"$/m)
  const description = read().match(/^description: (.+)$/m)?.[1] ?? ''
  for (const trigger of ['ComfyUI', '工作流', '模型', '编写', '首尾帧']) expect(description).toContain(trigger)
})

test('Given 新任务 When 发现工作流 Then 按结构和语义匹配且不把半页或连接故障当无匹配', () => {
  const skill = read()
  for (const rule of ['media_list_workflows', 'effectiveConnection', 'single-enabled', 'media_discover_workflows',
    'inputKinds', 'nextOffset', 'incomplete', 'blocked', 'unavailable', '首尾帧', 'contentHash',
    'media_use_remote_workflow', 'media_read_remote_workflow', '不按目录顺序']) expect(skill).toContain(rule)
})

test('Given 无适用工作流 When 按需求编写 Then 依据实际资源和 schema 校验并保存版本', () => {
  const skill = read()
  for (const rule of ['media_list_resources', 'media_get_node_schema', 'media_inspect_workflow',
    'media_save_local_workflow', 'creationIntent=user-confirmed', 'creationIntent=automatic-policy',
    'expectedConfigRevision', 'expectedWorkflowRevision', 'references/workflow-authoring.md']) expect(skill).toContain(rule)
  const authoring = read('references/workflow-authoring.md')
  for (const rule of ['schemaVersion', 'class_type', 'bindings', 'outputs', 'outputIndex',
    '历史媒体数组', 'MediaAssetRef', '不下载模型', '不安装自定义节点', '显存', '占位']) expect(authoring).toContain(rule)
})

test('Given 工具或授权不足 When 规划与执行 Then 不绕过模块、审批、资产和异步任务边界', () => {
  const skill = read()
  for (const rule of ['普通会话无需选择画布或影像模块', '不自动启用', '计划模式', '只写提示词', 'ask', 'automatic',
    'media_prepare_run', 'media_execute_run', 'media_wait_run', 'media_get_run',
    'canvas-production', 'visual_production_', '原 runId', '保存不等于生成成功', '不读取凭据',
    '纯文本提示词', '只有选型请求时不生成', '端口名也不必然等于宿主绑定 key']) expect(skill).toContain(rule)
})
