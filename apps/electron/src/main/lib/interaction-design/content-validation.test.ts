import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { assertPrototypeHtmlContent } from './content-validation'

/** Bun 的 vm.Script 构造函数延迟编译；语法回归在真实 V8/Node 中校验且不运行用户脚本。 */
const nodeModule = new Bun.Transpiler({ loader: 'ts' }).transformSync(readFileSync(new URL('./content-validation.ts', import.meta.url), 'utf8'))
/** 输入页面正文，在 V8 中运行同一校验函数，返回领域错误或空字符串。 */
function nodeValidationError(html: string): string {
  return execFileSync('node', ['--input-type=module'], {
    input: `${nodeModule}\ntry { assertPrototypeHtmlContent(${JSON.stringify(html)}, '工作台 / 选中部件'); } catch (error) { process.stdout.write(error.message); }`,
    encoding: 'utf8', timeout: 5000,
  })
}

describe('交互设计离线正文准入', () => {
  it.each(['application/x-font-ttf', 'application/x-font-opentype', 'application/octet-stream'])(
    'Given 使用兼容 MIME 的内嵌字体 %s When 校验 Then 允许离线资源', mime => {
      expect(() => assertPrototypeHtmlContent(`<style>@font-face{font-family:Local;src:url("data:${mime};base64,AAAA")}</style>`, '字体 / 默认状态')).not.toThrow()
    },
  )

  it.each(['fonts/local.ttf', 'https://example.com/font.otf', '//example.com/font.woff2'])(
    'Given 未内嵌字体 %s When 校验 Then 仍拒绝离线不可用引用', url => {
      expect(() => assertPrototypeHtmlContent(`<style>@font-face{font-family:Local;src:url("${url}")}</style>`, '字体 / 默认状态')).toThrow('离线')
    },
  )

  it.each([
    '<script>let value = 1', '<script>const value = ;</script>',
    '<script type="text/javascript">function broken(</script>',
  ])('Given 截断或语法错误的经典脚本 When 校验 Then 拒绝：%s', html => {
    expect(nodeValidationError(html)).toContain('工作台 / 选中部件')
  })

  it.each([
    '<img src="assets/cabinet.png">', '<img src=https://example.com/a.png>',
    '<img srcset="prototype-asset:known 1x, assets/cabinet.png 2x">',
    '<source srcset="//example.com/a.png 2x">', '<script src="app.js"></script>',
    '<script src="data:text/javascript,void(0)"></script>',
    '<link rel="stylesheet" href="theme.css">', '<link rel="stylesheet" href="data:text/css,body{}">',
    '<style>body{background:url(assets/bg.png)}</style>',
    '<div style="background: url(&quot;assets/bg.png&quot;)"></div>',
    '<style>@import "theme.css";</style>',
    '<style>body{background:u\\72l(assets/bg.png)}</style>',
    '<svg><image href="assets/bg.png"/></svg>',
  ])('Given 未封装离线资源 When 校验 Then 拒绝：%s', html => {
    expect(() => assertPrototypeHtmlContent(html, '工作台 / 默认状态')).toThrow('离线')
  })

  it('Given 离线图片字体和SVG引用 When 校验 Then 保留可用资源与普通链接', () => {
    expect(() => assertPrototypeHtmlContent(`
      <img title="a > b" src="prototype-asset:known">
      <img src="data:image/png;base64,AAAA" srcset="data:image/png;base64,AAAA 1x, prototype-asset:known 2x">
      <style>@font-face{src:url(data:font/woff2;base64,AAAA)}.item{filter:url(#shadow);background:url('prototype-asset:known')}</style>
      <svg xmlns="http://www.w3.org/2000/svg"><use href="#symbol"/></svg>
      <a href="#detail">内部</a><a href="https://example.com">普通链接</a>
    `, '工作台 / 默认状态')).not.toThrow()
  })

  it('Given 注释与字符串含伪标签 When 校验 Then 不误认作资源且不执行脚本', () => {
    expect(() => assertPrototypeHtmlContent(`
      <!-- <img src="missing.png"><script> -->
      <textarea><img src="missing.png"></textarea>
      <script>throw new Error('不得执行'); const example='<img src="missing.png">';</script>
      <style>/* url(missing.png) */ .hint::after{content:'url(missing.png)'}</style>
    `, '示例 / 默认状态')).not.toThrow()
    expect(nodeValidationError('<script>throw new Error("不得执行");</script>')).toBe('')
  })

  it('Given JSON数据与模块脚本 When 校验 Then 不用经典脚本语法误判合法数据或模块', () => {
    expect(() => assertPrototypeHtmlContent('<script type="application/json">{"key":1}</script><script type="module">export const value=1;</script>', '示例 / 默认状态')).not.toThrow()
  })
})
