import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import { buildPiMcpTools, disposePiMcpConnections } from './pi-mcp-tools'

/** 每例恢复 SDK 方法，连接仅在内存模拟，避免付费调用和网络访问。 */
const restorers: Array<() => void> = []
afterEach(async () => {
  await disposePiMcpConnections()
  for (const restore of restorers.splice(0)) restore()
})

describe('MCP 独立工具调用超时', () => {
  test.each([
    [1200, 1_200_000], [0.5, 500], [undefined, 60_000], [0, 60_000],
    [-1, 60_000], [1201, 60_000], [Infinity, 60_000], [NaN, 60_000], ['1200', 60_000],
  ])('Given tool_timeout_sec=%s When 执行工具 Then SDK 使用 %s 毫秒且握手与发现不变', async (seconds, expectedMs) => {
    /** 捕获真正传给 MCP SDK 的调用参数。 */
    const connect = spyOn(Client.prototype, 'connect').mockResolvedValue(undefined)
    const list = spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [{ name: 'generate', inputSchema: { type: 'object' } }] })
    const call = spyOn(Client.prototype, 'callTool').mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    restorers.push(() => connect.mockRestore(), () => list.mockRestore(), () => call.mockRestore())
    const tools = await buildPiMcpTools({ libtv: { type: 'http', url: 'https://example.test/mcp', tool_timeout_sec: seconds } })
    const signal = new AbortController().signal
    await tools[0]!.execute('test-call', {}, signal, undefined, {} as ExtensionToolContext)
    expect(connect.mock.calls[0]?.[1]?.timeout).toBe(30_000)
    expect(list.mock.calls[0]?.[1]?.timeout).toBe(60_000)
    expect(call.mock.calls[0]?.[2]?.timeout).toBe(expectedMs)
    expect(call.mock.calls[0]?.[2]?.signal).toBe(signal)
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 && seconds <= 1200) {
      expect(call.mock.calls[0]?.[2]?.maxTotalTimeout).toBe(expectedMs)
    }
  })

  test('Given 付费工具 SDK 超时 When 执行失败 Then 原样报错且不重试生成', async () => {
    const connect = spyOn(Client.prototype, 'connect').mockResolvedValue(undefined)
    const list = spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [{ name: 'generate', inputSchema: { type: 'object' } }] })
    const call = spyOn(Client.prototype, 'callTool').mockRejectedValue(new Error('Request timed out'))
    restorers.push(() => connect.mockRestore(), () => list.mockRestore(), () => call.mockRestore())
    const tools = await buildPiMcpTools({ libtv: { type: 'http', url: 'https://example.test/mcp', tool_timeout_sec: 1200 } })
    await expect(tools[0]!.execute('test-call', {}, undefined, undefined, {} as ExtensionToolContext)).rejects.toThrow('Request timed out')
    expect(call).toHaveBeenCalledTimes(1)
  })
})
