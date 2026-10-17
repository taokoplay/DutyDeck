import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  validateReleaseNotes,
  validateReleaseVersion,
} from './validate-release-version'

describe('发布版本前置校验', () => {
  test('Given 独立标签与版本一致 When 校验 Then 返回 DutyDeck Release 输出', () => {
    expect(validateReleaseVersion('0.20.0', 'v0.20.0')).toEqual({
      version: '0.20.0',
      upstreamVersion: '',
      boneBuild: '',
      releaseTitle: 'DutyDeck 0.20.0',
    })
  })

  test('Given 标签与版本一致 When 校验 Then 返回 Actions outputs', () => {
    expect(validateReleaseVersion('0.17.42-bone.5', 'v0.17.42-bone.5')).toEqual({
      version: '0.17.42-bone.5',
      upstreamVersion: '0.17.42',
      boneBuild: '5',
      releaseTitle: 'DutyDeck 0.17.42 · Bone 5',
    })
  })

  test('Given 标签错误 When 校验 Then 在构建前失败', () => {
    expect(() => validateReleaseVersion('0.17.42-bone.5', 'v0.17.42-bone.4'))
      .toThrow('发布标签 v0.17.42-bone.4 与应用版本 0.17.42-bone.5 不一致')
  })

  test('Given 独立标准 SemVer When 校验 Then 允许脱离 Bone 后的版本', () => {
    expect(() => validateReleaseVersion('0.17.42', 'v0.17.42'))
      .not.toThrow()
  })

  test('Given 版本标签不一致 When 校验 Then 在构建前失败', () => {
    expect(() => validateReleaseVersion('0.20.0', 'v0.20.1'))
      .toThrow('发布标签 v0.20.1 与应用版本 0.20.0 不一致')
  })

  test('Given 对应 Bone 说明存在 When 校验 Then 返回仓库相对路径', () => {
    /** 本测试独立使用的临时仓库根目录。 */
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'proma-release-notes-'))
    /** 当前标签对应的版本说明目录。 */
    const notesDirectory = join(repositoryRoot, 'release-notes', 'bone')
    mkdirSync(notesDirectory, { recursive: true })
    writeFileSync(join(notesDirectory, 'v0.17.55-bone.1.md'), '# 更新内容\n\n- 新增版本说明。\n')

    expect(validateReleaseNotes('v0.17.55-bone.1', repositoryRoot))
      .toBe('release-notes/bone/v0.17.55-bone.1.md')
  })

  test('Given 对应 Bone 说明缺失 When 校验 Then 在构建前失败', () => {
    /** 不包含版本说明的临时仓库根目录。 */
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'proma-release-notes-'))

    expect(() => validateReleaseNotes('v0.17.55-bone.1', repositoryRoot))
      .toThrow('缺少 DutyDeck 版本说明：release-notes/bone/v0.17.55-bone.1.md')
  })

  test('Given 对应 Bone 说明为空 When 校验 Then 在构建前失败', () => {
    /** 本测试独立使用的临时仓库根目录。 */
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'proma-release-notes-'))
    /** 当前标签对应的版本说明目录。 */
    const notesDirectory = join(repositoryRoot, 'release-notes', 'bone')
    mkdirSync(notesDirectory, { recursive: true })
    writeFileSync(join(notesDirectory, 'v0.17.55-bone.1.md'), '  \n')

    expect(() => validateReleaseNotes('v0.17.55-bone.1', repositoryRoot))
      .toThrow('DutyDeck 版本说明不能为空：release-notes/bone/v0.17.55-bone.1.md')
  })

  test('Given 独立版本说明存在 When 校验 Then 使用顶层说明路径', () => {
    /** 本测试独立使用的临时仓库根目录。 */
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'dutydeck-release-notes-'))
    mkdirSync(join(repositoryRoot, 'release-notes'), { recursive: true })
    writeFileSync(join(repositoryRoot, 'release-notes', 'v0.20.0.md'), '# DutyDeck 0.20.0\n')

    expect(validateReleaseNotes('v0.20.0', repositoryRoot)).toBe('release-notes/v0.20.0.md')
  })
})
