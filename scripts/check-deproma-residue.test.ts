import { describe, expect, test } from 'bun:test'
import { collectResidues, FORBIDDEN_RESIDUES } from './check-deproma-residue'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

describe('DutyDeck 去 Proma 残留检查', () => {
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
