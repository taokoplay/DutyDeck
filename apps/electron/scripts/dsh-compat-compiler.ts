import { build } from 'esbuild'
import ts from 'typescript'
import type { DshBuildGraph, DshBundleOutput } from '../../../packages/plugin-kit/src/dsh-compat/build'

/** 这是固定审查字节的构建保护，不是任意恶意JS的静态安全认证器或沙箱。 */
function assertStaticModule(text: string): void {
  const source = ts.createSourceFile('fixed.mjs', text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && ['require', 'eval'].includes(node.expression.text))) throw new Error('DSH_BUILD_IMPORT_UNSUPPORTED')
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') throw new Error('DSH_BUILD_IMPORT_UNSUPPORTED')
    ts.forEachChild(node, visit)
  }
  visit(source)
}

/** 只在内存图中解析：不读第三方文件、不执行源模块、不使用用户/上游构建插件。 */
export async function compileDshGraph(graph: DshBuildGraph): Promise<DshBundleOutput> {
  const modules = new Map<string, string>()
  for (const [path, bytes] of graph.modules) {
    if (bytes.byteLength > 4 * 1024 * 1024) throw new Error('DSH_BUILD_IMPORT_UNSUPPORTED')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    assertStaticModule(text)
    modules.set(path, text)
  }
  try {
    const result = await build({
      entryPoints: [graph.entry], bundle: true, platform: 'node', format: 'esm', target: 'node20',
      write: false, metafile: true, treeShaking: true, logLevel: 'silent', sourcemap: false,
      plugins: [{ name: 'fixed-dsh-byte-graph', setup(context) {
        context.onResolve({ filter: /.*/ }, args => {
          const path = args.kind === 'entry-point' && args.path === graph.entry
            ? graph.entry
            : args.kind === 'import-statement' && Object.hasOwn(graph.imports, args.importer)
              && Object.hasOwn(graph.imports[args.importer]!, args.path)
              ? graph.imports[args.importer]![args.path] : undefined
          if (!path || !modules.has(path)) throw new Error('DSH_BUILD_IMPORT_UNSUPPORTED')
          return { path, namespace: 'fixed-dsh' }
        })
        context.onLoad({ filter: /.*/, namespace: 'fixed-dsh' }, args => {
          const contents = modules.get(args.path)
          if (contents === undefined) throw new Error('DSH_BUILD_IMPORT_UNSUPPORTED')
          return { contents, loader: 'js' }
        })
      } }],
    })
    if (result.outputFiles.length !== 1) throw new Error('DSH_BUILD_IMPORT_UNSUPPORTED')
    const inputs = Object.keys(result.metafile.inputs).map(path => path.replace(/^fixed-dsh:/, ''))
    const imports = Object.values(result.metafile.outputs).flatMap(output => output.imports.map(item => item.path))
    if (imports.length || inputs.some(path => !modules.has(path))) throw new Error('DSH_BUILD_IMPORT_UNSUPPORTED')
    return { code: result.outputFiles[0]!.contents, inputs, imports }
  } catch { throw new Error('DSH_BUILD_IMPORT_UNSUPPORTED') }
}
