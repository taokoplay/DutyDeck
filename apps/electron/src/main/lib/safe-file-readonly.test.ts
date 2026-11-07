import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonFileReadonly } from './safe-file'

const options = { validate: (value: unknown): value is { revision: number } => Boolean(value && typeof value === 'object' && 'revision' in value), description: '测试状态', maxBytes: 1024 }
describe('Given 严格只读 JSON 文件', () => {
  test('When 主文件有效/缺失/损坏 Then 读取或明确失败，不修改恢复候选', () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-readonly-'))
    const path = join(root, 'state.json')
    try {
      expect(readJsonFileReadonly(path, options)).toBeNull()
      writeFileSync(`${path}.bak`, '{"revision":1}')
      expect(() => readJsonFileReadonly(path, options)).toThrow('需要显式恢复')
      writeFileSync(path, '{"revision":2}')
      expect(readJsonFileReadonly(path, options)).toEqual({ revision: 2 })
      writeFileSync(`${path}.tmp`, '{bad')
      writeFileSync(path, '{bad')
      expect(() => readJsonFileReadonly(path, options)).toThrow()
      expect(readFileSync(path, 'utf8')).toBe('{bad')
      expect(readFileSync(`${path}.tmp`, 'utf8')).toBe('{bad')
      expect(readFileSync(`${path}.bak`, 'utf8')).toBe('{"revision":1}')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('When 主文件是链接或超限 Then 拒绝而不读取备份', () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-readonly-'))
    try {
      const path = join(root, 'state.json')
      writeFileSync(join(root, 'target'), '{"revision":1}')
      symlinkSync(join(root, 'target'), path)
      expect(() => readJsonFileReadonly(path, options)).toThrow()
      rmSync(path)
      writeFileSync(path, ' '.repeat(1024) + '{"revision":1}')
      expect(() => readJsonFileReadonly(path, options)).toThrow('字节预算')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
