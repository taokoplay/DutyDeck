import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** 固定宿主数据目录身份；已有路径不能是链接，后续替换不能沿用旧授权。不是 OS 沙箱。 */
export class PluginDataDirectory {
  readonly path: string
  private readonly device: number
  private readonly inode: number
  private readonly canonical: string

  constructor(path: string) {
    this.path = resolve(path)
    this.ensure(this.path)
    const stat = lstatSync(this.path)
    this.device = stat.dev
    this.inode = stat.ino
    this.canonical = realpathSync(this.path)
  }

  assertCurrent = (): void => {
    const stat = lstatSync(this.path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== this.device || stat.ino !== this.inode
      || realpathSync(this.path) !== this.canonical) throw new Error('PLUGIN_DATA_ROOT_UNSAFE')
  }

  private ensure(path: string): void {
    try {
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('PLUGIN_DATA_ROOT_UNSAFE')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(path)
      if (parent === path) throw error
      this.ensure(parent)
      mkdirSync(path, { mode: 0o700 })
    }
  }
}
