import { expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import type { PermissionRequest } from '@dutydeck/shared'
import { AgentPermissionService } from '../agent-permission-service'
import { createComputerUseApproval } from './approval'
import { ComputerUseService } from './service'
import { buildComputerUseTools } from './tools'

test('Given 真实工具与审批服务 When 经子进程观察和输入 Then 拒绝无副作用且允许只消费一次观察', async () => {
  /** 所有协议文件都在独立临时目录，不访问真实桌面。 */
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-computer-contract-'))
  /** 假 CLI 的可执行路径与宿主动作日志。 */
  const path = join(directory, 'cua-driver')
  const log = join(directory, 'calls.jsonl')
  try {
    await writeFile(path, `#!${process.execPath}
const { appendFileSync } = require('node:fs');
if (process.argv[2] === '--version') { console.log('cua-driver 0.38.0'); process.exit(0); }
const tool = process.argv[3];
const args = JSON.parse(process.argv[4]);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({tool,args}) + '\\n');
const result = tool === 'list_windows' ? {windows:[{pid:12,window_id:34,title:'测试窗口'}]}
  : tool === 'get_window_state' ? {pid:12,window_id:34,...(args.tree_format === 'elements' ? {elements:[{element_token:'snapshot:1',role:'button'}]} : {tree_markdown:'[1] button'})}
  : {success:true};
console.log(JSON.stringify({structuredContent:result}));
`)
    await chmod(path, 0o700)
    /** 使用真实 CLI 适配器和租约服务，仅替换外部可执行程序。 */
    const service = new ComputerUseService({ platform: 'darwin', loadConfig: () => ({ enabled: true, driverPath: path }), saveConfig: () => {} })
    await service.checkInstallation()
    /** 一轮绑定的取消身份。 */
    const controller = new AbortController()
    const context = { sessionId: 'contract', signal: controller.signal, assertActive: () => {}, getPermissionMode: () => 'bypassPermissions' as const }
    const run = service.createRun(context)
    /** 生产单次审批服务；决策只通过其公开响应入口提交。 */
    const permissions = new AgentPermissionService()
    const requests: PermissionRequest[] = []
    let decision: 'allow' | 'deny' = 'allow'
    const approve = createComputerUseApproval({ ...context, service: permissions,
      publishRequested: request => {
        requests.push(request)
        queueMicrotask(() => permissions.respondToPermission(request.requestId, decision, true))
      },
      publishResolved: () => {},
    })
    /** 执行真实 Pi 工具入口，覆盖 schema、审批、服务与子进程四层。 */
    const tools = buildComputerUseTools({ ...context, run, approve })
    const execute = (name: string, input: Record<string, unknown>) => tools.find(tool => tool.name === name)!.execute('contract-call', input, controller.signal, undefined, {} as ExtensionToolContext)
    try {
      await execute('ComputerUseDiscover', {})
      /** 观察回执使用工具实际返回的身份，不能绕过宿主签发。 */
      const observed = await execute('ComputerUseObserve', { pid: 12, windowId: '34' })
      const block = observed.content.find(item => item.type === 'text')
      if (!block || block.type !== 'text') throw new Error('观察缺少文本结果')
      const receipt: { observationId: string } = JSON.parse(block.text)
      const action = { kind: 'click', observationId: receipt.observationId, elementToken: 'snapshot:1' }
      decision = 'deny'
      await expect(execute('ComputerUseAction', action)).rejects.toThrow('拒绝')
      expect((await readFile(log, 'utf8')).includes('"tool":"click"')).toBe(false)
      decision = 'allow'
      await execute('ComputerUseAction', action)
      await expect(execute('ComputerUseAction', action)).rejects.toThrow('观察')
      /** 只允许一次输入，且窗口、后台模式和 Driver session 均由宿主填充。 */
      const calls: Array<{ tool: string; args: Record<string, unknown> }> = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      const clicks = calls.filter(call => call.tool === 'click')
      expect(clicks).toHaveLength(1)
      expect(clicks[0]!.args).toMatchObject({ target: { kind: 'window', pid: 12, window_id: 34 }, element_token: 'snapshot:1', delivery_mode: 'background', action: 'press', session: expect.stringContaining('dutydeck-') })
      expect(requests).toHaveLength(4)
      expect(requests.every(request => request.allowAlways === false)).toBe(true)
      await execute('ComputerUseStop', {})
      expect(service.getSnapshot().operation).toBeNull()
      await expect(execute('ComputerUseDiscover', {})).rejects.toThrow('停止')
    } finally { await run.dispose() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
