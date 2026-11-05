import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from 'node:fs'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ExitPlanDocument } from '@dutydeck/shared'

const MAX_PLAN_DOCUMENT_BYTES = 1024 * 1024

/** 从可信工作区根逐级检查会话目录、旧 .context 与 plan，不跟随这些层级的链接。
 * 工作区根之前的系统路径别名（如 macOS /var）由 realpath 统一处理。
 */
function checkPlanDirectory(planDirectory: string | undefined, workspaceDirectory: string | undefined, create: boolean): boolean {
  if (!planDirectory || !workspaceDirectory || !isAbsolute(planDirectory) || !isAbsolute(workspaceDirectory)) return false
  try {
    const root = resolve(workspaceDirectory)
    const child = relative(root, resolve(planDirectory))
    if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) return false
    let current = realpathSync(root)
    if (!lstatSync(current).isDirectory()) return false
    for (const segment of child.split(sep)) {
      current = resolve(current, segment)
      try {
        const stat = lstatSync(current)
        if (!stat.isDirectory() || stat.isSymbolicLink()) return false
      } catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') return false
        // 父目录已经逐级验证，不使用 recursive 跳过祖先检查。
        mkdirSync(current)
      }
    }
    return true
  } catch { return false }
}

export function ensureSessionPlanDirectory(planDirectory: string | undefined, workspaceDirectory: string | undefined): boolean {
  return checkPlanDirectory(planDirectory, workspaceDirectory, true)
}

/** 只接受会话 plan 目录内的绝对 Markdown 路径，不允许路径链经过符号链接。 */
export function isSessionPlanMarkdownPath(filePath: string, planDirectory: string | undefined, workspaceDirectory?: string): boolean {
  if (!planDirectory || !isAbsolute(filePath) || extname(filePath).toLowerCase() !== '.md') return false
  // Pi Write/Edit 会把这些 Unicode 空白变成 ASCII 空格；拒绝语义不稳定的路径。
  if (/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/.test(filePath)) return false
  if (!checkPlanDirectory(planDirectory, workspaceDirectory, false)) return false
  try {
    const root = resolve(planDirectory)
    const rootStat = lstatSync(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false
    const candidate = resolve(filePath)
    const child = relative(root, candidate)
    if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) return false
    const segments = child.split(sep)
    let current = root
    for (let index = 0; index < segments.length; index += 1) {
      current = resolve(current, segments[index]!)
      const last = index === segments.length - 1
      try {
        const stat = lstatSync(current)
        if (stat.isSymbolicLink() || (last ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) return false
      } catch (error) {
        // 新文件只允许落到已存在的真实目录，悬空链接会被上面的 lstat 拒绝。
        if (last && (error as NodeJS.ErrnoException).code === 'ENOENT') return true
        return false
      }
    }
    const resolvedChild = relative(realpathSync(root), realpathSync(candidate))
    return Boolean(resolvedChild) && resolvedChild !== '..' && !resolvedChild.startsWith(`..${sep}`) && !isAbsolute(resolvedChild)
  } catch {
    return false
  }
}

/** 有界读取计划并绑定实际文件版本；审批时复用同一策略重新核验。 */
export function resolveSessionPlanDocument(value: unknown, planDirectory: string | undefined, workspaceDirectory?: string): ExitPlanDocument | undefined {
  if (typeof value !== 'string' || !isSessionPlanMarkdownPath(value, planDirectory, workspaceDirectory)) return undefined
  let fd: number | undefined
  try {
    fd = openSync(value, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const before = fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_PLAN_DOCUMENT_BYTES) return undefined
    const bytes = Buffer.alloc(MAX_PLAN_DOCUMENT_BYTES + 1)
    let size = 0
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, size)
      if (count === 0) break
      size += count
    }
    const after = fstatSync(fd)
    const current = lstatSync(value)
    if (after.nlink !== 1 || current.nlink !== 1 || size > MAX_PLAN_DOCUMENT_BYTES || size !== before.size
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || current.dev !== after.dev || current.ino !== after.ino
      || !isSessionPlanMarkdownPath(value, planDirectory, workspaceDirectory)) return undefined
    return {
      filePath: resolve(value),
      displayName: basename(value),
      contentHash: createHash('sha256').update(bytes.subarray(0, size)).digest('hex'),
    }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
