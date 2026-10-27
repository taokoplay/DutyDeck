import { afterAll, beforeEach, expect, mock, test } from 'bun:test'

/** 以命令参数选择可控输出，覆盖系统命令失败和格式损坏。 */
let outputs: Record<string, string | Error> = {}
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
mock.module('node:child_process', () => ({ execFile: (...args: unknown[]) => {
  const commandArgs = args[1] as string[]
  const callback = args.at(-1) as (error: Error | null, value?: { stdout: string }) => void
  const output = outputs[commandArgs[0] === 'query' ? commandArgs.at(-1)! : commandArgs[0]!]
  queueMicrotask(() => output instanceof Error ? callback(output) : callback(null, { stdout: output ?? '' }))
} }))
const { detectSystemProxy } = await import('./system-proxy-detector')
beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  outputs = { '-listallnetworkservices': 'Wi-Fi', '-getsecurewebproxy': 'Enabled: No', '-getwebproxy': 'Enabled: No' }
})
afterAll(() => { Object.defineProperty(process, 'platform', platformDescriptor); mock.restore() })

test('macOS两种代理均明确关闭才报告direct', async () => {
  expect((await detectSystemProxy()).detectionState).toBe('direct')
})
test('HTTPS查询失败且HTTP关闭时保留error，不能误判直连', async () => {
  outputs['-getsecurewebproxy'] = new Error('timeout')
  expect((await detectSystemProxy()).detectionState).toBe('error')
})
test('HTTPS失败但HTTP找到代理仍可报告proxy', async () => {
  outputs['-getsecurewebproxy'] = new Error('timeout')
  outputs['-getwebproxy'] = 'Enabled: Yes\nServer: localhost\nPort: 7890'
  expect(await detectSystemProxy()).toMatchObject({ success: true, detectionState: 'proxy', proxyUrl: 'http://localhost:7890' })
})
test('损坏输出和启用但缺失地址不能成为direct', async () => {
  outputs['-getsecurewebproxy'] = 'garbled'
  expect((await detectSystemProxy()).detectionState).toBe('error')
  outputs['-getsecurewebproxy'] = 'Enabled: Yes\nServer: \nPort: 0'
  expect((await detectSystemProxy()).detectionState).toBe('error')
})
test('Windows必须解析明确的ProxyEnable值，缺失或损坏是error', async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  outputs.ProxyEnable = 'garbled'
  expect((await detectSystemProxy()).detectionState).toBe('error')
  outputs.ProxyEnable = 'ProxyEnable REG_DWORD 0x0'
  expect((await detectSystemProxy()).detectionState).toBe('direct')
})

test('Linux明确无代理为direct，损坏代理为error', async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  const names = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']
  const previous = names.map((name) => process.env[name])
  try {
    for (const name of names) delete process.env[name]
    expect((await detectSystemProxy()).detectionState).toBe('direct')
    process.env.HTTPS_PROXY = 'broken proxy'
    expect((await detectSystemProxy()).detectionState).toBe('error')
    process.env.HTTPS_PROXY = 'http://localhost:7890'
    expect((await detectSystemProxy()).detectionState).toBe('proxy')
  } finally {
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index] })
  }
})
