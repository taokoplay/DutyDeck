import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const surfaceRoot = join(import.meta.dir, '../src/surfaces/workspace')

describe('Given 交互设计试点 Surface', () => {
  test('When 加载入口 Then 提供创建、候选、采纳和状态区域', () => {
    const html = readFileSync(join(surfaceRoot, 'index.html'), 'utf8')
    for (const id of ['status', 'empty-state', 'workspace', 'create-form', 'create-error', 'propose-form', 'propose-error', 'candidate-list']) {
      expect(html).toContain(`id="${id}"`)
    }
  })

  test('When Surface 连接宿桥 Then 只调用 manifest 声明的方法', () => {
    const source = readFileSync(join(surfaceRoot, 'main.ts'), 'utf8')
    for (const method of ['load', 'create', 'propose', 'adopt']) {
      expect(source).toContain(`'${method}'`)
    }
    expect(source).not.toContain('window.electronAPI')
    expect(source).not.toContain('fetch(')
  })

  test('When 宿主切换主题 Then Surface 复用软件令牌且不接受内嵌文档伪造', () => {
    const source = readFileSync(join(surfaceRoot, 'main.ts'), 'utf8')
    const html = readFileSync(join(surfaceRoot, 'index.html'), 'utf8')
    const style = readFileSync(join(surfaceRoot, 'style.css'), 'utf8')
    expect(source).toContain('isPluginSurfaceThemeMessage')
    expect(source).toContain('installPluginSurfaceComponentStyles')
    expect(source).toContain('event.source === window.parent')
    expect(source).toContain('applyPluginSurfaceTheme')
    expect(html).toContain('class="dd-dialog"')
    expect(html).toContain('class="dd-input"')
    expect(html).toContain('class="dd-textarea dd-code-input"')
    expect(html).toContain('data-variant="primary"')
    for (const token of ['background', 'card', 'foreground', 'muted', 'primary', 'destructive']) {
      expect(style).toContain(`--dutydeck-${token}`)
    }
    expect(style).toContain('--dutydeck-font-family')
    expect(style).toContain('--dutydeck-radius-xl')
    expect(style).not.toContain('prefers-color-scheme')
  })
})
