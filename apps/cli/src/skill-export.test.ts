import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SDKUserMessage } from '@dutydeck/shared'
import { mergeSkillActivationStore } from '../../../packages/session-core/src/skill-activation-projection'

test('Given 独立数据根和 Skill 旁车 When 真实 CLI 按 ID 与路径导出 Then 保留 Skill 且不改写 JSONL', () => {
  /** 独立数据根同时验证 --config-dir 与直接文件路径。 */
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-cli-skills-'))
  try {
    mkdirSync(join(root, 'agent-sessions'))
    /** 使用共享生成器构建旁车，避免测试复制摘要格式。 */
    const message: SDKUserMessage = { type: 'user', uuid: 'user-1', parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: '帮我检查代码' }] } }
    const store = mergeSkillActivationStore({ version: 1, entries: [] }, message,
      [{ slug: 'review', name: '代码审查', sources: ['read'] }])
    const path = join(root, 'agent-sessions', 'portable.jsonl')
    const raw = JSON.stringify(message) + '\r\n'
    writeFileSync(path, raw)
    writeFileSync(`${path}.skills.json`, JSON.stringify(store))
    /** 子进程经过真实 registry、会话解析、Node reader 和文件导出。 */
    for (const target of ['portable', path]) {
      const output = join(root, 'export.md')
      const result = Bun.spawnSync([process.execPath, fileURLToPath(new URL('./index.ts', import.meta.url)),
        'session', 'export', target, '--config-dir', root, '--out', output], { cwd: root })
      expect(result.exitCode).toBe(0)
      expect(readFileSync(output, 'utf8')).toContain('Skill: 代码审查 (review); read')
      expect(readFileSync(path, 'utf8')).toBe(raw)
    }
    /** 损坏的权威文件必须返回失败，不能输出缺少 Skill 的伪完整导出。 */
    writeFileSync(`${path}.skills.json`, '{broken')
    const failed = Bun.spawnSync([process.execPath, fileURLToPath(new URL('./index.ts', import.meta.url)),
      'session', 'export', path, '--stdout'], { cwd: root })
    expect(failed.exitCode).toBe(1)
    expect(failed.stdout.toString()).toBe('')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
