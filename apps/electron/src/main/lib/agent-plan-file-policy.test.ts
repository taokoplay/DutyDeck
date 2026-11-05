import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isSessionPlanMarkdownPath, resolveSessionPlanDocument } from './agent-plan-file-policy'
import * as policy from './agent-plan-file-policy'

let root: string
let plan: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dutydeck-plan-policy-'))
  plan = join(root, 'plan')
  mkdirSync(plan)
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('计划写入路径', () => {
  test('Given 会话目录 When 创建与编辑 Markdown Then 允许且支持真实子目录', () => {
    const file = join(plan, '步骤.MD')
    expect(isSessionPlanMarkdownPath(file, plan, root)).toBe(true)
    writeFileSync(file, '# 计划')
    expect(isSessionPlanMarkdownPath(file, plan, root)).toBe(true)
    mkdirSync(join(plan, 'phase'))
    expect(isSessionPlanMarkdownPath(join(plan, 'phase', 'next.md'), plan, root)).toBe(true)
    expect(resolveSessionPlanDocument(file, plan, root)?.displayName).toBe('步骤.MD')
  })
  test('Given 项目文档、相对路径或不存在父目录 When 校验 Then 拒绝', () => {
    for (const file of ['plan/a.md', join(root, 'README.md'), join(plan, '..', 'outside.md'), join(plan, 'missing/a.md'), join(plan, 'code.ts'), plan]) {
      expect(isSessionPlanMarkdownPath(file, plan, root)).toBe(false)
    }
    expect(isSessionPlanMarkdownPath(join(plan, 'a.md'), undefined, root)).toBe(false)
  })
  test('Given 文件、目录或中间路径为符号链接 When 校验 Then 即便指回计划目录也拒绝', () => {
    mkdirSync(join(plan, 'real', 'nested'), { recursive: true })
    symlinkSync(join(plan, 'real'), join(plan, 'alias'))
    symlinkSync(join(plan, 'absent.md'), join(plan, 'dangling.md'))
    symlinkSync(plan, join(root, 'linked-plan'))
    expect(isSessionPlanMarkdownPath(join(plan, 'alias', 'nested', 'a.md'), plan, root)).toBe(false)
    expect(isSessionPlanMarkdownPath(join(plan, 'dangling.md'), plan, root)).toBe(false)
    expect(isSessionPlanMarkdownPath(join(root, 'linked-plan', 'a.md'), join(root, 'linked-plan'), root)).toBe(false)
  })
  test('Given Markdown 名称实际是目录 When 校验 Then 拒绝', () => {
    mkdirSync(join(plan, 'folder.md'))
    expect(isSessionPlanMarkdownPath(join(plan, 'folder.md'), plan, root)).toBe(false)
  })
})

for (const layout of ['root', 'legacy-context'] as const) {
  test(`Given ${layout} 工作台祖先为链接 When 创建计划或审批 Then 拒绝且不在外部创建 plan`, () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    const session = join(root, 'session')
    if (layout === 'root') symlinkSync(outside, session)
    else { mkdirSync(session); symlinkSync(outside, join(session, '.context')) }
    const planDir = join(session, ...(layout === 'root' ? [] : ['.context']), 'plan')
    expect(isSessionPlanMarkdownPath(join(planDir, 'x.md'), planDir, root)).toBe(false)
    expect(policy.ensureSessionPlanDirectory(planDir, root)).toBe(false)
    expect(existsSync(join(outside, 'plan'))).toBe(false)
    mkdirSync(join(outside, 'plan'))
    writeFileSync(join(outside, 'plan', 'x.md'), '# 外部')
    expect(isSessionPlanMarkdownPath(join(planDir, 'x.md'), planDir, root)).toBe(false)
    expect(resolveSessionPlanDocument(join(planDir, 'x.md'), planDir, root)).toBeUndefined()
  })
}
test('Given Pi 会归一化 Unicode 空格 When 检查路径 Then 拒绝语义可能变化的输入', () => {
  symlinkSync(join(root, 'outside.md'), join(plan, 'alias .md'))
  expect(isSessionPlanMarkdownPath(join(plan, 'alias\u00a0.md'), plan, root)).toBe(false)
})

test('Given 计划文件是硬链接 When 写入校验或绑定审批 Then 拒绝外部共享 inode', () => {
  const outside = join(root, 'outside.md')
  const file = join(plan, 'hardlink.md')
  writeFileSync(outside, '# 外部文档')
  linkSync(outside, file)
  expect(isSessionPlanMarkdownPath(file, plan, root)).toBe(false)
  expect(resolveSessionPlanDocument(file, plan, root)).toBeUndefined()
})
