import { describe, expect, test } from 'bun:test'
import {
  assertReleaseTag,
  assertBoneReleaseTag,
  createReleaseTitle,
  createBoneReleaseTitle,
  parseReleaseVersion,
  parseBoneReleaseVersion,
} from './release-version'

test('独立 DutyDeck 版本使用标准 SemVer', () => {
  expect(parseReleaseVersion('0.20.0')).toEqual({
    fullVersion: '0.20.0',
    major: 0,
    minor: 20,
    patch: 0,
  })
  expect(assertReleaseTag('0.20.0', 'v0.20.0').fullVersion).toBe('0.20.0')
  expect(createReleaseTitle('0.20.0')).toBe('DutyDeck 0.20.0')
})

test('独立版本解析器拒绝 Bone 后缀与预发布标签', () => {
  expect(parseReleaseVersion('0.20.0-bone.1')).toBeNull()
  expect(parseReleaseVersion('0.20.0-rc.1')).toBeNull()
})

describe('Bone 发布版本', () => {
  test('Given 合法 Bone SemVer When 解析 Then 返回官方版本与构建号', () => {
    expect(parseBoneReleaseVersion('0.17.42-bone.5')).toEqual({
      fullVersion: '0.17.42-bone.5',
      upstreamVersion: '0.17.42',
      boneBuild: 5,
    })
  })

  test.each(['0.17.42', '0.17.42-bone.0', '0.17.42-bone.05', 'v0.17.42-bone.5'])(
    'Given 非法发布版本 %s When 解析 Then 返回 null',
    (version) => expect(parseBoneReleaseVersion(version)).toBeNull(),
  )

  test('Given 标签与应用版本一致 When 校验 Then 返回解析结果', () => {
    expect(assertBoneReleaseTag('0.17.42-bone.5', 'v0.17.42-bone.5').boneBuild).toBe(5)
  })

  test('Given 标签与应用版本不一致 When 校验 Then 给出明确错误', () => {
    expect(() => assertBoneReleaseTag('0.17.42-bone.5', 'v0.17.42-bone.4'))
      .toThrow('发布标签 v0.17.42-bone.4 与应用版本 0.17.42-bone.5 不一致')
  })

  test('Given Bone 版本 When 生成标题 Then 同时显示官方版本和构建号', () => {
    expect(createBoneReleaseTitle('0.17.42-bone.5')).toBe('DutyDeck 0.17.42 · Bone 5')
  })
})
