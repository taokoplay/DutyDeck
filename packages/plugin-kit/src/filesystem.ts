import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { isPluginResourcePath } from '@dutydeck/plugin-sdk'

/** 文件系统读取预算与包协议一致，避免先读入无界作者文件。 */
const FILE_LIMIT = 16 * 1024 * 1024
/** 打包只进入声明资源、构建后 runtime 与 Surface 目录，其他开发目录完全不读取。 */
const DIRECTORIES = new Set(['skills', 'prompts', 'styles', 'resources', 'assets', 'runtime', 'surfaces'])
/** 必需的根资源文件白名单。 */
const ROOT_FILES = ['plugin.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md']

/** 读取普通文件且不跟随末级软链接；入参为路径、字节上限，返回原始字节。 */
export function readBoundedFile(path: string, limit: number): Buffer {
  /** 同一文件描述符用于校验和读取，防止文件被替换后绕过大小校验。 */
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    /** 读取时仍有硬上限，文件增长不会形成无界内存分配。 */
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.size > limit) throw new Error('PLUGIN_SOURCE_FILE_INVALID')
    const buffer = Buffer.alloc(stat.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, null)
      if (!count) break
      offset += count
    }
    if (offset !== stat.size) throw new Error('PLUGIN_SOURCE_CHANGED')
    return buffer.subarray(0, offset)
  } finally { closeSync(descriptor) }
}

/** 收集源目录中的静态载荷；入参为源目录，返回可送入 SDK 的文件映射。 */
export function collectPluginSource(directory: string): Map<string, Uint8Array> {
  /** 显式根可经系统别名解析；根内的资源路径不允许软链接。 */
  const root = realpathSync(directory)
  if (!lstatSync(root).isDirectory()) throw new Error('PLUGIN_SOURCE_DIRECTORY_REQUIRED')
  const files = new Map<string, Uint8Array>()
  let total = 0
  let visited = 0
  /** 验证完整路径后有界读取一个资源，累计文件数与总大小。 */
  function add(path: string): void {
    if (!isPluginResourcePath(path)) throw new Error(`PLUGIN_SOURCE_PATH_INVALID:${path}`)
    if (files.size >= 2000) throw new Error('PLUGIN_SOURCE_COUNT_LIMIT')
    const absolute = join(root, path)
    if (realpathSync(dirname(absolute)) !== dirname(absolute)) throw new Error('PLUGIN_SOURCE_DIRECTORY_CHANGED')
    const bytes = readBoundedFile(absolute, Math.min(FILE_LIMIT, 200 * 1024 * 1024 - total))
    if (realpathSync(dirname(absolute)) !== dirname(absolute)) throw new Error('PLUGIN_SOURCE_DIRECTORY_CHANGED')
    total += bytes.length
    files.set(path, bytes)
  }
  /** 只递归白名单目录；隐藏文件、脚本和依赖不进入资源映射。 */
  function visit(path: string, depth: number): void {
    if (depth > 32 || !isPluginResourcePath(`${path}/entry`)) throw new Error('PLUGIN_SOURCE_PATH_INVALID')
    const absolute = join(root, path)
    if (realpathSync(absolute) !== absolute || !lstatSync(absolute).isDirectory()) throw new Error('PLUGIN_SOURCE_DIRECTORY_INVALID')
    const handle = opendirSync(absolute)
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        if (++visited > 10000) throw new Error('PLUGIN_SOURCE_ENTRY_LIMIT')
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        const child = `${path}/${entry.name}`
        if (entry.isSymbolicLink()) throw new Error(`PLUGIN_SOURCE_SYMLINK:${child}`)
        if (entry.isDirectory()) visit(child, depth + 1)
        else if (/\.(md|txt|json|png|jpg|jpeg|webp|gif|svg|mjs|js|css|html|woff2)$/i.test(entry.name)) add(child)
      }
    } finally { handle.closeSync() }
  }
  for (const file of ROOT_FILES) add(file)
  for (const directoryName of DIRECTORIES) {
    try { lstatSync(join(root, directoryName)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    visit(directoryName, 0)
  }
  return files
}

/** 创建全新目录，已有目标一律拒绝；返回解析后的真实目录路径。 */
export function createNewDirectory(path: string): string {
  const destination = resolve(path)
  const parent = realpathSync(dirname(destination))
  const target = join(parent, basename(destination))
  mkdirSync(target, { mode: 0o700 })
  return target
}

/** 独占写入新文件，不覆盖现有文件/软链接；调用方只能写显式目标或已创建的私有目录。 */
export function writeNewFile(path: string, bytes: Uint8Array, mode = 0o600): void {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
  try { writeFileSync(descriptor, bytes) } finally { closeSync(descriptor) }
}

/** 将可信脚手架文件写入全新目录；入参为新目录路径与模板映射，无返回值。 */
export function writeScaffold(directory: string, files: ReadonlyMap<string, Uint8Array>): void {
  const root = createNewDirectory(directory)
  for (const [path, bytes] of files) {
    if (path !== '.gitignore' && !isPluginResourcePath(path)) throw new Error('PLUGIN_TEMPLATE_PATH_INVALID')
    mkdirSync(dirname(join(root, path)), { recursive: true, mode: 0o700 })
    writeNewFile(join(root, path), bytes)
  }
}
