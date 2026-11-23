import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildAgentSkillScopeRoots,
  resolveAgentSkillDirectories,
  type AgentSkillScopeRoot,
} from './agent-skill-scope-resolver'

/** 当前测试使用的临时目录，确保多作用域解析不触碰用户真实配置。 */
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 写入最小可被 Pi 发现的 Skill。 */
function writeSkill(root: string, slug: string): void {
  mkdirSync(join(root, slug), { recursive: true })
  writeFileSync(join(root, slug, 'SKILL.md'), `---\nname: ${slug}\ndescription: 测试 Skill\n---\n`, 'utf-8')
}

describe('Agent Skill 作用域解析', () => {
  test('Given 四层 Skill 根 When 构建作用域 Then 按项目、工作区、全局、内置排序并去重路径', () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-skill-scopes-'))
    temporaryRoots.push(root)
    const project = join(root, 'project')
    const workspace = join(root, 'workspace')
    const global = join(root, 'global')
    const builtin = join(root, 'builtin')

    expect(buildAgentSkillScopeRoots({
      projectRoot: project,
      workspaceRoot: workspace,
      globalSkillsRoot: global,
      builtinSkillsRoot: builtin,
    })).toEqual([
      { scope: 'project', path: join(project, '.dutydeck', 'skills') },
      { scope: 'workspace', path: join(workspace, 'skills') },
      { scope: 'global', path: global },
      { scope: 'builtin', path: builtin },
    ])
  })

  test('Given 同名 Skill 分布在多个作用域 When 解析目录 Then 高优先级版本获胜且不重复加载', () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-skill-resolution-'))
    temporaryRoots.push(root)
    const project = join(root, 'project', '.dutydeck', 'skills')
    const workspace = join(root, 'workspace', 'skills')
    const global = join(root, 'global')
    const builtin = join(root, 'builtin')
    for (const directory of [project, workspace, global, builtin]) mkdirSync(directory, { recursive: true })

    writeSkill(project, 'shared')
    writeSkill(workspace, 'shared')
    writeSkill(workspace, 'workspace-only')
    writeSkill(global, 'shared')
    writeSkill(global, 'global-only')
    writeSkill(builtin, 'shared')
    writeSkill(builtin, 'builtin-only')

    const roots: AgentSkillScopeRoot[] = [
      { scope: 'project', path: project },
      { scope: 'workspace', path: workspace },
      { scope: 'global', path: global },
      { scope: 'builtin', path: builtin },
    ]

    expect(resolveAgentSkillDirectories(roots)).toEqual([
      join(project, 'shared'),
      join(workspace, 'workspace-only'),
      join(global, 'global-only'),
      join(builtin, 'builtin-only'),
    ])
  })

  test('Given 不存在或不完整的目录 When 解析 Skill Then 忽略并保持其他作用域可用', () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-skill-gaps-'))
    temporaryRoots.push(root)
    const global = join(root, 'global')
    const builtin = join(root, 'builtin')
    mkdirSync(join(global, 'broken'), { recursive: true })
    mkdirSync(builtin, { recursive: true })
    writeSkill(builtin, 'available')

    expect(resolveAgentSkillDirectories([
      { scope: 'project', path: join(root, 'missing') },
      { scope: 'global', path: global },
      { scope: 'builtin', path: builtin },
    ])).toEqual([join(builtin, 'available')])
  })
})
