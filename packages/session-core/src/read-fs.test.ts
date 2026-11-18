import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, truncateSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKUserMessage } from '@dutydeck/shared'
import { readSessionMessages } from './read-fs'
import { mergeSkillActivationStore, SKILL_ACTIVATION_STORE_MAX_BYTES } from './skill-activation-projection'
import { groupIntoTurns } from './group'
import { toTranscript } from './transcript'
import { renderTranscriptMarkdown } from './render-markdown'

/** 隔离磁盘夹具，测试结束仅回收自身临时目录。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
/** 创建原始用户输入和旁车；返回路径及原文字节用于验证只读语义。 */
function fixture() {
  /** 每例单独分配数据根。 */
  const root = mkdtempSync(join(tmpdir(), 'session-skills-read-'))
  roots.push(root)
  /** 使用真实 SDK 用户消息，旧内嵌来源必须保留。 */
  const message: SDKUserMessage = { type: 'user', uuid: 'input-1', message: { content: [{ type: 'text', text: '测试输入' }] }, parent_tool_use_id: null,
    skill_activations: [{ slug: 'review', name: '代码审查', sources: ['explicit'] }] }
  /** 复用共享生成器，测试不复制摘要和磁盘格式算法。 */
  const store = mergeSkillActivationStore({ version: 1, entries: [] }, message,
    [{ slug: 'review', name: '代码审查', sources: ['read'] }])
  /** JSONL 保留 CRLF 和末尾空行以检查字节未被重写。 */
  const raw = JSON.stringify(message) + '\r\n\r\n'
  /** 模拟可移动文件路径，不依赖全局用户目录。 */
  const path = join(root, 'session.jsonl')
  writeFileSync(path, raw)
  writeFileSync(`${path}.skills.json`, JSON.stringify(store))
  return { root, path, raw, message }
}

describe('Node 会话读取与导出 Skill 旁车', () => {
  test('Given 内嵌与旁车 Skill When 磁盘读取及 Markdown 导出 Then 合并来源且 JSONL 字节不变', () => {
    /** 合并路径通过实际 Node reader 与 Markdown renderer。 */
    const { path, raw } = fixture()
    const messages = readSessionMessages(path)
    expect((messages[0] as SDKUserMessage).skill_activations?.[0]?.sources).toEqual(['explicit', 'read'])
    const markdown = renderTranscriptMarkdown(toTranscript(groupIntoTurns(messages)))
    expect(markdown).toContain('代码审查')
    expect(markdown).toContain('explicit, read')
    expect(readFileSync(path, 'utf8')).toBe(raw)
  })
  test('Given 无旁车旧会话 When 读取 Then 保留原内嵌 Skill', () => {
    const { path, message } = fixture()
    rmSync(`${path}.skills.json`)
    expect(readSessionMessages(path)).toEqual([message])
  })
  test('Given 同 UUID 正文已变化 When 读取 Then 不继承旧旁车 Skill', () => {
    const { path, message } = fixture()
    writeFileSync(path, JSON.stringify({ ...message, message: { content: '另一条输入' } }))
    expect((readSessionMessages(path)[0] as SDKUserMessage).skill_activations?.[0]?.sources).toEqual(['explicit'])
  })
  test('Given 损坏权威旁车 When 读取 Then 明确失败且不重写源文件', () => {
    const { path, raw } = fixture()
    writeFileSync(`${path}.skills.json`, '{broken')
    expect(() => readSessionMessages(path)).toThrow()
    expect(readFileSync(path, 'utf8')).toBe(raw)
  })
})


describe('Node 旁车有界读取', () => {
  test('Given 超预算稀疏文件 When 读取 Then 分配旁车缓冲区前失败并报告路径', () => {
    const { path } = fixture()
    truncateSync(`${path}.skills.json`, SKILL_ACTIVATION_STORE_MAX_BYTES + 1)
    /** 直接记录分配动作，防止先读全文件再检查预算的回退。 */
    const allocate = spyOn(Buffer, 'alloc')
    try {
      expect(() => readSessionMessages(path)).toThrow('超过字节预算')
      expect(allocate).not.toHaveBeenCalled()
      expect(() => readSessionMessages(path)).toThrow(`${path}.skills.json`)
    } finally { allocate.mockRestore() }
  })
  test('Given 恰好预算大小的合法旁车 When 读取 Then 成功投影', () => {
    const { path } = fixture()
    const bytes = readFileSync(`${path}.skills.json`)
    writeFileSync(`${path}.skills.json`, Buffer.concat([bytes, Buffer.alloc(SKILL_ACTIVATION_STORE_MAX_BYTES - bytes.length, ' ')]))
    expect((readSessionMessages(path)[0] as SDKUserMessage).skill_activations?.[0]?.sources).toEqual(['explicit', 'read'])
  })
  for (const dangling of [false, true]) {
    test(`Given ${dangling ? '悬空' : '有效'}软链旁车 When 读取 Then 明确拒绝而非忽略或跟随`, () => {
      const { root, path } = fixture()
      const target = join(root, 'target.json')
      if (!dangling) writeFileSync(target, readFileSync(`${path}.skills.json`))
      rmSync(`${path}.skills.json`)
      symlinkSync(target, `${path}.skills.json`)
      expect(() => readSessionMessages(path)).toThrow('普通文件')
      expect(() => readSessionMessages(path)).toThrow(`${path}.skills.json`)
    })
  }
  test('Given 旁车是目录或损坏 JSON When 读取 Then 错误包含旁车路径', () => {
    const { path } = fixture()
    writeFileSync(`${path}.skills.json`, '{broken')
    expect(() => readSessionMessages(path)).toThrow(`${path}.skills.json`)
    rmSync(`${path}.skills.json`)
    mkdirSync(`${path}.skills.json`)
    expect(() => readSessionMessages(path)).toThrow('普通文件')
  })
  test('Given 读取权限失败 When 读取 Then 错误可见且不当作缺失旁车', () => {
    const { path } = fixture()
    /** 模拟拒绝打开旁车，避免测试依赖运行账户是否可绕过 chmod。 */
    const original = fs.openSync
    const open = spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (args[0] === `${path}.skills.json`) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      return original(...args)
    })
    try { expect(() => readSessionMessages(path)).toThrow('permission denied') } finally { open.mockRestore() }
  })

  test('Given lstat 后旁车被替换为软链 When 打开 Then 拒绝读取替换目标', () => {
    /** 模拟检查和打开之间的文件系统置换。 */
    const { root, path } = fixture()
    const target = join(root, 'replacement.json')
    writeFileSync(target, readFileSync(`${path}.skills.json`))
    const original = fs.openSync
    const open = spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (args[0] === `${path}.skills.json`) {
        rmSync(`${path}.skills.json`)
        symlinkSync(target, `${path}.skills.json`)
      }
      return original(...args)
    })
    try { expect(() => readSessionMessages(path)).toThrow(`${path}.skills.json`) } finally { open.mockRestore() }
  })

  test('Given 打开后旁车增长 When 有界读取 Then 拒绝快照并关闭描述符', () => {
    const { path } = fixture()
    /** 记录真实旁车描述符，避免影响 JSONL 的正常读取。 */
    let sidecarDescriptor: number | undefined
    const originalOpen = fs.openSync
    const originalRead = fs.readSync
    const open = spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const descriptor = originalOpen(...args)
      if (args[0] === `${path}.skills.json`) sidecarDescriptor = descriptor
      return descriptor
    })
    /** 保留 Node 两种 readSync 签名，在首次正文读取边界模拟并发增长。 */
    function readWithGrowth(fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition | null): number
    function readWithGrowth(fd: number, buffer: NodeJS.ArrayBufferView, options?: fs.ReadOptions): number
    function readWithGrowth(fd: number, buffer: NodeJS.ArrayBufferView, offsetOrOptions?: number | fs.ReadOptions, length?: number, position?: fs.ReadPosition | null): number {
      if (fd === sidecarDescriptor) fs.appendFileSync(`${path}.skills.json`, ' ')
      return typeof offsetOrOptions === 'number'
        ? originalRead(fd, buffer, offsetOrOptions, length!, position ?? null)
        : originalRead(fd, buffer, offsetOrOptions)
    }
    const read = spyOn(fs, 'readSync').mockImplementation(readWithGrowth)
    const close = spyOn(fs, 'closeSync')
    try {
      expect(() => readSessionMessages(path)).toThrow('读取冲突或超过预算')
      expect(close).toHaveBeenCalledWith(sidecarDescriptor)
    } finally { open.mockRestore(); read.mockRestore(); close.mockRestore() }
  })
})
