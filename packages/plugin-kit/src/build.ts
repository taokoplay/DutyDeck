import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { readBoundedFile, writeNewFile } from './filesystem.js'

/** 构建只接受的静态 Surface 扩展。 */
const SURFACE_ASSET = /\.(html|css|png|jpg|jpeg|webp|gif|svg|woff2)$/i
/** Surface 源码扩展，输出统一为同名 .js。 */
const SURFACE_SOURCE = /\.(ts|tsx|js|jsx)$/i

/** 运行 Bun 构建并保留稳定错误，不执行作者 package scripts。 */
function runBunBuild(projectRoot: string, entry: string, outfile: string, target: 'node' | 'browser'): void {
  const result = spawnSync('bun', ['build', entry, '--outfile', outfile, '--target', target, '--format', 'esm'], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.error) throw new Error(`PLUGIN_BUILD_PROCESS_FAILED:${result.error.message}`)
  if (result.status !== 0) throw new Error(`PLUGIN_BUILD_FAILED:${(result.stderr || result.stdout).trim().slice(0, 8192)}`)
}

/** 递归复制静态 Surface 文件并拒绝软链接。 */
function copySurfaceAssets(sourceRoot: string, outputRoot: string): void {
  /** 每个路径都重新校验文件类型，避免构建期间替换父目录。 */
  const visit = (source: string, output: string): void => {
    const stat = lstatSync(source)
    if (stat.isSymbolicLink()) throw new Error(`PLUGIN_BUILD_SYMLINK_FORBIDDEN:${relative(sourceRoot, source)}`)
    if (stat.isDirectory()) {
      mkdirSync(output, { recursive: true, mode: 0o700 })
      for (const entry of readdirSync(source, { withFileTypes: true })) {
        visit(join(source, entry.name), join(output, entry.name))
      }
      return
    }
    if (!stat.isFile()) throw new Error(`PLUGIN_BUILD_ENTRY_INVALID:${relative(sourceRoot, source)}`)
    if (SURFACE_SOURCE.test(source)) {
      const destination = `${output.replace(SURFACE_SOURCE, '')}.js`
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
      runBunBuild(sourceRoot, source, destination, 'browser')
      return
    }
    if (!SURFACE_ASSET.test(source)) return
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 })
    writeNewFile(output, readBoundedFile(source, 16 * 1024 * 1024))
  }
  visit(sourceRoot, outputRoot)
}

/** 统计构建产物文件数量，输出未知目录也不能绕过上限。 */
function countFiles(directory: string): number {
  let total = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('PLUGIN_BUILD_OUTPUT_SYMLINK')
    total += entry.isDirectory() ? countFiles(join(directory, entry.name)) : 1
    if (total > 2000) throw new Error('PLUGIN_BUILD_OUTPUT_LIMIT')
  }
  return total
}

/**
 * 把作者 src 工程构建到包内固定 runtime/ 与 surfaces/。
 * @param directory V3 插件工程根目录。
 * @returns 构建后的 runtime 和静态 Surface 文件数。
 */
export function buildModuleRuntimePlugin(directory: string): { runtimeFiles: number; surfaceFiles: number } {
  const root = realpathSync(directory)
  if (!lstatSync(root).isDirectory()) throw new Error('PLUGIN_BUILD_DIRECTORY_REQUIRED')
  const runtimeSource = join(root, 'src/runtime.ts')
  try {
    if (!lstatSync(runtimeSource).isFile()) throw new Error('PLUGIN_BUILD_RUNTIME_SOURCE_MISSING')
  } catch (cause) {
    if (cause instanceof Error && cause.message === 'PLUGIN_BUILD_RUNTIME_SOURCE_MISSING') throw cause
    throw new Error('PLUGIN_BUILD_RUNTIME_SOURCE_MISSING')
  }
  rmSync(join(root, 'runtime'), { recursive: true, force: true })
  rmSync(join(root, 'surfaces'), { recursive: true, force: true })
  mkdirSync(join(root, 'runtime'), { recursive: true, mode: 0o700 })
  runBunBuild(root, runtimeSource, join(root, 'runtime/main.mjs'), 'node')
  const surfaceSource = join(root, 'src/surfaces')
  let surfaceFiles = 0
  try {
    if (!lstatSync(surfaceSource).isDirectory()) throw new Error('PLUGIN_BUILD_SURFACE_SOURCE_MISSING')
    copySurfaceAssets(surfaceSource, join(root, 'surfaces'))
    surfaceFiles = countFiles(join(root, 'surfaces'))
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('PLUGIN_BUILD_SURFACE_SOURCE_MISSING')
    throw cause
  }
  return { runtimeFiles: countFiles(join(root, 'runtime')), surfaceFiles }
}
