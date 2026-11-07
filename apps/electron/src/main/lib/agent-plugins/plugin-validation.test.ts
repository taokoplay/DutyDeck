import { describe, expect, test } from 'bun:test'
import { assessPluginValidation, assessSourceConversions } from './plugin-validation'
import type { PluginValidationRecord, PluginValidationEnvironment } from '@dutydeck/shared'

const environment: PluginValidationEnvironment = { hostVersion: '0.20.20', hostBuildSha256: '9'.repeat(64), platform: 'darwin', arch: 'arm64', electron: '43.2.0', adapterVersion: '0.1.0', adapterSha256: 'a'.repeat(64) }
const identity = { pluginId: 'acme.calc', pluginVersion: '1.0.0', packageHash: 'b'.repeat(64) }
const record: PluginValidationRecord = {
  formatVersion: 1, ...identity, environment,
  source: { name: 'dsh-calc', version: '1.2.3', url: 'https://registry.npmjs.org/dsh-calc/-/dsh-calc-1.2.3.tgz', archiveSha256: 'c'.repeat(64), license: 'MIT' },
  testedAt: '2026-11-06T14:23:38.427Z', expiresAt: '2026-12-06T14:23:38.427Z',
  result: 'passed', scope: 'isolated-developer-smoke', resultSha256: 'd'.repeat(64), buildEvidenceSha256: 'e'.repeat(64),
  limitations: ['不是生产信任或 OS 沙箱认证。'],
}
const now = new Date('2026-11-07T01:00:00Z')

describe('Given 宿主维护而非插件自报的兼容验证记录', () => {
  test('When 缺少当前或历史宿主构建指纹 Then 仅保留历史结果不能标为当前通过', () => {
    const unknown = { ...environment, hostBuildSha256: undefined }
    expect(assessPluginValidation(identity, unknown, [record], now)).toMatchObject({ status: 'stale', reasons: expect.arrayContaining(['HOST_BUILD_UNVERIFIED']) })
    expect(assessPluginValidation(identity, environment, [{ ...record, environment: unknown }], now).status).toBe('stale')
  })
  test('When 精确身份/环境匹配且未过期 Then 仅声明限定范围通过', () => {
    expect(assessPluginValidation(identity, environment, [record], now)).toMatchObject({ status: 'validated', record, reasons: [] })
  })
  test('When 来源精确匹配 Then 关联派生证据；同名不同版本/hash/URL不能关联', () => {
    const source = record.source
    expect(assessSourceConversions(source, environment, [record], now)[0]?.status).toBe('validated')
    for (const changed of [{ version: '1.2.4' }, { archiveSha256: 'f'.repeat(64) }, { url: 'https://other.example/pkg.tgz' }]) {
      expect(assessSourceConversions({ ...source, ...changed }, environment, [record], now)).toEqual([])
    }
  })
  test('When 没有证据或只同名 Then 不从包名或目录猜测兼容', () => {
    expect(assessPluginValidation(identity, environment, [], now).status).toBe('unassessed')
    expect(assessPluginValidation({ ...identity, pluginId: 'acme.other' }, environment, [record], now).record).toBeUndefined()
  })
  test('When 包hash/版本变化 Then 回到待验证且保留旧证据说明', () => {
    for (const changed of [{ packageHash: 'f'.repeat(64) }, { pluginVersion: '1.0.1' }]) {
      expect(assessPluginValidation({ ...identity, ...changed }, environment, [record], now)).toMatchObject({ status: 'stale', reasons: expect.arrayContaining(['PACKAGE_IDENTITY_CHANGED']) })
    }
  })
  test('When 宿主/平台/架构/Electron/适配器任一变化 Then 不继承verified', () => {
    for (const [key, value] of Object.entries(environment)) {
      expect(assessPluginValidation(identity, { ...environment, [key]: `${value}-changed` }, [record], now).status).toBe('stale')
    }
  })
  test('When 过期、未来测试时间或失败记录 Then 不显示通过', () => {
    expect(assessPluginValidation(identity, environment, [record], new Date(record.expiresAt)).reasons).toContain('EVIDENCE_EXPIRED')
    expect(assessPluginValidation(identity, environment, [record], new Date('2026-11-01')).status).toBe('stale')
    expect(assessPluginValidation(identity, environment, [{ ...record, result: 'failed' }], now).status).toBe('failed')
  })
  test('When 存在更晚失败记录 Then 不能回退选择旧成功记录', () => {
    const failed = { ...record, result: 'failed' as const, testedAt: '2026-11-06T15:00:00Z' }
    expect(assessPluginValidation(identity, environment, [record, failed], now).status).toBe('failed')
  })
  test('When 证据缺失来源hash或时间非法 Then 拒绝作为验证依据', () => {
    for (const invalid of [{ ...record, testedAt: 'invalid' }, { ...record, source: { ...record.source, archiveSha256: '' } }]) {
      expect(assessPluginValidation(identity, environment, [invalid], now).status).toBe('unassessed')
    }
  })
})
