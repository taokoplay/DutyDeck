import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanJsonlRecords, type JsonlRecord } from './agent-jsonl-reader'

describe('异步 JSONL 有界扫描', () => {
  test('Given 跨块UTF8和超长记录 When 扫描 Then 完整行正确且超长正文不保留，尾部半行不提交', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dutydeck-jsonl-scan-'))
    try {
      const path = join(directory, 'test.jsonl')
      const first = JSON.stringify({ text: '中文'.repeat(12000) })
      const huge = JSON.stringify({ text: 'x'.repeat(300000) })
      writeFileSync(path, first + '\n' + huge + '\n' + '{"ok":true}\n' + '{"partial":')
      const records: JsonlRecord[] = []
      for await (const record of scanJsonlRecords(path, { maxLineBytes: 100000 })) records.push(record)
      expect(records).toHaveLength(3)
      expect(records[0]?.text).toBe(first)
      expect(records[1]?.text).toBeUndefined()
      expect(records[2]?.text).toBe('{"ok":true}')
      expect(records[1]?.offset).toBe(Buffer.byteLength(first + '\n'))
      const tail: JsonlRecord[] = []
      for await (const record of scanJsonlRecords(path, { start: records[2]!.offset })) tail.push(record)
      expect(tail).toEqual([records[2]!])
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
