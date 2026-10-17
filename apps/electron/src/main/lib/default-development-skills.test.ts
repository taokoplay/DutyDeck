import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatSkillsForPrompt, loadSkills } from '@earendil-works/pi-coding-agent'
import { writeJsonFileAtomic } from './safe-file'

// 模块替身在 Bun 中跨文件存活，只有专用子进程才注册实际夹具与四项检查。
if (process.env.DUTYDECK_DEVELOPMENT_SKILL_TEST_CHILD !== '1') {
  test('Given 开发 Skill 分发验证需要定位器替身 When 执行集成检查 Then 隔离进程且全部通过', () => {
    /** 当前文件在独立 Bun 进程中执行，标记只用于避免递归启动。 */
    const result = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, DUTYDECK_DEVELOPMENT_SKILL_TEST_CHILD: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    })
    if (result.exitCode !== 0) {
      throw new Error(`开发 Skill 隔离检查失败：\n${result.stdout.toString()}\n${result.stderr.toString()}`)
    }
    expect(result.exitCode).toBe(0)
  }, 35_000)
} else {
  /** 本文件独占的数据根；所有同步与停用操作仅作用于临时目录。 */
  const testRoot = mkdtempSync(join(tmpdir(), 'dutydeck-development-skills-'))
  /** 随应用分发的 Skill 源目录。 */
  const bundledRoot = join(import.meta.dir, '../../../default-skills')
  /** 本轮接入的三个独立开发 Skill。 */
  const developmentSlugs = ['writing-plans', 'executing-plans', 'test-driven-development']

  mock.module('./data-root-locator', () => ({
    /** 只替换数据根定位，保留真实路径、版本解析和同步逻辑。 */
    DataRootLocator: class {
      /** 返回测试数据根，不读取用户 home 或 locator。 */
      requireActiveRoot(): string { return testRoot }
    },
  }))

  /** 真实配置 API，使用上面注入的独立数据根。 */
  const {
    getDefaultSkillsDir, getAgentWorkspacesIndexPath, getWorkspaceSkillsDir,
    getInactiveSkillsDir, parseSkillVersion,
  } = await import('./config-paths')
  /** 真实工作区升级与启停入口。 */
  const { upgradeDefaultSkillsInWorkspaces, toggleWorkspaceSkill } = await import('./agent-workspace-manager')

  /**
   * 写入已安装版本夹具；入参是启用目录、slug、版本，返回原文供覆盖检查。
   */
  function writeInstalledSkill(directory: string, slug: string, version: string): string {
    /** 用不同正文区分旧工作区副本与本轮打包内容。 */
    const content = `---\nname: ${slug}\ndescription: 已安装的开发技能\nversion: "${version}"\n---\n\n用户已有内容\n`
    mkdirSync(join(directory, slug), { recursive: true })
    writeFileSync(join(directory, slug, 'SKILL.md'), content)
    return content
  }

  /** 按生产配置仅扫描显式启用目录；返回 Pi 实际可发现的 Skill 与诊断。 */
  function loadActiveSkills() {
    return loadSkills({
      cwd: testRoot,
      agentDir: join(testRoot, 'runtime'),
      skillPaths: [getWorkspaceSkillsDir('existing')],
      includeDefaults: false,
    })
  }

  beforeEach(() => {
    rmSync(testRoot, { recursive: true, force: true })
    mkdirSync(testRoot, { recursive: true })
    writeJsonFileAtomic(getAgentWorkspacesIndexPath(), {
      version: 2,
      workspaces: [{ id: 'existing', slug: 'existing', name: '已有项目', createdAt: 1, updatedAt: 1 }],
    })
    for (const slug of developmentSlugs) {
      /** 缺失的新 Skill 留给发现断言报告，不让夹具复制错误掩盖行为差异。 */
      const source = join(bundledRoot, slug)
      if (existsSync(source)) cpSync(source, join(getDefaultSkillsDir(), slug), { recursive: true })
    }
  })

  afterAll(() => rmSync(testRoot, { recursive: true, force: true }))

  describe('内置开发 Skills 的分发与发现', () => {
    test('Given 已有项目缺少开发 Skills When 同步并交给 Pi 加载 Then 三个独立入口可用且正文按需读取', () => {
      upgradeDefaultSkillsInWorkspaces()
      /** Pi 使用与生产相同的显式目录发现配置。 */
      const loaded = loadActiveSkills()
      expect(loaded.diagnostics).toEqual([])
      expect(loaded.skills.map((skill) => skill.name).sort()).toEqual([...developmentSlugs].sort())
      /** 系统提示只提供目录信息，不常驻整份 Skill 正文。 */
      const prompt = formatSkillsForPrompt(loaded.skills)
      for (const skill of loaded.skills) {
        expect(skill.disableModelInvocation).toBe(false)
        expect(prompt).toContain(`<name>${skill.name}</name>`)
        expect(prompt).toContain(skill.filePath)
        expect(prompt).not.toContain(readFileSync(skill.filePath, 'utf8'))
        expect(parseSkillVersion(skill.baseDir)).toMatch(/^\d+\.\d+\.\d+$/)
      }
    })

    test('Given 老工作区安装旧版规划与执行 Skill When 升级 Then 两者收到新正文并注入 TDD', () => {
      writeInstalledSkill(getWorkspaceSkillsDir('existing'), 'writing-plans', '1.0.2')
      writeInstalledSkill(getWorkspaceSkillsDir('existing'), 'executing-plans', '1.0.1')
      upgradeDefaultSkillsInWorkspaces()
      for (const slug of developmentSlugs) {
        expect(readFileSync(join(getWorkspaceSkillsDir('existing'), slug, 'SKILL.md'), 'utf8'))
          .toBe(readFileSync(join(bundledRoot, slug, 'SKILL.md'), 'utf8'))
      }
    })

    test('Given 用户停用旧版 TDD When 升级 Then 保留停用并允许以后主动启用', () => {
      writeInstalledSkill(getInactiveSkillsDir('existing'), 'test-driven-development', '0.0.1')
      upgradeDefaultSkillsInWorkspaces()
      expect(readFileSync(join(getInactiveSkillsDir('existing'), 'test-driven-development', 'SKILL.md'), 'utf8'))
        .toBe(readFileSync(join(bundledRoot, 'test-driven-development', 'SKILL.md'), 'utf8'))
      expect(existsSync(join(getWorkspaceSkillsDir('existing'), 'test-driven-development'))).toBe(false)
      expect(loadActiveSkills().skills.map((skill) => skill.name).sort())
        .toEqual(['executing-plans', 'writing-plans'])

      toggleWorkspaceSkill('existing', 'test-driven-development', true)
      expect(loadActiveSkills().skills.map((skill) => skill.name)).toContain('test-driven-development')
    })

    test('Given 用户已有更高版本 TDD When 同步内置版本 Then 不覆盖用户副本', () => {
      /** 高于本次内置版本的用户内容，用于验证既有升级边界。 */
      const original = writeInstalledSkill(getWorkspaceSkillsDir('existing'), 'test-driven-development', '99.0.0')
      upgradeDefaultSkillsInWorkspaces()
      expect(readFileSync(join(getWorkspaceSkillsDir('existing'), 'test-driven-development', 'SKILL.md'), 'utf8'))
        .toBe(original)
    })
  })
}
