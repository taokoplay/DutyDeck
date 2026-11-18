import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKUserMessage, SkillActivation } from '@dutydeck/shared'
import * as safeFile from './safe-file'
import * as projection from '../../../../../packages/session-core/src/skill-activation-projection'
import { parseSkillActivationStore } from '../../../../../packages/session-core/src/skill-activation-projection'
import { loadSkillActivationStore, removeSkillActivationStore } from './agent-skill-activation-store'

/** 独立临时目录及会话路径，测试不触碰业务数据。 */
let directory: string
let filePath: string
/** 构造未经路径投影的 SDK 用户消息；正文与 UUID 用于绑定旁车。 */
function user(text = '原始 /old/root/image.png', uuid = 'user-1'): SDKUserMessage {
  return { type: 'user', uuid, parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } }
}
/** 测试补记保留显式触发来源。 */
const explicit: SkillActivation = { slug: 'demo', name: 'Demo', sources: ['explicit'] }
/** 同一个 Skill 的实际读取来源，应与显式来源合并。 */
const read: SkillActivation = { ...explicit, sources: ['read'] }
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'skill-store-')); filePath = join(directory, 'session.jsonl') })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

describe('权威 Skill 补记旁车', () => {
  test('Given 没有旁车 When 读取旧内嵌消息 Then 原样返回且无磁盘副作用', () => {
    const target = { ...user(), skill_activations: [explicit] }
    const snapshot = loadSkillActivationStore(filePath)
    expect(snapshot.hasEntries).toBe(false)
    expect(snapshot.project(target)).toBe(target)
    snapshot.update(target, [explicit])
    removeSkillActivationStore(filePath)
    expect(readdirSync(directory)).toEqual([])
  })
  test('Given 新旧来源 When 补记 Then 合并展示且只持久化新增列表', () => {
    const target = { ...user(), skill_activations: [explicit] }
    const snapshot = loadSkillActivationStore(filePath)
    snapshot.update(target, [read])
    expect(snapshot.hasEntries).toBe(true)
    expect((snapshot.project(target) as SDKUserMessage).skill_activations?.[0]?.sources).toEqual(['explicit', 'read'])
    const stored = readFileSync(`${filePath}.skills.json`, 'utf8')
    expect(stored).not.toContain('原始')
    expect(stored).not.toContain('/old/root')
    expect(parseSkillActivationStore(JSON.parse(stored)).entries[0]?.additions).toEqual([read])
    expect(target.skill_activations).toEqual([explicit])
  })
  test('Given 同 UUID 异正文与迁移路径 When 投影 Then 不继承其他输入补记', () => {
    const snapshot = loadSkillActivationStore(filePath)
    snapshot.update(user(), [explicit])
    const altered = user('原始 /new/root/image.png')
    expect(snapshot.project(altered)).toBe(altered)
    expect((loadSkillActivationStore(filePath).project(user()) as SDKUserMessage).skill_activations).toEqual([explicit])
    snapshot.update(altered, [read])
    expect((snapshot.project(user()) as SDKUserMessage).skill_activations).toEqual([explicit])
    expect((snapshot.project(altered) as SDKUserMessage).skill_activations).toEqual([read])
  })
  test('Given 已提交补记 When 重复更新 Then 不写文件且快照可连续更新', () => {
    const snapshot = loadSkillActivationStore(filePath)
    snapshot.update(user(), [explicit])
    const before = statSync(`${filePath}.skills.json`)
    snapshot.update(user(), [explicit])
    expect(statSync(`${filePath}.skills.json`).mtimeMs).toBe(before.mtimeMs)
    expect(statSync(`${filePath}.skills.json`).ino).toBe(before.ino)
    snapshot.update(user(), [read])
    expect((snapshot.project(user()) as SDKUserMessage).skill_activations?.[0]?.sources).toEqual(['explicit', 'read'])
  })
  test('Given 两个读取快照 When 旧快照更新 Then CAS 拒绝并保留新快照', () => {
    const first = loadSkillActivationStore(filePath)
    const stale = loadSkillActivationStore(filePath)
    first.update(user(), [explicit])
    expect(() => stale.update(user(), [read])).toThrow()
    expect((loadSkillActivationStore(filePath).project(user()) as SDKUserMessage).skill_activations).toEqual([explicit])
  })
  test('Given 损坏或软链旁车 When 展示与修改 Then 展示回退而修改拒绝', () => {
    for (const bytes of ['{', '{"version":1,"entries":[{}]}']) {
      writeFileSync(`${filePath}.skills.json`, bytes)
      expect(() => loadSkillActivationStore(filePath)).toThrow()
      const snapshot = loadSkillActivationStore(filePath, { strict: false })
      const target = user()
      expect(snapshot.readError).toBeInstanceOf(Error)
      expect(snapshot.project(target)).toBe(target)
      expect(() => snapshot.update(target, [explicit])).toThrow()
      expect(readFileSync(`${filePath}.skills.json`, 'utf8')).toBe(bytes)
      removeSkillActivationStore(filePath)
    }
    writeFileSync(join(directory, 'outside'), '{}')
    symlinkSync(join(directory, 'outside'), `${filePath}.skills.json`)
    expect(loadSkillActivationStore(filePath, { strict: false }).readError).toBeInstanceOf(Error)
    expect(() => loadSkillActivationStore(filePath).update(user(), [explicit])).toThrow()
    expect(() => removeSkillActivationStore(filePath)).toThrow()
  })
  test('Given 崩溃残留临时文件 When 提交前后加载 Then 只认权威文件且删除后不复活', () => {
    writeFileSync(`${filePath}.skills.json.tmp`, '{"version":1,"entries":[]}')
    expect(loadSkillActivationStore(filePath).readError).toBeNull()
    loadSkillActivationStore(filePath).update(user(), [explicit])
    copyFileSync(`${filePath}.skills.json`, `${filePath}.skills.json.bak`)
    expect((loadSkillActivationStore(filePath).project(user()) as SDKUserMessage).skill_activations).toEqual([explicit])
    removeSkillActivationStore(filePath)
    expect(existsSync(`${filePath}.skills.json`)).toBe(false)
    const target = user()
    expect(loadSkillActivationStore(filePath).project(target)).toBe(target)
  })
  test('Given 可移植快照 When 复制会话和旁车 Then 不依赖 inode 或主文件路径', () => {
    loadSkillActivationStore(filePath).update(user(), [explicit])
    const movedPath = join(directory, 'moved.jsonl')
    copyFileSync(`${filePath}.skills.json`, `${movedPath}.skills.json`)
    expect((loadSkillActivationStore(movedPath).project(user()) as SDKUserMessage).skill_activations).toEqual([explicit])
  })
  test('Given 缺 UUID When 修改 Then 拒绝且不创建旁车', () => {
    expect(() => loadSkillActivationStore(filePath).update({ ...user(), uuid: undefined }, [explicit])).toThrow()
    expect(readdirSync(directory)).toEqual([])
  })
  test('Given 提交前崩溃 When 重载 Then 旧权威文件完整且不提升 staging', () => {
    const snapshot = loadSkillActivationStore(filePath)
    snapshot.update(user(), [explicit])
    const original = safeFile.writeJsonFileAtomicSecure
    const fault = spyOn(safeFile, 'writeJsonFileAtomicSecure').mockImplementation((path, data, options) =>
      original(path, data, { ...options, beforeRename: () => { throw new Error('模拟提交前崩溃') } }))
    try { expect(() => snapshot.update(user(), [read])).toThrow('模拟提交前崩溃') } finally { fault.mockRestore() }
    expect((loadSkillActivationStore(filePath).project(user()) as SDKUserMessage).skill_activations).toEqual([explicit])
    snapshot.update(user(), [read])
    expect(readdirSync(directory)).toEqual(['session.jsonl.skills.json'])
  })
  test('Given rename 后持久化报告失败 When 重载 Then 新权威快照仍完整且旧快照拒写', () => {
    const snapshot = loadSkillActivationStore(filePath)
    const original = safeFile.writeJsonFileAtomicSecure
    const fault = spyOn(safeFile, 'writeJsonFileAtomicSecure').mockImplementation((path, data, options) =>
      original(path, data, { ...options, syncDirectory: () => { throw new Error('模拟提交后崩溃') } }))
    try { expect(() => snapshot.update(user(), [explicit])).toThrow() } finally { fault.mockRestore() }
    expect((loadSkillActivationStore(filePath).project(user()) as SDKUserMessage).skill_activations).toEqual([explicit])
    expect(() => snapshot.update(user(), [read])).toThrow('快照冲突')
  })
  test('Given 有效 JSON 的不同属性顺序 When 解析 Then 接受可移植数据并隔离外部突变', () => {
    loadSkillActivationStore(filePath).update(user(), [explicit])
    const data = JSON.parse(readFileSync(`${filePath}.skills.json`, 'utf8')) as {
      version: 1
      entries: Array<{ uuid: string; contentDigest: string; additions: Array<{ slug: string; name: string; sources: string[] }> }>
    }
    data.entries[0] = { ...data.entries[0]!, additions: [{ sources: ['explicit'], name: 'Demo', slug: 'demo' }] }
    const parsed = parseSkillActivationStore(data)
    data.entries[0]!.additions[0]!.name = 'changed'
    expect(parsed.entries[0]?.additions[0]?.name).toBe('Demo')
  })
  test('Given 快照加载后目标变成软链 When 更新 Then 拒绝外部目标且内存投影无 IO', () => {
    const snapshot = loadSkillActivationStore(filePath)
    snapshot.update(user(), [explicit])
    rmSync(`${filePath}.skills.json`)
    writeFileSync(join(directory, 'outside'), '{}')
    symlinkSync(join(directory, 'outside'), `${filePath}.skills.json`)
    expect((snapshot.project(user()) as SDKUserMessage).skill_activations).toEqual([explicit])
    expect(() => snapshot.update(user(), [read])).toThrow()
    expect(readFileSync(join(directory, 'outside'), 'utf8')).toBe('{}')
  })

  test('Given 超过字节或记录预算 When 加载 Then 严格失败且展示回退', () => {
    writeFileSync(`${filePath}.skills.json`, ' '.repeat(projection.SKILL_ACTIVATION_STORE_MAX_BYTES + 1))
    expect(() => loadSkillActivationStore(filePath)).toThrow('字节预算')
    expect(loadSkillActivationStore(filePath, { strict: false }).hasEntries).toBe(false)
    expect(() => parseSkillActivationStore({ version: 1, entries: Array(projection.SKILL_ACTIVATION_STORE_MAX_ENTRIES + 1).fill(null) })).toThrow()
  })
  test('Given 相同 stamp 连续分页 When 加载 Then 只解析一次且外部写入使缓存失效', () => {
    loadSkillActivationStore(filePath).update(user(), [explicit])
    const parser = spyOn(projection, 'parseSkillActivationStore')
    try {
      loadSkillActivationStore(filePath)
      loadSkillActivationStore(filePath)
      expect(parser).toHaveBeenCalledTimes(1)
      writeFileSync(`${filePath}.skills.json`, '{')
      expect(() => loadSkillActivationStore(filePath)).toThrow()
      expect(parser).toHaveBeenCalledTimes(1)
    } finally { parser.mockRestore() }
  })

})
