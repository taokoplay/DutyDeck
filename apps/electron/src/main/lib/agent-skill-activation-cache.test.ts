import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SkillActivation } from '@dutydeck/shared'
import { SkillActivationNoopCache, skillActivationFileStamp } from './agent-skill-activation-cache'

/** 每项测试只使用独立临时文件，退出时移除合成数据。 */
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
/** 创建合法的合成 JSONL，返回其隔离路径。 */
function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'skill-noop-'))
  directories.push(directory)
  const path = join(directory, 'session.jsonl')
  writeFileSync(path, '{"type":"user","uuid":"input","message":{"content":"合成输入"}}\n')
  return path
}
/** 构造合法 Skill，允许验证来源合并与路径升级。 */
function skill(sources: SkillActivation['sources'] = ['explicit']): SkillActivation {
  return { slug: 'demo', name: 'demo', sources }
}

describe('已验证 Skill 激活的无变化快路径', () => {
  test('Given 尚未验证或重启 When 请求重复激活 Then 不跳过权威读取', () => {
    const path = fixture()
    expect(new SkillActivationNoopCache().matches(path, 'input', [skill()])).toBe(false)
  })
  test('Given 完整验证的文件版本 When 重复或子集激活 Then 命中且不改写正文', () => {
    const path = fixture()
    const cache = new SkillActivationNoopCache()
    const original = readFileSync(path)
    cache.remember(path, 'input', [skill(['explicit', 'read'])], skillActivationFileStamp(path))
    expect(cache.matches(path, 'input', [skill()])).toBe(true)
    expect(readFileSync(path)).toEqual(original)
    expect(cache.matches(path, 'other-input', [skill()])).toBe(false)
  })
  test('Given 已有激活 When 新增来源、路径、名字或模块身份 Then 必须执行原合并写入', () => {
    const path = fixture()
    const cache = new SkillActivationNoopCache()
    cache.remember(path, 'input', [skill()], skillActivationFileStamp(path))
    for (const activation of [skill(['read']), { ...skill(), filePath: '/demo/SKILL.md' },
      { ...skill(), name: '演示' }, { ...skill(), moduleId: 'module', moduleVersion: '1', activationMode: 'invoke' as const }]) {
      expect(cache.matches(path, 'input', [activation])).toBe(false)
    }
  })
  test('Given 调用方随后修改对象 When 重复请求 Then 缓存保留验证时的值', () => {
    const path = fixture()
    const cache = new SkillActivationNoopCache()
    const activation = skill()
    cache.remember(path, 'input', [activation], skillActivationFileStamp(path))
    activation.sources.push('read')
    expect(cache.matches(path, 'input', [skill(['read'])])).toBe(false)
  })
  test('Given 追加、原子替换、原地损坏或删除 When 查缓存 Then 不命中旧版本', () => {
    for (const mutate of [
      (path: string) => appendFileSync(path, '{}\n'),
      (path: string) => { writeFileSync(`${path}.replacement`, readFileSync(path)); renameSync(`${path}.replacement`, path) },
      (path: string) => { const bytes = readFileSync(path); bytes[0] = 33; writeFileSync(path, bytes) },
      (path: string) => unlinkSync(path),
    ]) {
      const path = fixture()
      const cache = new SkillActivationNoopCache()
      cache.remember(path, 'input', [skill()], skillActivationFileStamp(path))
      mutate(path)
      expect(cache.matches(path, 'input', [skill()])).toBe(false)
    }
  })
  test('Given 验证期间文件改变 When 记忆旧快照 Then 拒绝发布', () => {
    const path = fixture()
    const cache = new SkillActivationNoopCache()
    const stamp = skillActivationFileStamp(path)
    appendFileSync(path, '{}\n')
    cache.remember(path, 'input', [skill()], stamp)
    expect(cache.matches(path, 'input', [skill()])).toBe(false)
  })
  test('Given 条目数或总字节超过预算 When 添加记忆 Then 淘汰旧项且大条目不缓存', () => {
    const path = fixture()
    const cache = new SkillActivationNoopCache({ maxEntries: 1, maxBytes: 1024 })
    cache.remember(path, 'one', [skill()], skillActivationFileStamp(path))
    cache.remember(path, 'two', [skill()], skillActivationFileStamp(path))
    expect(cache.matches(path, 'one', [skill()])).toBe(false)
    expect(cache.matches(path, 'two', [skill()])).toBe(true)
    const huge = { ...skill(), name: 'x'.repeat(2048) }
    cache.remember(path, 'huge', [huge], skillActivationFileStamp(path))
    expect(cache.matches(path, 'huge', [huge])).toBe(false)
  })
})
