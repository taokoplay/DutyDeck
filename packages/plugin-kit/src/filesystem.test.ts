import { afterEach, describe, expect, test } from 'bun:test'
import { closeSync, mkdtempSync, openSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBoundedFile, collectPluginSource, writeScaffold } from './filesystem.js'
import { createStandardPluginFiles } from './scaffold.js'

/** 所有读取边界场景使用临时目录，退出时清理。 */
const roots: string[] = []
/** 为测试创建独立临时目录。 */
function temporary(): string { const root = mkdtempSync(join(tmpdir(), 'dutydeck-fs-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('插件文件系统硬边界', () => {
  test('Given 超预算文件 When 有界读取 Then 在内容分配前拒绝', () => {
    const root = temporary()
    const path = join(root, 'large.md')
    closeSync(openSync(path, 'wx'))
    truncateSync(path, 17 * 1024 * 1024)
    expect(() => readBoundedFile(path, 16 * 1024 * 1024)).toThrow('PLUGIN_SOURCE_FILE_INVALID')
  })
  test('Given 普通文件与软链接 When 读取 Then 普通文件正确且软链接被拒绝', () => {
    const root = temporary()
    writeFileSync(join(root, 'data'), '内容')
    symlinkSync(join(root, 'data'), join(root, 'alias'))
    expect(readBoundedFile(join(root, 'data'), 6).toString()).toBe('内容')
    expect(() => readBoundedFile(join(root, 'alias'), 6)).toThrow()
    expect(() => readBoundedFile(root, 100)).toThrow('PLUGIN_SOURCE_FILE_INVALID')
  })
  test('Given 脚手架的必需正文损坏 When 打包读取 Then 不将缺失文件默认为空', () => {
    const root = temporary()
    writeScaffold(join(root, 'plugin'), createStandardPluginFiles('acme.example', '示例'))
    rmSync(join(root, 'plugin/plugin.json'))
    expect(() => collectPluginSource(join(root, 'plugin'))).toThrow()
  })
})
