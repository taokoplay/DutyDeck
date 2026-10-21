import { afterEach, describe, expect, test } from 'bun:test'
import { createUnavailableMediaToolRun, getMediaToolProviderRuntime, registerMediaToolProviderRuntime } from './media-tool-runtime'

/** 每项测试只持有自己注册代次的清理函数。 */
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

describe('共享媒体宿主入口', () => {
  test('Given 两次注册 When 旧代次清理 Then 新入口仍可调用且最后清理恢复未就绪', () => {
    /** 注册占位只用于验证宿主生命周期，不创建供应商任务。 */
    const first = { createRun: () => createUnavailableMediaToolRun('MEDIA_SERVICE_UNAVAILABLE') }
    const second = { createRun: () => createUnavailableMediaToolRun('MEDIA_PROJECT_REQUIRED') }
    const disposeFirst = registerMediaToolProviderRuntime(first)
    const disposeSecond = registerMediaToolProviderRuntime(second)
    cleanups.push(disposeFirst, disposeSecond)
    disposeFirst()
    expect(getMediaToolProviderRuntime()).toBe(second)
    disposeSecond()
    expect(getMediaToolProviderRuntime()).toBeUndefined()
  })

  test.each(['MEDIA_PROJECT_REQUIRED', 'MEDIA_SERVICE_UNAVAILABLE'] as const)(
    'Given %s When 普通对话查询目录 Then 返回明确诊断且不提供收费执行工具', async (code) => {
      /** 不可用时仍给模型一个真实目录入口，防止猜测或读取渠道文件。 */
      const run = createUnavailableMediaToolRun(code)
      expect(run.allowedToolNames).toEqual(['media_list_models'])
      const result = await run.piCustomTools[0]!.execute('call', {} as never, undefined as never, undefined as never, undefined as never)
      expect(result.details).toMatchObject({ models: [], nextOffset: null, error: { code } })
      expect(run.systemPromptAppend).toContain('不要读取渠道配置')
      expect(JSON.stringify(result)).not.toContain('apiKey')
    },
  )
})
