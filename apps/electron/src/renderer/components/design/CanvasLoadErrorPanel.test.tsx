import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CanvasLoadErrorPanel, formatCanvasLoadError } from './CanvasLoadErrorPanel'

test('Given Windows 加载诊断 When 渲染面板 Then 完整显示错误码与原因并提供复制重试', () => {
  /** 诊断字段与主进程白名单合同一致。 */
  const error = { code: 'CANVAS_LOAD_FAILED', message: '画布暂时无法加载。', diagnostic: {
    stage: 'content-load', reason: 'access-denied', systemCode: 'EACCES', helperExitCode: 4,
  } } as const
  /** 静态渲染同时检查可访问反馈与窄面板换行约束。 */
  const markup = renderToStaticMarkup(<CanvasLoadErrorPanel error={error} onRetry={() => undefined} />)
  expect(markup).toContain('role="alert"')
  expect(markup).toContain('EACCES')
  expect(markup).toContain('CANVAS_LOAD_FAILED')
  expect(markup).toContain('复制诊断信息')
  expect(markup).toContain('重试')
  expect(markup).toContain('whitespace-pre-wrap')
  expect(markup).not.toContain('truncate')
  expect(formatCanvasLoadError(error)).toContain('EACCES')
})

test('Given 旧版无诊断信封 When 显示 Then 保留公开消息并说明暂无诊断', () => {
  expect(formatCanvasLoadError({ code: 'CANVAS_LOAD_FAILED', message: '画布暂时无法加载。' }))
    .toContain('暂无详细诊断')
})
