import { describe, expect, test } from 'bun:test'
import { createCanvasLoadDiagnostic } from './canvas-load-error'

/** 只用于诊断关联，不复用业务 session、节点或操作身份。 */
const referenceId = '12345678-1234-4123-8123-123456789abc'

describe('画布加载失败诊断', () => {
  test('Given Windows helper 拒绝访问 When 生成诊断 Then 保留系统码与退出码且不泄露路径', () => {
    /** 模拟用户日志中的 helper 失败，并混入不应进入 Renderer 的路径。 */
    const error = new Error('稳定目录 helper 提前退出: code=4, signal=none, stderr=cannot open canvas transactions directory (mode=canvas-intent-list) [win32=5 ACCESS_DENIED] C:\\Users\\private\\canvas')
    expect(createCanvasLoadDiagnostic(error, 'image-recovery', referenceId)).toEqual({
      stage: 'image-recovery', reason: 'access-denied', systemCode: 'WIN32_5', helperExitCode: 4, referenceId,
    })
  })

  test.each([
    ['EACCES', 'access-denied'], ['ENOENT', 'missing-file'], ['ENOSPC', 'disk-full'],
    ['EBUSY', 'resource-busy'], ['EROFS', 'read-only'], ['ETIMEDOUT', 'timeout'],
  ] as const)('Given 包装过的 %s When 生成诊断 Then 显示 %s 原因', (code, reason) => {
    /** 验证标准 cause 链中的系统错误不会被上层恢复错误覆盖。 */
    const error = new Error('内部恢复包装', { cause: Object.assign(new Error('/private/data'), { code }) })
    expect(createCanvasLoadDiagnostic(error, 'content-load', referenceId)).toEqual({
      stage: 'content-load', reason, systemCode: code, referenceId,
    })
  })

  test('Given 恢复不确定 When 生成诊断 Then 保留稳定业务错误码且不携带业务身份', () => {
    expect(createCanvasLoadDiagnostic(new Error('CANVAS_RECOVERY_REQUIRED: /private/data session-123'), 'agent-recovery', referenceId)).toEqual({
      stage: 'agent-recovery', reason: 'recovery-required', systemCode: 'CANVAS_RECOVERY_REQUIRED', referenceId,
    })
  })

  test('Given helper 缺失 When 生成诊断 Then 明确为安装文件缺失并过滤安装路径', () => {
    expect(createCanvasLoadDiagnostic(new Error('稳定目录 helper 不存在: C:\\Users\\private\\helper.exe'), 'content-load', referenceId)).toEqual({
      stage: 'content-load', reason: 'helper-unavailable', referenceId,
    })
  })

  test('Given 未知值或循环 cause When 生成诊断 Then 有界返回日志编号且不泄露任意正文', () => {
    /** 循环错误链必须有界，不让错误处理自身挂死。 */
    const cyclic = new Error('secret-token /private/data')
    cyclic.cause = cyclic
    for (const error of [cyclic, null, 5, 'secret-token', { message: '/private/data', code: 'SECRET_TOKEN' }]) {
      expect(createCanvasLoadDiagnostic(error, 'load', referenceId)).toEqual({ stage: 'load', reason: 'unknown', referenceId })
    }
  })
})
