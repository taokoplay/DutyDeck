import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePluginManifest } from '@dutydeck/plugin-sdk'

/**
 * 从唯一标准模板生成源文件；此函数不写用户磁盘。
 * @param id 作者命名空间内的插件 ID。
 * @param displayName 用户可见名称。
 * @returns 源文件集合，包含作者工具配置；打包器只选取资源白名单。
 */
export function createStandardPluginFiles(id: string, displayName: string): Map<string, Uint8Array> {
  /** 模板目录在源码与发行物内相对位置一致。 */
  const root = fileURLToPath(new URL('../templates/standard/', import.meta.url))
  const files = new Map<string, Uint8Array>()
  const encode = (value: string): Uint8Array => new TextEncoder().encode(value)
  /** 模板本身由工具发行物管理，只展开常规文件。 */
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.set(relative(root, path).split('\\').join('/'), readFileSync(path))
      else throw new Error('PLUGIN_TEMPLATE_ENTRY_INVALID')
    }
  }
  visit(root)
  /** 使用 JSON 对象赋值避免名称中的引号或转义破坏清单。 */
  const template = JSON.parse(new TextDecoder().decode(files.get('plugin.json.template'))) as Record<string, unknown>
  template.id = id
  template.publisherId = id.split('.')[0]
  template.displayName = displayName
  const parsed = parsePluginManifest(template)
  if (!parsed.ok) throw new Error(parsed.issues.map(issue => `${issue.field}: ${issue.message}`).join('\n'))
  files.delete('plugin.json.template')
  files.set('plugin.json', encode(`${JSON.stringify(parsed.value, null, 2)}\n`))
  files.set('package.json', encode(`${JSON.stringify({
    name: id, version: '1.0.0', private: true, type: 'module',
    dutydeckScaffold: { version: '0.1.0', sdkVersion: '0.1.0' },
    scripts: { validate: 'dutydeck-plugin validate .', test: 'dutydeck-plugin test .', pack: 'dutydeck-plugin pack . --out plugin.ddplugin' },
    devDependencies: { '@dutydeck/plugin-kit': '0.1.0' },
  }, null, 2)}\n`))
  files.set('.gitignore', encode('node_modules/\n*.ddplugin\n'))
  return files
}
