/** 保留缓冲的只读文本视图：按片段拼接，绝不先JSON.stringify整条巨型消息。不是可导入JSON。 */
export function sliceRetainedTranscript(value: unknown, offset: number): { text: string; nextOffset?: number } {
  const end = offset + 16000
  let position = 0
  let text = ''
  let nodes = 0
  const seen = new WeakSet<object>()
  function* chunks(item: unknown, key = '', depth = 0): Generator<string> {
    if (++nodes > 20000 || depth > 16) { yield '[结构超过查看预算，请使用完整会话导出]'; return }
    if (key === 'data' || key === 'base64' || (typeof item === 'string' && item.startsWith('data:image/'))) { yield '[图片数据省略]'; return }
    if (typeof item === 'string') { yield '"'; yield item; yield '"'; return }
    if (item === null || typeof item !== 'object') { yield String(item); return }
    if (seen.has(item)) { yield '[循环引用]'; return }
    seen.add(item)
    yield Array.isArray(item) ? '[\n' : '{\n'
    let count = 0
    for (const name in item) {
      if (!Object.hasOwn(item, name)) continue
      if (nodes > 20000) { yield '[其余字段超过查看预算]'; break }
      if (count++) yield ',\n'
      yield `${name.slice(0, 200)}: `
      yield* chunks((item as Record<string, unknown>)[name], name, depth + 1)
    }
    yield Array.isArray(item) ? '\n]' : '\n}'
    seen.delete(item)
  }
  for (const part of chunks(value)) {
    const next = position + part.length
    if (next > offset && position < end) text += part.slice(Math.max(0, offset - position), Math.max(0, end - position))
    position = next
    if (position > end) return { text, nextOffset: end }
  }
  return { text }
}
