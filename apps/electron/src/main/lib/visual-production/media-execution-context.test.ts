import { describe, expect, test } from 'bun:test'
import { assertVisualMediaOrigin, visualMediaExecutionContext, visualMediaOrigin } from './media-execution-context'
import type { MediaRunOrigin } from '../media/media-run-service'

/** 普通会话来源由媒体工具生成，参数没有选择调用者的能力。 */
const origin: MediaRunOrigin = { actor: { sessionId: 'session', runStartedAt: 1, mode: 'project-agent' } }
/** 两个作品任务共享会话但必须保持独立归属。 */
const binding = { sessionId: 'session', productionId: 'production', jobId: 'job', baseRevision: 1 }
describe('ComfyUI 可信影像执行上下文', () => {
  test('Given 无影像上下文 When 准备或执行普通任务 Then 原行为不变', () => {
    expect(visualMediaOrigin(origin, 'session')).toBe(origin)
    expect(() => assertVisualMediaOrigin(origin, 'session')).not.toThrow()
  })
  test('Given 影像任务 When 异步准备执行 Then 冻结身份且离开上下文后不能再启动', async () => {
    const frozen = await visualMediaExecutionContext.run(binding, async () => {
      await Promise.resolve()
      const result = visualMediaOrigin(origin, 'session')
      expect(result.visualProduction).toEqual({ productionId: 'production', jobId: 'job', baseRevision: 1 })
      assertVisualMediaOrigin(result, 'session')
      return result
    })
    expect(() => assertVisualMediaOrigin(frozen, 'session')).toThrow('MEDIA_VISUAL_BINDING_REQUIRED')
    expect(() => visualMediaExecutionContext.run({ ...binding, jobId: 'other' }, () => assertVisualMediaOrigin(frozen, 'session'))).toThrow()
    expect(() => visualMediaExecutionContext.run(binding, () => assertVisualMediaOrigin(frozen, 'other-session'))).toThrow()
  })
  test('Given 并发任务 When 异步交错 Then 不串用制作身份', async () => {
    const results = await Promise.all(['one', 'two'].map(jobId => visualMediaExecutionContext.run({ ...binding, jobId }, async () => {
      await Promise.resolve()
      const frozen = visualMediaOrigin(origin, 'session')
      assertVisualMediaOrigin(frozen, 'session')
      return frozen.visualProduction?.jobId
    })))
    expect(results).toEqual(['one', 'two'])
  })
})
