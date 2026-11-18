import { expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent'
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai'
import type { AgentPerformanceSample } from '../../../shared/agent-performance'

/** 仅替换 Electron 宿主边界；使用真实 Pi loader、session 与 adapter。 */
mock.module('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp', getName: () => 'Test' }, BrowserWindow: { getAllWindows: () => [] }, WebContentsView: class {}, MessageChannelMain: class {}, utilityProcess: {}, ipcMain: {}, shell: {}, dialog: {}, clipboard: {}, nativeImage: {}, screen: {}, net: {}, session: {}, safeStorage: { isEncryptionAvailable: () => false }, default: {} }))
const { PiAgentAdapter } = await import('./pi-agent-adapter')

for (const priority of [undefined, 'now', 'next', 'later'] as const) {
  test(`Given 首轮已加载 When 普通输入及后续 ${priority ?? '无队列'} Then 首轮仅一次扫描且后续发现新路径`, async () => {
    /** 每个用例独立业务根，不接触用户配置或真实模型。 */
    const root = mkdtempSync(join(tmpdir(), 'p2-first-prompt-'))
    const skills = join(root, 'skills')
    mkdirSync(join(skills, 'initial'), { recursive: true })
    writeFileSync(join(skills, 'initial', 'SKILL.md'), '---\nname: initial\ndescription: initial fixture\n---\nINITIAL_SYNTHETIC_BODY')
    /** 保留生产扫描，仅统计调用；异常仍通过真实 query 抛出。 */
    const reload = spyOn(DefaultResourceLoader.prototype, 'reload')
    /** 捕获实际 adapter 采样输出，验证它未带入合成正文。 */
    const samples: AgentPerformanceSample[] = []
    const previousPerf = process.env.DUTYDECK_AGENT_PERF
    process.env.DUTYDECK_AGENT_PERF = '1'
    const debug = spyOn(console, 'debug').mockImplementation((tag: unknown, value: unknown) => {
      if (tag === '[Agent Perf]' && typeof value === 'string') samples.push(JSON.parse(value) as AgentPerformanceSample)
    })
    let calls = 0
    let queueError: unknown
    const adapter = new PiAgentAdapter({ streamFunction: (_model, context) => {
      calls += 1
      const call = calls
      const text = JSON.stringify(context.messages)
      if (call === 1) {
        expect(reload).toHaveBeenCalledTimes(1)
        expect(text).toContain('INITIAL_SYNTHETIC_BODY')
      } else {
        expect(text).toContain('DYNAMIC_SYNTHETIC_BODY')
        expect(reload).toHaveBeenCalledTimes(2)
      }
      /** 合成合法流，只发送本地文本事件。 */
      const stream = createAssistantMessageEventStream()
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: '合成响应' }], stopReason: 'stop', api: 'openai-completions', provider: 'openai', model: 'gpt-4o', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
      void (async () => {
        if (call === 1 && priority) {
          mkdirSync(join(skills, 'dynamic'), { recursive: true })
          writeFileSync(join(skills, 'dynamic', 'SKILL.md'), '---\nname: dynamic\ndescription: dynamic fixture\n---\nDYNAMIC_SYNTHETIC_BODY')
          await adapter.sendQueuedMessage('synthetic', { type: 'user', session_id: 'synthetic', parent_tool_use_id: null, priority, uuid: 'second-user', message: { role: 'user', content: '/skill:dynamic' } })
        }
        stream.push({ type: 'start', partial: message })
        stream.push({ type: 'text_delta', contentIndex: 0, delta: '合成响应', partial: message })
        stream.push({ type: 'done', reason: 'stop', message })
      })().catch(error => { queueError = error; stream.push({ type: 'error', reason: 'error', error: { ...message, stopReason: 'error', errorMessage: String(error) } }) })
      return stream
    } })
    try {
      for await (const _message of adapter.query({ sessionId: 'synthetic', prompt: '/skill:initial', initialUserMessageUuid: 'first-user', cwd: root, model: 'gpt-4o', provider: 'openai', baseUrl: 'http://offline.invalid/v1', apiKey: 'offline', permissionMode: 'bypassPermissions', systemPrompt: '合成验证', piAgentDir: join(root, 'agent'), piSessionDir: join(root, 'sessions'), additionalSkillPaths: [skills] }, 'synthetic-query')) { /* 消费真实 adapter 全流程。 */ }
      expect(samples.map(sample => sample.stage)).toEqual(['runtime_start', 'prompt_submit', 'first_text'])
      expect(samples.every(sample => sample.domain === 'runtime' && sample.elapsedMs >= 0 && sample.segmentMs >= 0)).toBe(true)
      expect(JSON.stringify(samples)).not.toContain('SYNTHETIC_BODY')
      expect(JSON.stringify(samples)).not.toContain('合成响应')
      expect(queueError).toBeUndefined()
      expect(calls).toBe(priority ? 2 : 1)
      expect(reload).toHaveBeenCalledTimes(priority ? 2 : 1)
    } finally {
      adapter.dispose()
      reload.mockRestore()
      debug.mockRestore()
      if (previousPerf === undefined) delete process.env.DUTYDECK_AGENT_PERF
      else process.env.DUTYDECK_AGENT_PERF = previousPerf
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)
}
