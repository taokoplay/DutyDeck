import { describe, expect, test } from 'bun:test'
import { formatCanvasErrorDiagnostic, parseCanvasErrorDiagnostic } from './canvas-error'

describe('画布错误的公开诊断边界', () => {
  test('Given 安全诊断附带内部信息 When 跨边界解析 Then 只返回公开字段并保持可读', () => {
    /** 额外路径、堆栈与正文不能随着可信诊断进入 UI。 */
    const diagnostic = parseCanvasErrorDiagnostic({
      stage: 'image-recovery', reason: 'access-denied', systemCode: 'WIN32_5', helperExitCode: 4,
      referenceId: '12345678-1234-4123-8123-123456789abc',
      path: 'C:\\Users\\private', stack: 'internal stack', message: 'secret-token',
    })
    expect(diagnostic).toEqual({
      stage: 'image-recovery', reason: 'access-denied', systemCode: 'WIN32_5', helperExitCode: 4,
      referenceId: '12345678-1234-4123-8123-123456789abc',
    })
    const text = formatCanvasErrorDiagnostic(diagnostic!)
    expect(text).toContain('图片采用恢复')
    expect(text).toContain('权限')
    expect(text).toContain('WIN32_5')
    expect(text).toContain('4')
    expect(text).not.toContain('private')
    expect(text).not.toContain('secret-token')
  })

  test('Given 旧信封或畸形诊断 When 解析 Then 兼容缺失且拒绝任意正文', () => {
    for (const value of [undefined, null, [], { stage: '/private/data', reason: 'unknown' },
      { stage: 'load', reason: 'secret-token' }, { stage: 'load', reason: 'unknown', systemCode: '/private/data' },
      { stage: 'load', reason: 'unknown', referenceId: 'session-123' },
      { stage: 'load', reason: 'helper-failed', helperExitCode: -1 },
      { stage: 'load', reason: 'unknown', logStatus: '/private/data' },
    ]) expect(parseCanvasErrorDiagnostic(value)).toBeUndefined()
  })

  test('Given 日志记录失败 When 格式化诊断 Then 不误报已保存', () => {
    const diagnostic = parseCanvasErrorDiagnostic({ stage: 'load', reason: 'unknown', logStatus: 'unavailable' })
    expect(diagnostic).toMatchObject({ logStatus: 'unavailable' })
    expect(formatCanvasErrorDiagnostic(diagnostic!)).toContain('详细日志未保存')
    expect(formatCanvasErrorDiagnostic(diagnostic!)).not.toContain('日志已保存')
  })
})
