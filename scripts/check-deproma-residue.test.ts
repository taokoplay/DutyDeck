import { describe, expect, test } from 'bun:test'
import { collectProjectStorageResidues, collectResidues, FORBIDDEN_RESIDUES } from './check-deproma-residue'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

describe('DutyDeck 去 Proma 残留检查', () => {
  test('Given 旧项目路径构造 When 审计运行时代码 Then 捕获跨行参数、路径数组与完整字面量', () => {
    /** 使用不同语法验证同一旧目录回归，不能依赖具体文件名白名单。 */
    const source = [
      "const root = path.join(projectRoot,",
      "  '.proma', 'design')",
      "const other = resolve(projectRoot, '.proma', 'knowledge')",
      "const segments = ['.proma', 'visual-production']",
      "const path = '.proma/interaction-design/projects'",
      'const windows = "C:\\\\project\\\\.proma\\\\knowledge"',
      'const template = `${projectRoot}/.proma/design`',
    ].join('\n')
    const findings = collectProjectStorageResidues('apps/electron/src/main/lib/legacy-migration.ts', source)
    expect(findings.map(finding => finding.line)).toEqual([2, 3, 4, 5, 6, 7])
    expect(findings.every(finding => finding.reason.includes('中央解析器'))).toBe(true)
  })

  test('Given 显式兼容边界 When 审计 Then 保留 legacy 常量、读取、排除规则和临时前缀', () => {
    /** 兼容读取只能引用已命名 legacy 根，不允许借迁移文件名放过新的硬编码。 */
    const source = [
      "export const LEGACY_PROJECT_STORAGE_DIRECTORY_NAME = '.proma' as const",
      "const source = join(root, LEGACY_PROJECT_STORAGE_DIRECTORY_NAME, 'design')",
      "const temporary = join(root, '.proma-copy-123')",
      "const ignored = ['.git', '.dutydeck', '.proma', 'node_modules']",
      "const message = '使用 .dutydeck/knowledge（旧项目兼容 .proma/knowledge）'",
      "const legacyUserRoot = '~/.proma/design'",
      "// const obsolete = join(root, '.proma', 'knowledge')",
    ].join('\n')
    expect(collectProjectStorageResidues('apps/electron/src/main/lib/migration.ts', source)).toEqual([])
    expect(collectProjectStorageResidues('apps/electron/src/main/lib/migration.ts', "const path = join(root, '.proma', 'design')")).toHaveLength(1)
  })

  test('Given 当前运行时源码 When 检查项目存储残留 Then 不存在绕过中央解析器的旧目录', async () => {
    expect((await collectResidues(ROOT)).filter(finding => finding.reason.includes('运行时项目旧目录'))).toEqual([])
  })

  test('固定用户可见残留规则全部清理', async () => {
    const findings = await collectResidues(ROOT)
    const fixedFindings = findings.filter((finding) =>
      FORBIDDEN_RESIDUES.some(([file, fragment]) => file === finding.file && fragment === finding.match),
    )
    expect(fixedFindings).toEqual([])
  })

  test('兼容值仍保留在产品代码中', async () => {
    const paths = await Bun.file(`${ROOT}/apps/cli/package.json`).text()
    const cliPaths = await Bun.file(`${ROOT}/apps/cli/src/paths.ts`).text()
    const agentTypes = await Bun.file(`${ROOT}/packages/shared/src/types/agent.ts`).text()
    expect(paths).toContain('"proma"')
    expect(cliPaths).toContain('PROMA_CONFIG_DIR')
    expect(agentTypes).toContain("'proma_event'")
  })
})
