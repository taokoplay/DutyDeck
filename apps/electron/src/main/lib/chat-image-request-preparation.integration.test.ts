import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'

/** 独立子进程隔离 Electron/网络宿主替身，保留真实 Chat 编排、预览和 Provider 请求构建。 */
function runChatScenario(scenario: string): void {
  /** 场景脚本只运行内存请求，不调用远端模型或写入真实会话。 */
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    import sharp from 'sharp'
    import * as core from '@dutydeck/core'
    const scenario = process.env.CHAT_IMAGE_TEST_SCENARIO
    const image = (await sharp({ create: { width: 2000, height: 1200, channels: 3, background: 'red' } }).png().toBuffer()).toString('base64')
    const attachment = { id: 'original', filename: 'original.png', mediaType: 'image/png', localPath: 'original.png', size: image.length }
    const previous = { ...attachment, id: 'previous' }
    const history = [{ id: 'h', role: 'user', content: '原图参考', createdAt: 1, attachments: [previous] }]
    const saved = []
    const events = []
    const loggedErrors = []
    console.error = (...args) => { for (const argument of args) if (argument instanceof Error) loggedErrors.push(argument.message) }
    const bodies = []
    const toolContexts = []
    let stop
    let calls = 0
    mock.module('./src/main/lib/token-usage-observer', () => ({ createTokenUsageObserver: () => undefined }))
    mock.module('./src/main/lib/token-usage-context', () => ({ chatTokenUsageContext: () => ({}) }))
    mock.module('./src/main/lib/token-usage-recorder', () => ({ recordTokenUsage: () => {} }))
    mock.module('./src/main/lib/channel-manager', () => ({ listChannels: () => [{ id: 'channel', provider: 'openai', baseUrl: 'https://example.test', name: 'test' }], resolveChannelRuntimeApiKey: async () => 'test' }))
    mock.module('./src/main/lib/conversation-manager', () => ({ getConversationMessages: () => history, appendMessage: (_id, message) => saved.push(message), updateConversationMeta: () => {} }))
    mock.module('./src/main/lib/attachment-service', () => ({ isImageAttachment: (mime) => mime.startsWith('image/'), readAttachmentAsBase64: () => { if (scenario === 'cancel') stop('c'); return scenario === 'image-invalid' ? 'not-an-image' : image } }))
    mock.module('./src/main/lib/document-parser', () => ({ isDocumentAttachment: () => false, extractTextFromAttachment: async () => '' }))
    mock.module('./src/main/lib/proxy-settings-service', () => ({ getEffectiveProxyUrl: async () => undefined }))
    mock.module('./src/main/lib/chat-tool-registry', () => ({ getEnabledTools: () => ({ tools: [], systemPromptAppend: '' }) }))
    mock.module('./src/main/lib/chat-tool-executor', () => ({ executeToolCalls: async (_calls, context) => { toolContexts.push(context); return [{ toolCallId: 't', content: scenario === 'tool-budget' ? 'x'.repeat(17 * 1024 * 1024) : '完成' }] } }))
    mock.module('@dutydeck/core', () => ({ ...core, streamSSE: async ({ request, onEvent }) => {
      calls++
      bodies.push(request.body)
      if (calls === 1) return { content: '', toolCalls: [{ id: 't', name: 'generate_image', arguments: '{}' }], stopReason: 'tool_use' }
      onEvent({ type: 'chunk', delta: '完成' })
      return { content: '完成', toolCalls: [], stopReason: 'end_turn' }
    } }))
    // 实际 streamSSE 不使用替身 fetch，但宿主依然会获取该函数。
    mock.module('./src/main/lib/proxy-fetch', () => ({ getFetchFn: () => async () => { throw new Error('禁止网络') } }))
    const service = await import('./src/main/lib/chat-service')
    stop = service.stopGeneration
    const result = await service.sendMessage({ conversationId: 'c', userMessage: scenario === 'body-budget' ? 'x'.repeat(17 * 1024 * 1024) : '参考原图继续', channelId: 'channel', modelId: 'test', attachments: [attachment] }, null, (event) => events.push(event))
    assert.equal(saved[0].attachments[0], attachment)
    assert.equal(history[0].attachments[0], previous)
    if (scenario === 'body-budget' || scenario === 'tool-budget') {
      assert.match(loggedErrors[0], /^MODEL_REQUEST_BUDGET_EXCEEDED:/)
      assert.match(saved.at(-1).error, /请压缩上下文、减少图片或在新会话继续/)
      assert.doesNotMatch(saved.at(-1).error, /MODEL_REQUEST_BUDGET_EXCEEDED/)
      assert.match(events.at(-1).error, /请求内容超过 16 MiB/)
      assert.doesNotMatch(events.at(-1).error, /MODEL_REQUEST_BUDGET_EXCEEDED/)
    }
    if (scenario === 'body-budget') { assert.equal(result, false); assert.equal(calls, 0) }
    else if (scenario === 'tool-budget') { assert.equal(result, false); assert.equal(calls, 1) }
    else if (scenario === 'image-invalid') {
      assert.equal(result, false)
      assert.equal(calls, 0)
      assert.match(loggedErrors[0], /^IMAGE_REQUEST_INVALID:/)
      assert.match(events.at(-1).error, /请重新选择图片/)
      assert.doesNotMatch(events.at(-1).error, /IMAGE_REQUEST_INVALID/)
      assert.equal(saved.at(-1).error, events.at(-1).error)
    }
    else if (scenario === 'cancel') { assert.equal(result, true); assert.equal(calls, 0) }
    else {
      assert.equal(result, true)
      assert.equal(calls, 2)
      assert.equal(toolContexts[0].currentAttachments[0], attachment)
      assert.equal(toolContexts[0].previousUserAttachments[0], previous)
      const first = JSON.parse(bodies[0])
      const second = JSON.parse(bodies[1])
      assert.deepEqual(first.messages, second.messages.slice(0, first.messages.length))
      assert.equal(bodies[0].split('data:image/').length - 1, 1)
      assert.match(bodies[0], /重复引用图片 1/)
    }
  `
  /** 子进程拥有独立模块缓存，避免 mock 污染其他测试。 */
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: new URL('../../../', import.meta.url).pathname,
    env: { ...process.env, CHAT_IMAGE_TEST_SCENARIO: scenario }, encoding: 'utf8', timeout: 30_000,
  })
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
}

describe('Chat 图片优化真实编排集成', () => {
  test('Given 原始参考附件 When 工具续接 Then 工具得到原图且各轮复用同一预览', () => runChatScenario('normal'))
  test('Given 超大正文 When 首轮发送 Then 在网络前阻断完整请求', () => runChatScenario('body-budget'))
  test('Given 超大工具结果 When 续接发送 Then 在第二轮网络前阻断', () => runChatScenario('tool-budget'))
  test('Given 图片格式错误 When Chat显示错误 Then 仅展示中文建议且日志保留内部错误码', () => runChatScenario('image-invalid'))
  test('Given 图片准备期间取消 When 准备结束 Then 不发送模型请求', () => runChatScenario('cancel'))
})
