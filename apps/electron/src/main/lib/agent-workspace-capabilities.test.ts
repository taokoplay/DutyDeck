import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 本测试独占的工作区根，避免读写用户真实的 ~/.proma。 */
const testRoot = mkdtempSync(join(tmpdir(), 'proma-workspace-capabilities-'))

mock.module('./config-paths', () => ({
  /** 此组测试不涉及迁移，路径投影恒等且不访问真实定位器。 */
  createDataRootPathResolver: () => (path: string) => path,
  createDataRootPathSerializer: () => (path: string) => path,
  getAgentWorkspacesIndexPath: () => join(testRoot, 'agent-workspaces.json'),
  getAgentWorkspacesDir: () => testRoot,
  getAgentWorkspacePath: (slug: string) => join(testRoot, slug),
  getWorkspaceMcpPath: (slug: string) => join(testRoot, slug, 'mcp.json'),
  getWorkspaceSkillsDir: (slug: string) => join(testRoot, slug, 'skills'),
  getWorkspaceFilesDir: (slug: string) => join(testRoot, slug, 'workspace-files'),
  getInactiveSkillsDir: (slug: string) => join(testRoot, slug, 'skills-inactive'),
  getDefaultSkillsDir: () => join(testRoot, 'default-skills'),
  resolveDefaultSkillsDir: () => join(testRoot, 'default-skills'),
  getUserSkillsDir: () => join(testRoot, 'global-skills'),
  getSkillSettingsPath: () => join(testRoot, 'skill-settings.json'),
  getProjectSkillSettingsPath: (projectRoot: string) => join(projectRoot, '.dutydeck', 'skill-settings.json'),
  parseSkillVersion: () => undefined,
  RETIRED_DEFAULT_SKILL_SLUGS: [],
  isRetiredDefaultSkill: () => false,
}))

mock.module('./builtin-mcp/catalog', () => ({
  listBuiltinMcpServers: () => [],
}))

/** 被测的能力摘要与 Agent 运行时 Skill 扫描入口。 */
const {
  getWorkspaceCapabilities,
  getWorkspaceSkills,
  getAllWorkspaceSkills,
  getWorkspaceSkillDirectories,
  getWorkspaceSkillDirectorySnapshot,
  toggleWorkspaceSkill,
} = await import('./agent-workspace-manager')

/** 写入一个最小可识别的 Skill，供能力摘要与运行时扫描共同验证。 */
function writeSkill(directory: string, slug: string, name: string): void {
  /** 当前测试 Skill 的独立目录。 */
  const skillDirectory = join(directory, slug)
  mkdirSync(skillDirectory, { recursive: true })
  writeFileSync(join(skillDirectory, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf-8')
}

beforeAll(() => {
  /** 测试项目根，用于同时布置启用、关闭 Skill 与 MCP 配置。 */
  const workspaceRoot = join(testRoot, 'project-a')
  writeSkill(join(workspaceRoot, 'skills'), 'active-skill', '启用 Skill')
  writeSkill(join(workspaceRoot, 'skills-inactive'), 'inactive-skill', '关闭 Skill')
  writeSkill(join(testRoot, 'global-skills'), 'global-skill', '全局 Skill')
  writeSkill(join(testRoot, 'global-skills'), 'shared-skill', '全局覆盖')
  writeSkill(join(testRoot, 'default-skills'), 'builtin-skill', '内置 Skill')
  writeSkill(join(testRoot, 'default-skills'), 'shared-skill', '内置被覆盖')
  writeFileSync(join(workspaceRoot, 'mcp.json'), JSON.stringify({
    servers: {
      example: {
        enabled: true,
        type: 'stdio',
        command: 'example',
        args: [],
        lastTestResult: {
          success: false,
          timestamp: 123,
          message: 'secret endpoint detail',
        },
      },
    },
  }), 'utf-8')
})

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true })
})

describe('工作区能力摘要', () => {
  test('Given Skill 已关闭 When 读取 UI 能力摘要 Then 保留 Skill 并标记为关闭', () => {
    /** UI 获取的完整能力摘要。 */
    const capabilities = getWorkspaceCapabilities('project-a')

    expect(capabilities.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: 'active-skill', enabled: true, scope: 'workspace' }),
      expect.objectContaining({ slug: 'inactive-skill', enabled: false, scope: 'workspace' }),
      expect.objectContaining({ slug: 'global-skill', enabled: true, scope: 'global' }),
      expect.objectContaining({ slug: 'builtin-skill', enabled: true, scope: 'builtin' }),
    ]))
  })

  test('Given Skill 已关闭 When Agent 运行时扫描 Skills Then 只返回各作用域启用的最终目录', () => {
    const skills = getWorkspaceSkills('project-a')
    expect(skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: 'active-skill', enabled: true }),
      expect.objectContaining({ slug: 'global-skill', enabled: true }),
      expect.objectContaining({ slug: 'builtin-skill', enabled: true }),
    ]))
    expect(skills.some((skill) => skill.slug === 'inactive-skill')).toBe(false)
  })

  test('Given MCP 测试结果含诊断详情 When 读取能力摘要 Then 仅暴露状态和时间戳', () => {
    /** IPC 能力摘要中的脱敏 MCP 测试结果。 */
    const result = getWorkspaceCapabilities('project-a').mcpServers[0]?.lastTestResult

    expect(result).toEqual({ success: false, timestamp: 123 })
    expect(result && 'message' in result).toBe(false)
  })

  test('Given 全局与内置 Skill When 读取能力目录 Then 返回来源并按设置文件切换状态', () => {
    const skills = getAllWorkspaceSkills('project-a')
    expect(skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: 'global-skill', scope: 'global', enabled: true, readOnly: false }),
      expect.objectContaining({ slug: 'builtin-skill', scope: 'builtin', enabled: true, readOnly: true }),
      expect.objectContaining({ slug: 'shared-skill', name: '全局覆盖', scope: 'global' }),
    ]))
    expect(skills.filter((skill) => skill.slug === 'shared-skill')).toHaveLength(1)

    toggleWorkspaceSkill('project-a', 'global-skill', false)
    expect(getAllWorkspaceSkills('project-a')).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: 'global-skill', scope: 'global', enabled: false }),
    ]))
    expect(getWorkspaceSkillDirectories('project-a').some((path) => path.endsWith('/global-skill'))).toBe(false)
    expect(getWorkspaceSkillDirectorySnapshot('project-a').workspaceSkillDirectories).toEqual([
      join(testRoot, 'project-a', 'skills', 'active-skill'),
    ])
  })
})
