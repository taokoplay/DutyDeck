import { expect, test } from 'bun:test'
import { AgentPermissionService } from '../agent-permission-service'
import type { PermissionRequest, DutyDeckPermissionMode } from '@dutydeck/shared'
import { createComputerUseApproval } from './approval'

test.each(['allow', 'deny', 'plan', 'stale', 'abort'] as const)('Given 真实原生审批 When %s Then 单次桌面授权不能被白名单或bypass复用', async decision => {
  /** 使用生产原生审批服务，替换 UI 发布端以便明确决策。 */
  const service = new AgentPermissionService()
  /** 真实发送给确认卡的请求。 */
  const requests: PermissionRequest[] = []
  /** 模拟动态切换计划模式。 */
  let mode: DutyDeckPermissionMode = 'bypassPermissions'
  /** 当前代际是否仍有效。 */
  let active = true
  /** 本次审批的真实中止源。 */
  const controller = new AbortController()
  /** 记录原生审批终态。 */
  const resolved: string[] = []
  /** 完整生产审批回调，不能引用媒体自动授权策略。 */
  const approve = createComputerUseApproval({
    sessionId: 'session-1', service,
    assertActive: () => { if (!active) throw new Error('运行已停止') },
    getPermissionMode: () => mode,
    publishRequested: request => requests.push(request),
    publishResolved: (id, behavior) => resolved.push(`${id}:${behavior}`),
  })
  /** 不包含宿主 session/target 逃生口的单次动作参数。 */
  const input = { kind: 'click', observationId: 'obs-1', elementToken: 'snap:1' }
  const pending = approve('ComputerUseAction', input, controller.signal, 'tool-1')
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ toolName: 'ComputerUseAction', allowAlways: false, toolInput: input })
  if (decision === 'abort') controller.abort()
  else {
    if (decision === 'plan') mode = 'plan'
    if (decision === 'stale') active = false
    service.respondToPermission(requests[0]!.requestId, decision === 'deny' ? 'deny' : 'allow', true)
  }
  expect(await pending).toBe(decision === 'allow')
  expect(service.getPendingRequests()).toEqual([])
  expect(resolved).toHaveLength(1)
  if (decision === 'allow') {
    const second = approve('ComputerUseAction', input, controller.signal, 'tool-2')
    expect(requests).toHaveLength(2)
    service.respondToPermission(requests[1]!.requestId, 'deny', false)
    expect(await second).toBe(false)
  }
})
