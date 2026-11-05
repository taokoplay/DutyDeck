import * as query from "./agent-transcript-query"

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@dutydeck/shared'
import { searchTranscript, readTranscriptDetail } from './agent-transcript-query'
import { projectSDKMessageForDisplay } from './agent-message-display'
import { readTranscriptPage } from './agent-transcript-page'
const dirs: string[] = []
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dutydeck-query-')); dirs.push(dir)
  const path = join(dir, 'history.jsonl')
  writeFileSync(path, JSON.stringify({ type: 'user', uuid: 'old', message: { content: [{ type: 'text', text: '早期约束 中文搜索' }] } }) + '\n'
    + Array.from({ length: 2000 }, (_, i) => JSON.stringify({ type: 'assistant', uuid: `a${i}`, message: { content: [{ type: 'text', text: '普通内容' }] } }) + '\n').join(''))
  return path
}
const project = (message: unknown): SDKMessage => projectSDKMessageForDisplay(message as SDKMessage)
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
describe('历史搜索与按需详情', () => {
  test('Given 命中不在尾页 When 搜索 Then 返回可around定位的ID而非仅搜索当前窗口', async () => {
    const path = fixture()
    const hits = await searchTranscript(path, '中文搜索')
    expect(hits.results[0]?.messageId).toBe('old')
    const page = await readTranscriptPage(path, { sessionId: 'A', mode: 'around', messageId: hits.results[0]!.messageId }, project)
    expect(page.entries[0]?.recordId).toBe('old')
  })
  test('Given 巨大消息与图片 When 分片查看详情 Then 有界且不返回内嵌图片，过期generation拒绝', async () => {
    const path = fixture()
    writeFileSync(path, JSON.stringify({ type: 'assistant', uuid: 'big', message: { role: 'assistant', content: [
      { type: 'text', text: '汉'.repeat(150000) }, { type: 'image', data: 'SECRET_IMAGE_BYTES' },
    ] } }) + '\n')
    const page = await readTranscriptPage(path, { sessionId: 'A', mode: 'rebuild' }, project)
    const detail = await readTranscriptDetail(path, { generation: page.generation, recordId: page.entries[0]!.recordId, offset: 0 }, project)
    expect(detail.text.length).toBeLessThanOrEqual(16000)
    expect(detail.nextOffset).toBe(16000)
    expect(detail.text).not.toContain('SECRET_IMAGE_BYTES')
    writeFileSync(path, '{}\n')
    await expect(readTranscriptDetail(path, { generation: page.generation, recordId: 'big', offset: 0 }, project)).rejects.toThrow()
  })
})

test('Given 最后用户输入在尾窗外 When 请求重试输入 Then 从权威历史返回正文和同一条消息的引用', async () => {
  const path = fixture()
  const input = await query.readTranscriptRetryInput(path, project)
  expect((input as {uuid?: string})?.uuid).toBe('old')
  writeFileSync(path, JSON.stringify({ type: 'user', uuid: 'old', message: { content: [{ type: 'text', text: '不要重发旧输入' }] } }) + '\n'
    + JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'X'.repeat(4 * 1024 * 1024) }] } }) + '\n')
  await expect(query.readTranscriptRetryInput(path, project)).rejects.toThrow('预算')
})

test('Given 页外live请求确认 When 相同generation Then 仅返回确实落盘身份及偏移，换代拒绝', async () => {
  const path = fixture()
  const tail = await readTranscriptPage(path, { sessionId: 's', mode: 'tail' }, project)
  const receipt = await query.acknowledgeTranscriptRecords(path, tail.generation, ['old', 'not-written'])
  expect(receipt).toEqual([{ uuid: 'old', offset: 0 }])
  writeFileSync(path, '{}\n')
  await expect(query.acknowledgeTranscriptRecords(path, tail.generation, ['old'])).rejects.toThrow()
})

test('Given 工具结果在其他页 When 按toolUseId查详情 Then 定位权威结果并保留错误内容', async () => {
  const path = fixture()
  const {appendFileSync} = await import('node:fs')
  appendFileSync(path, JSON.stringify({type:'user',uuid:'result',message:{content:[{type:'tool_result',tool_use_id:'call',is_error:true,content:'失败尾部'}]}})+'\n')
  const tail = await readTranscriptPage(path, {sessionId:'s',mode:'tail'}, project)
  const detail = await readTranscriptDetail(path, {generation:tail.generation,toolUseId:'call',offset:0}, project)
  expect(detail.text).toContain('失败尾部')
  expect(detail.text).toContain('"is_error": true')
})
