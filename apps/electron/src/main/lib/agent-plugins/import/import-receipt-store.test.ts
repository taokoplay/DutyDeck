import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PluginImportReceiptStore, type PluginImportReceipt } from './import-receipt-store'

const initial: Omit<PluginImportReceipt, 'revision' | 'updatedAt'> = { formatVersion: 1, id: 'a'.repeat(64), planHash: 'b'.repeat(64), workspaceId: 'workspace-a', steps: [{ id: 'content', status: 'pending' }, { id: 'mcp', status: 'pending' }] }
function fixture() { const root = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-import-receipt-'))); return { root, store: new PluginImportReceiptStore(root), dispose: () => rmSync(root, { recursive: true, force: true }) } }
describe('Given 导入回执的持久所有权记录', () => {
  test('When 保存并重启 Then CAS修订与已完成阶段保留且身份不能漂移', () => {
    const f = fixture()
    try {
      const first = f.store.put(initial, 0)
      expect(first.revision).toBe(1)
      expect(new PluginImportReceiptStore(f.root).get(initial.id)).toEqual(first)
      expect(() => f.store.put(initial, 0)).toThrow('PLUGIN_IMPORT_RECEIPT_CONFLICT')
      expect(() => f.store.put({ ...initial, planHash: 'c'.repeat(64) }, 1)).toThrow('PLUGIN_IMPORT_RECEIPT_IDENTITY')
      const next = f.store.put({ ...initial, steps: [{ id: 'content', status: 'created', fingerprint: 'd'.repeat(64) }, { id: 'mcp', status: 'pending' }] }, 1)
      expect(next.revision).toBe(2)
      expect(f.store.get(initial.id)?.steps[0]?.status).toBe('created')
    } finally { f.dispose() }
  })
  test('When 主回执损坏且旧备份存在 Then 不从旧状态恢复删除权；非法路径或超限错误不落盘', () => {
    const f = fixture()
    try {
      f.store.put(initial, 0)
      const path = join(f.root, `${initial.id}.json`)
      writeFileSync(`${path}.bak`, readFileSync(path)); writeFileSync(path, '{bad')
      expect(() => f.store.get(initial.id)).toThrow('PLUGIN_IMPORT_RECEIPT_CORRUPT')
      expect(() => f.store.get('../escape')).toThrow('PLUGIN_IMPORT_RECEIPT_ID_INVALID')
      expect(() => f.store.put({ ...initial, id: 'e'.repeat(64), steps: [{ id: 'content', status: 'blocked', error: 'x'.repeat(100000) }] }, 0)).toThrow('PLUGIN_IMPORT_RECEIPT_INVALID')
      expect(existsSync(join(f.root, `${'e'.repeat(64)}.json`))).toBe(false)
    } finally { f.dispose() }
  })
  test('When 同一导入并发操作 Then 跨实例拒绝重复副作用且结束后可重试', async () => {
    const f = fixture(); let release!: () => void
    try {
      const first = f.store.withOperation(initial.id, () => new Promise<void>(resolve => { release = resolve }))
      await expect(new PluginImportReceiptStore(f.root).withOperation(initial.id, async () => 'unexpected')).rejects.toThrow('MEDIA_FILE_BUSY')
      release(); await first
      expect(await f.store.withOperation(initial.id, async () => 'done')).toBe('done')
    } finally { f.dispose() }
  })
})
