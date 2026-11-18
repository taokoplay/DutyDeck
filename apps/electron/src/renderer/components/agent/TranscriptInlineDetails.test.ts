import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

describe('历史详情原位连续阅读', () => {
  test('Given 数千条无锚点详情 When 渲染 Then 仅挂载一张可选择卡片而非整批 DOM', async () => {
    const { TranscriptInlineRecords } = await import('./TranscriptInlineDetails')
    /** 只有元数据进入候选集合；未展开时不得读取任一正文。 */
    const records = Array.from({ length: 5000 }, (_, index) => ({
      id: String(index), anchors: [], label: `记录${index}`, fallback: true,
      load: async () => { throw new Error('未展开不应读取') },
    }))
    const html = renderToStaticMarkup(createElement(TranscriptInlineRecords, { records }))
    expect(html.match(/data-transcript-detail-owner=/g)).toHaveLength(1)
    expect(html).toContain('选择窗外详情序号')
    expect(html.length).toBeLessThan(2000)
    const source = readFileSync(new URL('./AgentMessages.tsx', import.meta.url), 'utf8')
    const retained = source.slice(source.indexOf('/** 保留缓冲'), source.indexOf('function TranscriptDetails'))
    expect(retained).not.toContain('messages.map(')
    expect(retained).not.toContain('groups.find(')
  })
  test('Given 历史与保留详情 When 检查入口 Then 使用页内阅读器且无弹窗或翻段按钮', () => {
    /** 仅检查本切片拥有的两个定义，避免绑定并行修改的历史导航。 */
    const source = readFileSync(new URL('./AgentMessages.tsx', import.meta.url), 'utf8')
    const details = source.slice(source.indexOf('/** 保留缓冲'), source.indexOf('export const AgentMessages'))
    expect(details).not.toContain('<Dialog')
    expect(details).not.toContain('上一段')
    expect(details).not.toContain('下一段')
    expect(details).toContain('TranscriptInlineRecords')
    expect(details).toContain('尚未确认已持久化')
    /** 外层原生监听的契约由独立 Electron 冒烟同时验证事件传播。 */
    const inline = readFileSync(new URL('./TranscriptInlineDetails.tsx', import.meta.url), 'utf8')
    expect(inline).toContain('data-transcript-inner-scroll')
    expect(inline).toContain("addEventListener('keydown', keepReadingKey)")
  })

  test('Given 连续前后滚动 When 读取多个段 Then 正文窗口有界且可回读已淘汰内容', async () => {
    const { TranscriptDetailWindow } = await import('./TranscriptInlineDetails')
    /** 模拟有终点的大记录，记录请求位置以验证回读。 */
    const offsets: number[] = []
    const reader = new TranscriptDetailWindow(async offset => {
      offsets.push(offset)
      return { text: '字'.repeat(16000), ...(offset < 96000 ? { nextOffset: offset + 16000 } : {}) }
    })
    for (let offset = 0; offset <= 96000; offset += 16000) await reader.load(offset)
    expect(reader.segments.map(segment => segment.offset)).toEqual([64000, 80000, 96000])
    expect(reader.segments.reduce((size, segment) => size + segment.text.length, 0)).toBe(48000)
    await reader.load(48000)
    expect(reader.segments.map(segment => segment.offset)).toEqual([48000, 64000, 80000])
    expect(offsets.at(-1)).toBe(48000)
  })

  test('Given 读取未完成 When 重复触发或收起 Then 单请求且迟到结果不更新窗口', async () => {
    const { TranscriptDetailWindow } = await import('./TranscriptInlineDetails')
    /** 手动完成请求，模拟关闭后 IPC 才返回。 */
    let finish!: (value: { text: string }) => void
    let calls = 0
    const reader = new TranscriptDetailWindow(() => { calls++; return new Promise(resolve => { finish = resolve }) })
    const pending = reader.load(0)
    await reader.load(0)
    expect(calls).toBe(1)
    reader.dispose()
    finish({ text: '迟到内容' })
    await pending
    expect(reader.segments).toEqual([])
  })

  test('Given StrictMode 重挂载 When 旧请求迟到 Then 只保留新生命周期正文', async () => {
    const { TranscriptDetailWindow } = await import('./TranscriptInlineDetails')
    /** 分别完成旧、新生命周期请求，验证取消令牌。 */
    const finishes: Array<(value: { text: string }) => void> = []
    const reader = new TranscriptDetailWindow(() => new Promise(resolve => finishes.push(resolve)))
    const old = reader.load(0)
    reader.dispose()
    reader.restart()
    const current = reader.load(0)
    finishes[0]!({ text: '旧正文' })
    await old
    expect(reader.loading).toBe(true)
    finishes[1]!({ text: '新正文' })
    await current
    expect(reader.segments[0]?.text).toBe('新正文')
  })

  test('Given 读取失败与超预算响应 When 重试 Then 保留原段且拒绝无界正文', async () => {
    const { TranscriptDetailWindow } = await import('./TranscriptInlineDetails')
    let fail = true
    const reader = new TranscriptDetailWindow(async offset => {
      if (offset && fail) throw new Error('历史版本已变化')
      return { text: '字'.repeat(offset ? 16001 : 16000), nextOffset: offset + 16000 }
    })
    await reader.load(0)
    await reader.load(16000)
    expect(reader.error).toBe('历史版本已变化')
    expect(reader.segments).toHaveLength(1)
    fail = false
    await reader.load(16000)
    expect(reader.error).toContain('预算')
    expect(reader.segments).toHaveLength(1)
  })
})
