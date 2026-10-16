import { Script } from 'node:vm'
import type { PrototypeDraft } from '@proma/shared'

/** 标签扫描结果；仅提取准入检查需要的属性及正文起点，不构造 DOM。 */
interface HtmlTag {
  /** 小写标签名。 */
  name: string
  /** 首次出现的属性值，与浏览器重复属性处理一致。 */
  attributes: Map<string, string>
  /** 标签结束后的扫描位置。 */
  end: number
}

/** 解码资源属性中的常见实体及数字实体；输入原属性，返回浏览器可见引用。 */
function decodeAttribute(value: string): string {
  return value.replace(/&(?:#(x[0-9a-f]+|[0-9]+);?|([a-z]+);)/gi, (entity, numeric: string | undefined, named: string | undefined) => {
    if (numeric) {
      /** 有界 Unicode 码点，非法字符引用不抛原生异常。 */
      const point = numeric[0]?.toLowerCase() === 'x' ? Number.parseInt(numeric.slice(1), 16) : Number.parseInt(numeric, 10)
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '\ufffd'
    }
    return ({ quot: '"', apos: "'", amp: '&', lt: '<', gt: '>', colon: ':', tab: '\t', newline: '\n' } as Record<string, string>)[named?.toLowerCase() ?? ''] ?? entity
  })
}

/** 扫描单个起始标签，识别引号内的 >；输入 < 后位置，非标签返回 null。 */
function readTag(html: string, start: number): HtmlTag | null {
  /** 起始标签名，只接受 HTML 标签的 ASCII 首字符。 */
  const name = /^[a-z][^\s/>]*/i.exec(html.slice(start))?.[0]
  if (!name) return null
  /** 属性扫描游标。 */
  let cursor = start + name.length
  /** 浏览器对重复属性保留首值。 */
  const attributes = new Map<string, string>()
  while (cursor < html.length) {
    while (/[\s/]/.test(html[cursor] ?? '') && cursor < html.length) cursor++
    if (html[cursor] === '>') return { name: name.toLowerCase(), attributes, end: cursor + 1 }
    /** 单个属性名；遇到非法孤立字符仍前进，避免卡住主进程。 */
    const attribute = /^[^\s=/>]+/.exec(html.slice(cursor))?.[0]
    if (!attribute) { cursor++; continue }
    cursor += attribute.length
    while (/\s/.test(html[cursor] ?? '') && cursor < html.length) cursor++
    /** 布尔属性默认空值。 */
    let value = ''
    if (html[cursor] === '=') {
      cursor++
      while (/\s/.test(html[cursor] ?? '') && cursor < html.length) cursor++
      /** 属性引号，未加引号时按空白或标签结束分隔。 */
      const quote = html[cursor] === '"' || html[cursor] === "'" ? html[cursor++] : undefined
      /** 属性值起点。 */
      const valueStart = cursor
      while (cursor < html.length && (quote ? html[cursor] !== quote : !/[\s>]/.test(html[cursor]!))) cursor++
      value = html.slice(valueStart, cursor)
      if (quote && html[cursor] === quote) cursor++
    }
    if (!attributes.has(attribute.toLowerCase())) attributes.set(attribute.toLowerCase(), decodeAttribute(value))
  }
  return null
}

/** 读取 CSS 字符串并跳过转义引号，返回结束位置；输入包括开始引号。 */
function stringEnd(text: string, start: number): number {
  /** 当前字符串分隔符。 */
  const quote = text[start]
  /** 前进游标，反斜杠保护后一个字符。 */
  let cursor = start + 1
  while (cursor < text.length) {
    if (text[cursor] === '\\') cursor += 2
    else if (text[cursor++] === quote) return cursor
  }
  return cursor
}

/** 校验静态资源是否可以在离线 CSP 下加载；不访问文件或网络。 */
function assertResource(value: string, location: string, kind: 'image' | 'media' | 'css', fragment = false): void {
  /** 资源定位去掉 HTML 边界空白，普通锚点由调用方单独允许。 */
  const resource = value.trim()
  if (fragment && resource.startsWith('#')) return
  if (/^prototype-asset:[A-Za-z0-9_-]+$/.test(resource)) return
  if (/^data:image\/(?:png|jpeg|gif|webp|svg\+xml|avif|bmp|x-icon)(?:;[^,]*)?,/i.test(resource)) return
  /** 兼容离线字体常用旧 MIME 与通用二进制类型，实际字体解码仍由浏览器负责。 */
  if (kind === 'css' && /^data:(?:font\/[a-z0-9.+-]+|application\/(?:font-woff|x-font-ttf|x-font-opentype|octet-stream|vnd\.ms-fontobject))(?:;[^,]*)?,/i.test(resource)) return
  if (kind === 'media' && /^data:(?:audio|video)\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(resource)) return
  throw new Error(`${location}：存在离线预览不可加载的资源，请先导入图片或内联依赖`)
}

/** 校验 CSS 的 url 与 @import，跳过注释及普通字符串；不解析或执行样式。 */
function assertCssResources(css: string, location: string): void {
  /** CSS 游标，保持按正文顺序前进。 */
  let cursor = 0
  while (cursor < css.length) {
    if (css.startsWith('/*', cursor)) {
      /** CSS 注释的结束位置；未闭合注释消费余下内容。 */
      const end = css.indexOf('*/', cursor + 2)
      cursor = end < 0 ? css.length : end + 2
      continue
    }
    if (css[cursor] === '"' || css[cursor] === "'") { cursor = stringEnd(css, cursor); continue }
    /** CSS 名称允许转义字母，识别 u\72l 等合法写法。 */
    const token = /^(?:@?)(?:[a-z_-]|\\(?:[0-9a-f]{1,6}\s?|[^\r\n]))+/i.exec(css.slice(cursor))?.[0]
    if (!token) { cursor++; continue }
    cursor += token.length
    /** 还原名称转义，只用于识别资源语法。 */
    const name = token.replace(/\\([0-9a-f]{1,6})\s?|\\(.)/gi, (_match, hex: string | undefined, character: string | undefined) => hex ? String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff)) : character ?? '').toLowerCase()
    while (/\s/.test(css[cursor] ?? '') && cursor < css.length) cursor++
    if (name === '@import') throw new Error(`${location}：离线预览不支持外部样式 @import，请内联样式`)
    if (name !== 'url' || css[cursor] !== '(') continue
    cursor++
    while (/\s/.test(css[cursor] ?? '') && cursor < css.length) cursor++
    /** URL 值的起点及可选引号。 */
    const start = cursor
    /** URL 原文；带引号时允许括号属于资源数据。 */
    let value: string
    if (css[cursor] === '"' || css[cursor] === "'") {
      cursor = stringEnd(css, cursor)
      value = css.slice(start + 1, cursor - 1)
    } else {
      while (cursor < css.length && css[cursor] !== ')') cursor++
      value = css.slice(start, cursor)
    }
    assertResource(value, location, 'css', true)
  }
}

/** 按 srcset URL/描述符分隔读取候选，保留 data URL 自身的逗号。 */
function assertSrcset(value: string, location: string): void {
  /** srcset 扫描游标。 */
  let cursor = 0
  while (cursor < value.length) {
    while (/[\s,]/.test(value[cursor] ?? '') && cursor < value.length) cursor++
    /** 当前候选 URL 的起点。 */
    const start = cursor
    while (cursor < value.length && !/\s/.test(value[cursor]!)) cursor++
    /** WHATWG srcset 的 URL 先读至空白，末尾逗号是候选分隔符。 */
    const url = value.slice(start, cursor)
    if (!url) break
    assertResource(url.replace(/,+$/, ''), location, 'image')
    if (url.endsWith(',')) continue
    while (cursor < value.length && value[cursor] !== ',') cursor++
  }
}

/**
 * 校验单个页面状态的确定性离线缺陷；输入 HTML 与页面/状态名，失败抛可定位错误。
 * 经典脚本只编译不执行；模块及 JSON 数据块不送入经典脚本编译器。
 * 此检查不证明动态资源、WebGL、事件处理或视觉结果可用，仍须运行态验收。
 */
export function assertPrototypeHtmlContent(html: string, location: string): void {
  /** 顶层扫描游标；raw-text 标签直接跳过正文，避免误读脚本字符串内伪标签。 */
  let cursor = 0
  while (cursor < html.length) {
    /** 下一个可能的标签起点。 */
    const start = html.indexOf('<', cursor)
    if (start < 0) break
    if (html.startsWith('<!--', start)) {
      /** HTML 注释终点。 */
      const end = html.indexOf('-->', start + 4)
      cursor = end < 0 ? html.length : end + 3
      continue
    }
    /** 引号感知的起始标签结果。 */
    const tag = readTag(html, start + 1)
    cursor = tag?.end ?? start + 1
    if (!tag) continue
    /** 属性表仅属于当前标签，不扫描正文中的普通字符串。 */
    const attributes = tag.attributes
    if (attributes.has('style')) assertCssResources(attributes.get('style')!, location)
    if (['img', 'source', 'input', 'video', 'audio', 'track'].includes(tag.name) && attributes.has('src')) assertResource(attributes.get('src')!, location, ['video', 'audio', 'source', 'track'].includes(tag.name) ? 'media' : 'image')
    if (tag.name === 'video' && attributes.has('poster')) assertResource(attributes.get('poster')!, location, 'image')
    if (['img', 'source'].includes(tag.name) && attributes.has('srcset')) assertSrcset(attributes.get('srcset')!, location)
    if (['image', 'use'].includes(tag.name)) {
      for (const name of ['href', 'xlink:href']) if (attributes.has(name)) assertResource(attributes.get(name)!, location, 'image', true)
    }
    if (tag.name === 'script' && attributes.has('src')) throw new Error(`${location}：离线预览不支持 script src，请内联脚本`)
    if (tag.name === 'link' && /(?:^|\s)stylesheet(?:\s|$)/i.test(attributes.get('rel') ?? '') && attributes.has('href')) throw new Error(`${location}：离线预览不支持外部样式表，请内联样式`)
    if (!['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext'].includes(tag.name)) continue
    if (tag.name === 'plaintext') break
    /** HTML raw-text 闭合标签边界，与脚本引号无关。 */
    const closing = new RegExp(`</${tag.name}(?=[\\s/>])[^>]*>`, 'gi')
    closing.lastIndex = cursor
    /** 当前正文闭合位置。 */
    const match = closing.exec(html)
    if (!match && tag.name === 'script') throw new Error(`${location}：script 标签未闭合，生成内容可能被截断`)
    /** 当前原始正文；HTML 实体在 script/style 中不解码。 */
    const body = html.slice(cursor, match?.index ?? html.length)
    cursor = match ? closing.lastIndex : html.length
    if (tag.name === 'style') assertCssResources(body, location)
    if (tag.name === 'script') {
      /** MIME 数据块与模块保留原样，不能按经典 Script 错判。 */
      const type = (attributes.get('type') ?? '').trim().toLowerCase()
      if (type && !/^(?:(?:text|application)\/(?:x-)?(?:javascript|ecmascript)|text\/(?:javascript1\.[0-5]|jscript|livescript))(?:\s*;|$)/.test(type)) continue
      try { new Script(body) } catch {
        throw new Error(`${location}：内联脚本语法错误，生成内容可能被截断`)
      }
    }
  }
}

/**
 * 返回页面状态的离线内容问题；传基线时仅检查同一页面/状态身份下新增或变更的 HTML。
 * 不传基线用于诊断全部旧内容，不能把旧缺陷变成无关编辑的发布门禁。
 */
export function validatePrototypeContent(draft: PrototypeDraft, baseline?: PrototypeDraft): string[] {
  /** 按稳定页面身份比较，名称、目录或顺序变更不重复检查未改正文。 */
  const previousPages = new Map(baseline?.pages.map(page => [page.id, page]))
  /** 每个状态最多返回首个确定性问题，避免错误清单无界增长。 */
  const issues: string[] = []
  for (const page of draft.pages) {
    /** 原页面及其附加状态正文。 */
    const previous = previousPages.get(page.id)
    const previousStates = new Map(previous?.states?.map(state => [state.id, state.html]))
    /** 默认正文与具名状态分别按自己的身份检查，不能跨状态借用已存在的 HTML。 */
    const contents = [
      { html: page.html, before: previous?.html, name: page.defaultStateName ?? '默认状态' },
      ...(page.states ?? []).map(state => ({ html: state.html, before: previousStates.get(state.id), name: state.name })),
    ]
    for (const content of contents) {
      if (content.html === content.before) continue
      try { assertPrototypeHtmlContent(content.html, `${page.name} / ${content.name}`) } catch (error) {
        issues.push(error instanceof Error ? error.message : `${page.name} / ${content.name}：页面内容校验失败`)
      }
    }
  }
  return issues
}
