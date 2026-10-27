import { afterAll, expect, mock, test } from 'bun:test'
import { AGENT_RUNTIME_METHODS, createAgentRuntimeRequest, type NetworkRecoveryNotice, type NetworkDiagnosticInput } from '@dutydeck/shared'

/** 捕获真实utility入口重建后的query能力。 */
interface CapturedInput {
  /** 当前query网络状态。 */
  networkRecovery: { getSnapshot(): NetworkRecoveryNotice | undefined; subscribe(listener: (notice: NetworkRecoveryNotice) => void): () => void }
  /** 脱敏诊断回调。 */
  onNetworkDiagnostic(input: NetworkDiagnosticInput): void
}
let captured: CapturedInput | undefined
/** 可控结束边界，防止入口测试启动真实模型请求。 */
let completeQuery = (): void => {}
const completion = new Promise<void>((resolve) => { completeQuery = resolve })
mock.module('../main/lib/adapters/pi-agent-adapter', () => ({ PiAgentAdapter: class {
  async *query(input: CapturedInput) { captured = input; await completion }
  abort() { completeQuery() }
  dispose() {}
} }))
/** 模拟Electron parentPort和传入的MessagePort，保留真实入口分发逻辑。 */
let bootstrap: ((event: unknown) => void) | undefined
let receive: ((event: { data: unknown }) => void) | undefined
const sent: Array<Record<string, unknown>> = []
const original = Object.getOwnPropertyDescriptor(process, 'parentPort')
Object.defineProperty(process, 'parentPort', { configurable: true, value: { on: (_name: string, listener: (event: unknown) => void) => { bootstrap = listener } } })
afterAll(() => {
  completeQuery()
  if (original) Object.defineProperty(process, 'parentPort', original)
  else Reflect.deleteProperty(process, 'parentPort')
})
await import('./agent-runtime')

test('utility入口重建网络能力、丢弃旧身份，并将诊断通过callback返回', async () => {
  const port = { on: (_name: string, listener: (event: { data: unknown }) => void) => { receive = listener }, postMessage: (value: Record<string, unknown>) => { sent.push(value) }, start() {}, close() {} }
  bootstrap?.({ data: { type: 'proma-agent-runtime-port', protocolVersion: 1 }, ports: [port] })
  const bootId = sent[0]!.bootId as string
  receive?.({ data: createAgentRuntimeRequest(AGENT_RUNTIME_METHODS.QUERY_START, { queryId: 'q', input: { sessionId: 's', networkRecoveryInitial: { epoch: 0, proxyUrl: 'http://initial' } } }, { queryId: 'q', sessionId: 's' }, bootId) })
  expect(captured?.networkRecovery.getSnapshot()?.proxyUrl).toBe('http://initial')
  const epochs: number[] = []
  captured?.networkRecovery.subscribe((notice) => epochs.push(notice.epoch))
  const update = { protocolVersion: 1, kind: 'event', method: AGENT_RUNTIME_METHODS.QUERY_NETWORK_CHANGED, bootId, sessionId: 's', queryId: 'q', payload: { epoch: 1, proxyUrl: 'http://new' } }
  receive?.({ data: { ...update, bootId: 'old' } })
  receive?.({ data: update })
  expect(epochs).toEqual([1])
  captured?.onNetworkDiagnostic({ phase: 'recovery', code: 'network_changed' })
  expect(sent.find((event) => event.method === AGENT_RUNTIME_METHODS.EVENT_QUERY_CALLBACK)).toMatchObject({ bootId, queryId: 'q', sessionId: 's', payload: { callback: 'network_diagnostic', payload: { phase: 'recovery', code: 'network_changed' } } })
  receive?.({ data: createAgentRuntimeRequest(AGENT_RUNTIME_METHODS.QUERY_ABORT, { queryId: 'q', sessionId: 's' }, { queryId: 'q', sessionId: 's' }, bootId) })
  receive?.({ data: { ...update, payload: { epoch: 2 } } })
  expect(epochs).toEqual([1])
  await completion
})
