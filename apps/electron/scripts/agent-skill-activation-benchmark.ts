/** 隔离合成基准：bun apps/electron/scripts/agent-skill-activation-benchmark.ts --synthetic */
import { mock } from 'bun:test'
import { strict as assert } from 'node:assert'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { SDKMessage, SkillActivation } from '@dutydeck/shared'

/** 冷恢复子进程仅接收本次临时夹具的身份，不接受真实会话路径。 */
interface ColdRequest {
  /** 父进程创建的隔离目录与随机所有权标记。 */
  root: string
  token: string
  /** 本次合成会话、目标用户及已持久化的激活。 */
  sessionId: string
  uuid: string
  activation: SkillActivation
}

/** 子进程返回实际调用结果；时间只覆盖补记调用，不包含启动和导入。 */
interface ColdResult {
  ok: boolean
  elapsedMs: number
}

/** 仅允许合成入口和内部冷恢复入口，拒绝附带真实路径参数。 */
const args = process.argv.slice(2)
assert(args.includes('--synthetic') && args.every((arg) => ['--synthetic', '--cold-worker'].includes(arg)),
  '仅接受 --synthetic；禁止输入真实会话路径')
/** 内部工作模式通过标准输入传递夹具，不继承父进程模块缓存。 */
const coldWorker = args.includes('--cold-worker')
const request: ColdRequest | undefined = coldWorker ? JSON.parse(await Bun.stdin.text()) as ColdRequest : undefined
/** 业务数据与 Electron 路径全部映射到临时目录。 */
const root = request?.root ?? fs.mkdtempSync(join(os.tmpdir(), 'dutydeck-skill-benchmark-'))
const token = request?.token ?? randomUUID()
const marker = join(root, '.synthetic-owner')
if (request) {
  assert.equal(fs.realpathSync(dirname(root)), fs.realpathSync(os.tmpdir()), '冷恢复目录必须位于临时根')
  assert(basename(root).startsWith('dutydeck-skill-benchmark-') && !fs.lstatSync(root).isSymbolicLink(), '冷恢复目录非法')
  assert.equal(fs.readFileSync(marker, 'utf8'), token, '冷恢复夹具所有权不匹配')
  assert(/^[0-9a-f-]{36}$/.test(request.sessionId), '合成会话身份非法')
} else {
  fs.writeFileSync(marker, token, { flag: 'wx' })
}
mock.module('node:os', () => ({ ...os, homedir: () => root }))
mock.module('electron', () => ({ default: {}, app: { isPackaged: true, getPath: () => root },
  BrowserWindow: class {}, WebContentsView: class {}, utilityProcess: {}, MessageChannelMain: class {},
  ipcMain: {}, session: {}, net: {}, webContents: {}, clipboard: {}, dialog: {},
  nativeImage: { createFromPath: () => ({}) }, nativeTheme: {}, powerMonitor: {}, powerSaveBlocker: {}, screen: {}, shell: {},
  safeStorage: { isEncryptionAvailable: () => false } }))
mock.module('../src/main/lib/adapters/pi-builtin-tools', () => ({ buildPiBuiltinTools: async () => ({ tools: [], toolNames: [] }) }))

/** 输入实际样本，返回最近秩 P50/P95 与原始值；五次采样不代表统计显著性。 */
function summary(samples: number[]) {
  assert(samples.length > 0 && samples.every((sample) => Number.isFinite(sample) && sample >= 0), '无有效计时样本')
  /** 排序副本保留原始采样顺序。 */
  const sorted = [...samples].sort((a, b) => a - b)
  return { p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1], samples }
}

/** 输入合成 JSONL 路径，返回字节摘要与文件身份；读取时间不计入基准。 */
function snapshot(path: string) {
  /** 不比较 atime，读取校验本身可能更新访问时间。 */
  const stat = fs.statSync(path, { bigint: true })
  return {
    sha256: createHash('sha256').update(fs.readFileSync(path)).digest('hex'),
    dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs,
  }
}

/** 输入临时夹具身份，返回独立进程第一次补记的实际结果，失败不生成样本。 */
async function coldDuplicate(input: ColdRequest): Promise<ColdResult> {
  /** 使用相同脚本和隔离宿主，仅模块状态为冷；操作系统文件缓存不保证冷。 */
  const child = Bun.spawn([process.execPath, import.meta.path, '--synthetic', '--cold-worker'], {
    stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe',
  })
  /** 并行排空输出，避免子进程日志堵塞管道。 */
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  assert.equal(exitCode, 0, `冷恢复失败：${stderr}\n${stdout}`)
  /** 业务日志允许存在，仅解析唯一标记行。 */
  const resultLines = stdout.split('\n').filter((line) => line.startsWith('SKILL_BENCH_RESULT '))
  assert.equal(resultLines.length, 1, '冷恢复未返回唯一结果')
  const result = JSON.parse(resultLines[0]!.slice('SKILL_BENCH_RESULT '.length)) as ColdResult
  assert.equal(result.ok, true, '冷恢复未命中目标用户')
  assert(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0, '冷恢复计时非法')
  return result
}

try {
  /** 隔离完成后才导入业务模块，禁止提前解析真实数据根。 */
  const manager = await import('../src/main/lib/agent-session-manager')
  const paths = await import('../src/main/lib/config-paths')
  const { writeTextFileAtomic } = await import('../src/main/lib/safe-file')
  assert(paths.getConfigDir().startsWith(root + '/'), '合成数据根未隔离')

  if (request) {
    /** 冷进程在第一次补记前不读取正文或调用其他会话 API。 */
    const start = performance.now()
    const ok = manager.updateSDKUserMessageSkillActivations(request.sessionId, request.uuid, [request.activation])
    const elapsedMs = performance.now() - start
    console.log(`SKILL_BENCH_RESULT ${JSON.stringify({ ok, elapsedMs } satisfies ColdResult)}`)
  } else {
    for (const count of [10_000, 50_000]) {
      /** 旧历史完全合成，约 1 KiB/条；保留原有 synthetic-0 回退夹具。 */
      const rows = Array.from({ length: count }, (_, index) => JSON.stringify({
        type: index % 4 === 0 ? 'user' : 'assistant', uuid: `synthetic-${index}`,
        message: { content: `合成记录 ${index} ${'baseline '.repeat(110)}` },
      }))
      for (const scenario of ['managed-current-turn', 'unmanaged-synthetic-0-fallback'] as const) {
        /** 两种路径使用独立文件，避免非受管历史目标冒充当前轮正常路径。 */
        const session = manager.createAgentSession(`合成 Skill benchmark ${scenario}`)
        const path = paths.getAgentSessionMessagesPath(session.id)
        assert(path.startsWith(root + '/'), '会话路径未隔离')
        writeTextFileAtomic(path, rows.join('\n') + '\n')
        /** 预期 UUID 顺序独立维护，验证全历史与每次追加均未重建消息身份。 */
        const expectedUuids = Array.from({ length: count }, (_, index) => `synthetic-${index}`)
        /** 四类耗时分别统计；从不替换缓存原型或强制缓存命中/失效。 */
        const first: number[] = []
        const warm: number[] = []
        const appended: number[] = []
        const cold: number[] = []
        /** 旧目标会累积五个 Skill，当前轮则每轮使用新的用户 UUID。 */
        const expectedActivations = new Map<string, SkillActivation[]>()

        /** 输入 SDK 消息，验证真实追写回执和前缀字节保持不变，无返回值。 */
        function append(message: SDKMessage & { uuid: string }): void {
          /** 在计时外捕获旧文件字节与身份，证明追加未重写历史。 */
          const before = fs.readFileSync(path)
          const beforeStat = fs.statSync(path)
          const receipt = manager.appendSDKMessages(session.id, [message])
          assert.equal(receipt.status, 'written', 'SDK 追写被跳过')
          assert.equal(receipt.byteOffset, before.length)
          assert(receipt.messages?.some((identity) => identity.uuid === message.uuid), 'SDK 回执 UUID 不匹配')
          assert.deepEqual(fs.readFileSync(path).subarray(0, before.length), before, 'SDK 追写改变历史字节')
          assert.equal(fs.statSync(path).ino, beforeStat.ino, 'SDK 追写替换了文件')
          expectedUuids.push(message.uuid)
        }

        /** 读取合成落盘结果，验证 UUID、消息数量及 Skill 完整性，无返回值。 */
        function verifyPersisted(): void {
          /** 使用生产读取 API 验证持久化语义，所有读取排除在计时外。 */
          const messages = manager.getAgentSessionSDKMessages(session.id)
          assert.deepEqual(messages.map((message) => 'uuid' in message ? message.uuid : undefined), expectedUuids,
            '消息数量、顺序或 UUID 被改变')
          for (const [uuid, activations] of expectedActivations) {
            /** 目标必须仍然是原用户消息，且保留此前所有激活。 */
            const target = messages.find((message) => 'uuid' in message && message.uuid === uuid)
            assert(target?.type === 'user', '落盘用户消息不存在')
            assert.deepEqual(target.skill_activations, activations, '落盘 Skill 与预期不一致')
          }
        }

        for (let run = 0; run < 5; run++) {
          /** 正常路径将当前轮用户交给生产 SDK 追加入口，历史回退则保持旧目标。 */
          const uuid = scenario === 'managed-current-turn' ? randomUUID() : 'synthetic-0'
          if (scenario === 'managed-current-turn') {
            append({ type: 'user', uuid, parent_tool_use_id: null,
              message: { content: [{ type: 'text', text: `合成当前轮 ${run}` }] } })
          }
          /** 每次首次调用增加一个新 Skill，而后三个阶段重复同一激活。 */
          const activation: SkillActivation = { slug: `synthetic-${run}`, name: `synthetic-${run}`, sources: ['explicit'] }
          expectedActivations.set(uuid, [...(expectedActivations.get(uuid) ?? []), activation])

          /** 返回一次真实补记耗时；必须命中目标用户才接受结果。 */
          function apply(): number {
            /** 计时只覆盖生产补记，不包含断言、哈希或读取验收。 */
            const start = performance.now()
            const ok = manager.updateSDKUserMessageSkillActivations(session.id, uuid, [activation])
            const elapsedMs = performance.now() - start
            assert.equal(ok, true, '合成 Skill 补记未命中目标用户')
            return elapsedMs
          }

          /** 首次新增以及重复通知都不得更改 JSONL 字节、文件身份或版本。 */
          const beforeFirst = snapshot(path)
          first.push(apply())
          const afterFirst = snapshot(path)
          assert.deepEqual(afterFirst, beforeFirst, '首次新增重写了 JSONL')
          warm.push(apply())
          assert.deepEqual(snapshot(path), afterFirst, '热重复重写了 JSONL')
          verifyPersisted()

          /** 正常追写助手消息后再重复，观察生产缓存失效/推进的真实行为。 */
          append({ type: 'assistant', uuid: randomUUID(), parent_tool_use_id: null,
            message: { content: [{ type: 'text', text: '合成追加' }] } })
          const afterAppend = snapshot(path)
          appended.push(apply())
          assert.deepEqual(snapshot(path), afterAppend, '追加后重复重写了 JSONL')

          /** 独立进程恢复同一合成文件，首次访问自然没有进程内缓存。 */
          const restored = await coldDuplicate({ root, token, sessionId: session.id, uuid, activation })
          cold.push(restored.elapsedMs)
          assert.deepEqual(snapshot(path), afterAppend, '冷恢复重复重写了 JSONL')
          verifyPersisted()
        }
        console.log(JSON.stringify({ scenario, count, bytes: fs.statSync(path).size, runs: 5,
          timingScope: '仅 updateSDKUserMessageSkillActivations；冷恢复指新进程，不保证 OS 页缓存冷',
          newActivationMs: summary(first), duplicateWarmMs: summary(warm),
          duplicateAfterAppendMs: summary(appended), duplicateColdRestoreMs: summary(cold),
          verified: { uuidOrderPreserved: true, appendPreservesHistory: true, firstDoesNotRewrite: true, duplicateDoesNotRewrite: true },
        }))
      }
    }
  }
} finally {
  /** 临时夹具仅由父进程清理，子进程退出不能删除父进程仍在使用的数据。 */
  if (!coldWorker) fs.rmSync(root, { recursive: true, force: true })
}
