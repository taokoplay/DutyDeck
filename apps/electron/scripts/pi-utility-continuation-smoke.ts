import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { appendFileSync, statSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_RUNTIME_METHODS as M } from '@dutydeck/shared'
import { readPiArtifactSnapshot } from '../src/main/lib/pi-artifact-reconciliation'
import { AgentRunJournalStore } from '../src/main/lib/agent-run-journal'
import { AgentRunRecoveryService } from '../src/main/lib/agent-run-recovery'
import { assertPiExactContinuation } from '../src/main/lib/adapters/pi-exact-continuation'
import type { SDKMessage } from '@dutydeck/shared'
/** 有界等待真实进程和磁盘状态。 */
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 25_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('utility smoke 等待超时')
    await new Promise<void>(resolve => setTimeout(resolve, 20))
  }
}
/** 验证生产 utility、adapter 和权限链，provider 仅在测试构建中注入。 */
async function smoke(root: string, buildDir: string): Promise<void> {
  const { app } = require('electron') as typeof import('electron')
  app.setPath('userData', join(root, 'electron'))
  await app.whenReady()
  const { AgentRuntimeClient } = await import('../src/main/lib/agent-runtime-client')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const sessionDir = join(root, 'sessions')
  mkdirSync(sessionDir)
  let permissionCalls = 0
  /** 仅以真实运行事件和生产落盘回调建立三事实源。 */
  const displayPath = join(root, 'display.jsonl')
  const journal = new AgentRunJournalStore({ resolvePath: () => join(root, 'journal.jsonl'), resolveDisplayPath: () => displayPath })
  const runId = 'utility-crash-run'
  let branchId = 'main'
  let sessionFile: string | undefined
  const toolEvents = new Map<string, string>()
  const append = (eventType: Parameters<typeof journal.append>[0]['eventType'], payload: Record<string, unknown> = {}, parentEventId?: string) => journal.append({ sessionId: 'smoke', runId, branchId, eventType, payload, parentEventId })
  const persistDisplay = (message: SDKMessage): void => {
    if (!('uuid' in message) || typeof message.uuid !== 'string') return
    const line = JSON.stringify(message)
    const byteOffset = existsSync(displayPath) ? statSync(displayPath).size : 0
    appendFileSync(displayPath, `${line}\n`)
    const stat = statSync(displayPath)
    journal.append({ sessionId: 'smoke', runId, branchId, eventType: 'checkpoint', factBinding: { display: { byteOffset, byteLength: Buffer.byteLength(`${line}\n`), fileIdentity: { dev: stat.dev, ino: stat.ino }, messages: [{ uuid: message.uuid, sha256: createHash('sha256').update(line).digest('hex') }] } } })
  }
  append('checkpoint', { stage: 'run-started' })
  append('user_turn', { userMessageUuid: 'initial-user' })
  persistDisplay({ type: 'user', uuid: 'initial-user', message: { role: 'user', content: '只写一次' } } as SDKMessage)
  const input = { initialUserMessageUuid: 'initial-user', sessionId: 'smoke', prompt: '只写一次', cwd: root, model: 'gpt-4o', provider: 'openai', baseUrl: 'http://offline.invalid/v1', apiKey: 'offline', permissionMode: 'bypassPermissions', systemPrompt: '离线 smoke', piAgentDir: join(root, 'agent'), piSessionDir: sessionDir }
  const createClient = (phase: string) => {
    const client = new AgentRuntimeClient({ sessionId: 'smoke', entryPath: join(buildDir, 'runtime/agent-runtime.mjs'), env: { ...process.env, PI_CONTINUATION_SMOKE_ROOT: root, PI_CONTINUATION_SMOKE_PHASE: phase } })
    client.onEvent(event => {
      const payload = event.payload as Record<string, unknown> | undefined
      if (event.method === M.EVENT_QUERY_CALLBACK) {
        const callback = payload?.payload as Record<string, unknown> | undefined
        if (payload?.callback === 'session_id' && typeof callback?.sdkSessionId === 'string') {
          if (branchId === 'main') { branchId = callback.sdkSessionId; append('checkpoint', { stage: 'pi-session-bound', piSessionId: branchId }) }
          if (typeof callback.sessionFile === 'string') sessionFile = callback.sessionFile
        }
        if (payload?.callback === 'pi_entry_bindings' && sessionFile) {
          const snapshot = readPiArtifactSnapshot(sessionFile)
          journal.append({ sessionId: 'smoke', runId, branchId, eventType: 'checkpoint', factBinding: { pi: { sessionId: snapshot.sessionId, sessionFile, branchTipId: snapshot.branchTipId, artifactSha256: snapshot.artifactSha256, entryBindings: callback?.bindings as Record<string, string> } } })
        }
      }
      if (event.method !== M.EVENT_QUERY) return
      const message = payload?.message as SDKMessage | undefined
      if (!message || (message.type !== 'assistant' && message.type !== 'user')) return
      const content = (message as { message?: { content?: unknown } }).message?.content
      if (!Array.isArray(content)) return
      if (message.type === 'assistant') append('assistant_turn', { messageUuid: 'uuid' in message ? message.uuid : undefined })
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'tool_use' && typeof block.id === 'string') toolEvents.set(block.id, append('tool_started', { toolUseId: block.id, toolName: block.name, replaySafe: false }).eventId)
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') append('tool_result', { toolUseId: block.tool_use_id }, toolEvents.get(block.tool_use_id))
      }
      persistDisplay(message)
    })
    client.setRequestHandler(async request => {
      if (request.method === M.CAPABILITY_CAN_USE_TOOL) { permissionCalls += 1; return { behavior: 'allow', updatedInput: (request.payload as { input: unknown }).input } }
      if (request.method === M.CAPABILITY_FILE_CHANGE) return undefined
      throw new Error(`意外能力调用 ${request.method}`)
    })
    return client
  }
  const first = createClient('crash')
  const firstState = await first.start()
  try {
    await first.call(M.QUERY_START, { queryId: 'first', input })
    await until(() => existsSync(join(root, 'ready')))
    assert.equal(readFileSync(join(root, 'effect.txt'), 'utf8'), 'once')
    await until(() => journal.getPiBinding('smoke', runId) !== undefined && journal.read('smoke').some(event => event.eventType === 'tool_result'))
    process.kill(firstState.pid!, 'SIGKILL')
    await until(() => { try { process.kill(firstState.pid!, 0); return false } catch { return true } })
  } finally { await first.stop() }
  const file = join(sessionDir, readdirSync(sessionDir).find(name => name.endsWith('.jsonl'))!)
  append('run_failed', { errorCode: 'AGENT_RUNTIME_INTERRUPTED', recoverableInterruption: true })
  const recovery = new AgentRunRecoveryService({ journal, isBusy: () => false, getSession: () => ({ sdkSessionId: branchId, piSessionFile: sessionFile }), validateContinuation: expected => assertPiExactContinuation(SessionManager.open(expected.expectedSessionFile), expected), assertContextCurrent: () => undefined })
  /** 实际持久回调必须覆盖初始 user、assistant 与 toolResult 的展示身份。 */
  const actualBindings = journal.getPiBinding('smoke', runId)!.entryBindings
  assert.ok(actualBindings['initial-user'])
  const displayed = readFileSync(displayPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { uuid: string })
  for (const message of displayed) assert.ok(actualBindings[message.uuid], `缺少真实落盘绑定 ${message.uuid}`)
  /** 模拟 Host 没收到工具结果：复制真实事件但省略结果，不伪造完成回执。 */
  const unconfirmedJournal = new AgentRunJournalStore({ resolvePath: () => join(root, 'unconfirmed.jsonl'), resolveDisplayPath: () => displayPath })
  for (const event of journal.read('smoke')) {
    if (event.eventType === 'tool_result') continue
    unconfirmedJournal.append({ sessionId: 'smoke', runId, branchId: event.branchId, eventType: event.eventType, payload: event.payload, parentEventId: event.parentEventId })
  }
  const unconfirmedRecovery = new AgentRunRecoveryService({ journal: unconfirmedJournal, isBusy: () => false, getSession: () => ({ sdkSessionId: branchId, piSessionFile: sessionFile }), validateContinuation: expected => assertPiExactContinuation(SessionManager.open(expected.expectedSessionFile), expected), assertContextCurrent: () => undefined })
  assert.deepEqual(unconfirmedRecovery.list('smoke')[0]?.availableActions, ['abandon'])
  const plan = recovery.list('smoke')[0]
  assert.ok(plan, '必须存在真实恢复计划')
  assert.ok(plan.availableActions?.includes('continue'), JSON.stringify(plan))
  assert.ok(permissionCalls > 0, '必须实际经过生产权限 RPC')
  const permissionsBefore = permissionCalls
  const second = createClient('resume')
  let ended = false
  let error: unknown
  second.onEvent(event => {
    if (event.method === M.EVENT_QUERY_END) ended = true
    if (event.method === M.EVENT_QUERY_ERROR) { error = event.payload; ended = true }
  })
  try {
    const result = recovery.apply({ sessionId: 'smoke', runId, branchId, lastSequence: plan.lastSequence, operation: 'continue' }, async context => {
      assert.equal(context.runId, runId)
      await second.call(M.QUERY_START, { queryId: 'second', input: { ...input, resumeSessionId: context.sessionId, resumeContinuation: context } })
    })
    assert.equal(result.status, 'accepted')
    await until(() => ended)
    assert.equal(error, undefined)
    assert.equal(permissionCalls, permissionsBefore)
    const messages = SessionManager.open(file).buildSessionContext().messages
    assert.equal(messages.filter(message => message.role === 'user').length, 1)
    assert.equal(messages.filter(message => message.role === 'toolResult').length, 1)
    assert.equal(messages.at(-1)?.role, 'assistant')
    assert.equal(journal.read('smoke').filter(event => event.eventType === 'user_turn').length, 1)
    assert.equal(journal.read('smoke').filter(event => event.eventType === 'tool_started').length, 1)
    assert.equal(journal.read('smoke').filter(event => event.eventType === 'tool_result').length, 1)
    assert.ok(journal.read('smoke').every(event => event.runId === runId))
    assert.equal(readFileSync(join(root, 'calls'), 'utf8'), 'crash\ncrash\nresume\n')
    console.log('[Pi utility continuation smoke] PASS: 生产落盘回调→Journal→SIGKILL→RecoveryService.list/apply→同run续接；未确认工具阻断、无重复user/tool、零模型网络请求')
  } finally { await second.stop() }
}
/** 临时构建注入 provider，不增加生产用户可达的测试开关。 */
async function orchestrate(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'pi-utility-continuation-'))
  const buildDir = join(root, 'build')
  mkdirSync(buildDir)
  symlinkSync(join(process.cwd(), 'node_modules'), join(buildDir, 'node_modules'), 'dir')
  const external = ['electron', '@earendil-works/*', 'sharp', 'undici']
  const main = await Bun.build({ entrypoints: [__filename], outdir: join(buildDir, 'main'), target: 'node', format: 'cjs', external })
  const runtime = await Bun.build({ entrypoints: [join(process.cwd(), 'src/utility/agent-runtime.ts')], outdir: join(buildDir, 'runtime'), target: 'node', format: 'esm', naming: '[name].mjs', banner: "import { createRequire as smokeCreateRequire } from 'node:module'; const require = smokeCreateRequire(import.meta.url);", external, plugins: [{ name: 'offline-provider-injection', setup(build) {
    build.onLoad({ filter: /src\/utility\/agent-runtime\.ts$/ }, async args => ({ loader: 'ts', contents: `import { offlineContinuationStream } from ${JSON.stringify(join(process.cwd(), 'scripts/pi-continuation-offline-provider.ts'))};\n${readFileSync(args.path, 'utf8').replace('new PiAgentAdapter()', 'new PiAgentAdapter({ streamFunction: offlineContinuationStream })')}` }))
  } }] })
  if (!main.success || !runtime.success) throw new Error([...main.logs, ...runtime.logs].join('\n'))
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CONTINUATION_SMOKE_CHILD: '1', PI_CONTINUATION_SMOKE_ROOT: root, PI_CONTINUATION_SMOKE_BUILD: buildDir }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(join(process.cwd(), 'node_modules/.bin/electron'), [main.outputs[0]!.path], { env, stdio: 'inherit' })
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('smoke 超时')) }, 90_000)
      child.once('error', reject)
      child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`smoke exit ${code}`)) })
    })
  } finally { rmSync(root, { recursive: true, force: true }) }
}
if (process.env.PI_CONTINUATION_SMOKE_CHILD === '1') {
  const { app } = require('electron') as typeof import('electron')
  void smoke(process.env.PI_CONTINUATION_SMOKE_ROOT!, process.env.PI_CONTINUATION_SMOKE_BUILD!).then(() => app.quit()).catch(error => { console.error(error); app.exit(1) })
} else { void orchestrate().catch(error => { console.error(error); process.exitCode = 1 }) }
