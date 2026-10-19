import { describe, expect, test } from 'bun:test'
import type { ResourceLoader, Skill } from '@earendil-works/pi-coding-agent'
import { createPromaSkillsOverride, preparePromptWithPromaSkills } from './pi-agent-adapter'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getInactiveModuleSkillSlugs } from '../agent-modules/module-skill-resolver'

/** 构造无读盘需求的 Skill 元数据；目录 slug 可与声明名称不同。 */
function skill(slug: string, name = slug, root = '/tmp/dutydeck-skill-filter'): Skill {
  /** 模拟受管 Skill 根下的目录。 */
  const baseDir = `${root}/${slug}`
  return {
    name, baseDir, filePath: `${baseDir}/SKILL.md`, description: name,
    disableModelInvocation: false,
    sourceInfo: { path: baseDir, source: 'test', scope: 'project', origin: 'top-level' },
  }
}

describe('Pi 专业模块 Skill 接入边界', () => {
  test('Given 宿主内部任务精确签发Skill When 经过模块过滤再展开 Then 真实正文可加载且其它专业Skill仍不可用', async () => {
    /** 临时受管根只写入测试 Skill，不读取真实业务目录。 */
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'module-explicit-skill-'))
    /** 与生产激活审计一致的 skills/<slug>/SKILL.md 结构。 */
    const root = join(fixtureRoot, 'skills')
    try {
      mkdirSync(join(root, 'canvas-production'), { recursive: true })
      writeFileSync(join(root, 'canvas-production', 'SKILL.md'), '---\nname: canvas-production\n---\n内部节点已授权的画布规则')
      /** 生产 resolver 与 Pi 过滤器组合，只有本次宿主签发项可展开。 */
      const excluded = getInactiveModuleSkillSlugs([], undefined, ['canvas-production'])
      const resourceLoader = {
        reload: async () => undefined,
        getSkills: () => createPromaSkillsOverride([root], excluded)({
          skills: [skill('canvas-production', 'canvas-production', root), skill('interaction-design', 'interaction-design', root)], diagnostics: [],
        }),
      } as unknown as ResourceLoader
      const prompt = await preparePromptWithPromaSkills(resourceLoader, '执行节点', ['canvas-production', 'interaction-design'])
      expect(prompt.content).toContain('内部节点已授权的画布规则')
      expect(prompt.activations.map((activation) => activation.slug)).toEqual(['canvas-production'])
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  test('Given 未选专业模块 When 发现 Skills Then 按目录 slug 排除且保留普通及浏览器能力', () => {
    /** 待发现的专业和普通 Skill 集合。 */
    const skills = [skill('canvas-production', 'Canvas Studio'), skill('in-app-browser'), skill('notes')]
    /** 本轮专业模块授权投影。 */
    const filtered = createPromaSkillsOverride(['/tmp/dutydeck-skill-filter'], ['canvas-production'])({ skills, diagnostics: [] })
    expect(filtered.skills.map((entry) => entry.name)).toEqual(['in-app-browser', 'notes'])
  })

  test('Given 名称或文件父目录命中排除清单 When 发现 Skills Then 别名不能绕过', () => {
    /** baseDir 和文件父目录不同的历史 Skill 元数据。 */
    const relocated = { ...skill('generic'), filePath: '/tmp/dutydeck-skill-filter/canvas-production/SKILL.md' }
    expect(createPromaSkillsOverride(['/tmp/dutydeck-skill-filter'], ['canvas-production'])({
      skills: [relocated, skill('different-folder', 'canvas-production')], diagnostics: [],
    }).skills).toEqual([])
  })

  test('Given 已选模块不在排除清单 When 发现 Skills Then 保留其能力但仍拒绝根外资源', () => {
    expect(createPromaSkillsOverride(['/tmp/dutydeck-skill-filter'], [])({
      skills: [skill('canvas-production'), skill('outside', 'outside', '/tmp/other-skills')], diagnostics: [],
    }).skills.map((entry) => entry.name)).toEqual(['canvas-production'])
  })

  test('Given 排除专业 Skill When 显式 mentions 或命令引用 Then 不注入内容或激活记录', async () => {
    /** 模拟与 Pi 一致的过滤后资源接口，reload 后继续应用本轮授权。 */
    const resourceLoader = {
      reload: async () => undefined,
      getSkills: () => createPromaSkillsOverride(['/tmp/dutydeck-skill-filter'], ['canvas-production'])({
        skills: [skill('canvas-production', 'Canvas Studio')], diagnostics: [],
      }),
    } as unknown as ResourceLoader
    /** 分别覆盖目录别名、声明名和消息内命令三条显式引用路径。 */
    for (const names of [['canvas-production'], ['Canvas Studio'], undefined]) {
      expect(await preparePromptWithPromaSkills(resourceLoader, '/skill:canvas-production', names)).toEqual({
        content: '/skill:canvas-production', activations: [],
      })
    }
  })
})
