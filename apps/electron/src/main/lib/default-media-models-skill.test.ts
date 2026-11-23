import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 随应用分发的统一媒体 Skill 入口路径。 */
const mediaModelsSkillPath = join(import.meta.dir, '../../../default-skills/media-models/SKILL.md')

/** 读取随应用分发的统一媒体 Skill，合同测试只验证入口与边界，不模拟真实供应商。 */
function readMediaModelsSkill(): string {
  return existsSync(mediaModelsSkillPath) ? readFileSync(mediaModelsSkillPath, 'utf8') : ''
}

test('Given 统一媒体 Skill When 校验模型发现 Then 覆盖全部目录、分页和可执行能力', () => {
  const skill = readMediaModelsSkill()

  expect(skill).toMatch(/^name: media-models$/m)
  expect(skill).toMatch(/^group: proma$/m)
  expect(skill).toMatch(/^version: "1\.0\.6"$/m)
  for (const rule of [
    'media_list_models',
    'media_list_api_models',
    'nextOffset',
    'available === true',
    'support.state === "supported"',
    'text-to-image',
    'image-to-image',
    'text-to-video',
    'image-to-video',
    'text-to-speech',
    'voice-cloning',
    'text-to-music',
  ]) expect(skill).toContain(rule)
})

test('Given 自然语言媒体需求 When Agent 读取触发元数据 Then 不要求斜杠命令并区分生成与咨询', () => {
  const skill = readMediaModelsSkill()
  const description = skill.match(/^description: (.+)$/m)?.[1] ?? ''
  for (const phrase of ['画一张', '生成封面', '修改这张图', '把图片做成视频', '配音', '无需斜杠命令']) {
    expect(description).toContain(phrase)
  }
  expect(skill).toContain('自然语言中指定的供应商或模型名，与 `/模型名` 选择具有相同的选型意图')
  expect(skill).toContain('只要求提示词、文案、模型比较或代码修改时，不发起生成')
  expect(skill).toContain('仅当当前工具或宿主上下文明确提供默认配置时才使用')
  expect(skill).toContain('计划模式只发现、分析和准备，不执行生成或导入素材')
})

test('Given 用户指定 LibTV When 选择执行链 Then 转交官方远程工具且不伪造统一模型引用', () => {
  const skill = readMediaModelsSkill()
  expect(skill).toContain('libtv-media')
  expect(skill).toContain('不在统一模型目录')
  expect(skill).toContain('不得绕过影像作品或画布任务的绑定、审查与采用门禁')
})

test('Given 媒体生成请求 When 校验旧路由和执行边界 Then 禁止过期 Skill 并保留异步终态合同', () => {
  const skill = readMediaModelsSkill()

  for (const rule of [
    'media_prepare_generation',
    'media_execute_generation',
    'media_wait_generation',
    'media_get_generation',
    'media_cancel_generation',
    'media_list_assets',
    'cancelIntent: "explicit"',
    'configuration-only',
    'canvas-production',
    'proma-generate-image',
    'proma-gpt-image-2',
  ]) expect(skill).toContain(rule)
  expect(skill).toContain('不要把 TTS 模型、LLM 或旧图片模型冒充音乐模型')
  expect(skill).toContain('不重复提交同一付费任务')
})


test('Given 用户指定 ComfyUI When 统一模型目录没有该入口 Then 区分工作流路由与未配置并保留模块边界', () => {
  const skill = readMediaModelsSkill()
  for (const rule of ['comfyui-workflows', 'media_discover_workflows', '不能据此判断未配置',
    '不要伪造', '普通会话无需选择画布或影像模块', '统一目录未找到用户指定模型']) expect(skill).toContain(rule)
})
