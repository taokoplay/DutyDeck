import { existsSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/** 单条产品品牌或运行时项目路径残留。 */
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

/** 只扫描产品源码；测试 fixture、文档和迁移工具正文不属于运行时路径。 */
const RUNTIME_SOURCE_ROOTS = ['apps/electron/src', 'packages/shared/src'] as const
/** 本轮拥有的四类项目数据目录；用户级旧根和临时文件前缀不在此分类内。 */
const OWNED_PROJECT_DIRECTORY_PATTERN = /(?:^|\/)\.proma\/(?:design|knowledge|interaction-design|visual-production)(?:\/|$)/

/**
 * 检查运行时硬编码的旧项目目录；解析语法以忽略注释并跨行识别路径构造。
 * @param file 仓库相对源码路径，只用于诊断定位，不按文件名宽泛放行。
 * @param text 源码正文。
 * @returns 需要改用中央解析器的旧路径构造，不包含 legacy 常量和兼容读取。
 */
export function collectProjectStorageResidues(file: string, text: string): ResidueFinding[] {
  /** 保留父节点以区分真正的路径参数、过滤数组与用户提示文案。 */
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const findings: ResidueFinding[] = []
  /** 仅检查字面量中的路径，不将临时前缀或普通中文兼容说明识别为路径。 */
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      /** Windows 与 POSIX 采用同一个完整路径段判断。 */
      const value = node.text.replaceAll('\\', '/')
      /** 完整的旧模块路径字面量不可成为默认存储位置；用户级 ~ 路径另属迁移合同。 */
      let forbidden = !/\s/.test(value) && !value.startsWith('~/') && OWNED_PROJECT_DIRECTORY_PATTERN.test(value)
      if (value === '.proma') {
        /** join/resolve 的直接旧根参数会绕开当前目录解析，即使调用分布在多行。 */
        const parent = node.parent
        if (ts.isCallExpression(parent)) {
          const name = ts.isIdentifier(parent.expression) ? parent.expression.text
            : ts.isPropertyAccessExpression(parent.expression) ? parent.expression.name.text : ''
          forbidden = (name === 'join' || name === 'resolve') && parent.arguments.some(argument => argument === node)
        } else if (ts.isArrayLiteralExpression(parent)) {
          /** 捕捉旧存储分段数组，但保留源码扫描排除目录列表。 */
          const next = parent.elements[parent.elements.findIndex(element => element === node) + 1]
          forbidden = Boolean(next && ts.isStringLiteral(next) && /^(?:design|knowledge|interaction-design|visual-production)$/.test(next.text))
        }
      }
      if (forbidden) {
        findings.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, match: node.text, reason: '运行时项目旧目录硬编码：请使用项目存储中央解析器' })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}

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

  /** 限定产品源码扩展名，测试样本中的旧路径用于兼容验证而非运行时默认。 */
  const glob = new Bun.Glob('**/*.{ts,tsx,js,jsx}')
  for (const directory of RUNTIME_SOURCE_ROOTS) {
    const absoluteDirectory = join(root, directory)
    if (!existsSync(absoluteDirectory)) continue
    for await (const relativeFile of glob.scan({ cwd: absoluteDirectory, onlyFiles: true })) {
      if (/(?:^|\/)(?:__tests__|fixtures)(?:\/|$)/.test(relativeFile) || /\.(?:test|spec)\.[^.]+$/.test(relativeFile)) continue
      const file = `${directory}/${relativeFile}`
      findings.push(...collectProjectStorageResidues(file, await Bun.file(join(root, file)).text()))
    }
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
