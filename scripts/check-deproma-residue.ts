import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface ResidueFinding {
  file: string
  line: number
  match: string
  reason: string
}

/** 计划内必须清理的用户可见 Proma 残留。 */
export const FORBIDDEN_RESIDUES = [
  ['apps/electron/src/main/menu.ts', 'https://github.com/yourusername/proma'],
  ['apps/mobile/index.html', '<title>Proma</title>'],
  ['apps/mobile/src/components/layout/AuthPage.tsx', 'Proma 手机端'],
  ['apps/mobile/src/components/layout/AuthPage.tsx', '连接到桌面 Proma'],
  ['packages/core/package.json', 'proma core'],
  ['packages/session-core/package.json', 'Proma agent sessions'],
  ['apps/mobile/package.json', 'Proma mobile'],
  ['apps/electron/electron-builder.yml', 'resources/proma-logos'],
  ['apps/mobile/src/components/layout/AppShell.tsx', '>Proma<'],
  ['apps/mobile/src/components/layout/Drawer.tsx', '>Proma<'],
  ['apps/mobile/src/components/conversation/StreamingAssistantMessage.tsx', '>Proma<'],
  ['apps/mobile/src/components/conversation/MessageBubble.tsx', "|| 'Proma'"],
  ['apps/electron/src/renderer/components/settings/SlackSettings.tsx', '@Proma'],
  ['apps/electron/src/renderer/components/settings/StorageSettings.tsx', 'Proma Agent 会话'],
  ['apps/electron/src/renderer/components/settings/StorageSettings.tsx', 'Proma 管理的数据'],
  ['apps/electron/src/renderer/components/settings/StorageSettings.tsx', 'Proma 管理的会话'],
  ['apps/electron/src/renderer/components/settings/StorageSettings.tsx', 'Proma 会保留'],
] as const

/** 收集计划列出的产品残留，并返回可供测试与 CI 使用的结构化结果。 */
export async function collectResidues(root: string): Promise<ResidueFinding[]> {
  const findings: ResidueFinding[] = []
  for (const [file, fragment] of FORBIDDEN_RESIDUES) {
    const absolutePath = join(root, file)
    if (!existsSync(absolutePath)) continue
    const text = await Bun.file(absolutePath).text()
    text.split(/\r?\n/).forEach((line, index) => {
      if (line.includes(fragment)) {
        findings.push({ file, line: index + 1, match: fragment, reason: '用户可见品牌或错误资源路径' })
      }
    })
  }

  return findings
}

/** 格式化审计结果，便于 CI 日志直接定位文件和行号。 */
export function formatResidues(findings: readonly ResidueFinding[]): string {
  return findings.map((finding) => `${finding.file}:${finding.line} ${finding.reason}: ${finding.match}`).join('\n')
}

if (import.meta.main) {
  const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
  const findings = await collectResidues(root)
  if (findings.length > 0) {
    console.error(formatResidues(findings))
    process.exitCode = 1
  } else {
    console.log('DutyDeck 去 Proma 残留检查通过：未发现非兼容白名单命中。')
  }
}
