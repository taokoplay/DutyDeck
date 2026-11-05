import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExitPlanModeRequest } from '@dutydeck/shared'
import { AgentExitPlanService } from './agent-exit-plan-service'

let root: string
let planDirectory: string
let planFile: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dutydeck-plan-approval-'))
  planDirectory = join(root, 'plan')
  mkdirSync(planDirectory)
  planFile = join(planDirectory, 'implementation.md')
  writeFileSync(planFile, '# 计划\n先验证，再修改。')
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

/** 为每项测试建立独立服务，不接触真实会话或权限。 */
function submit(input: Record<string, unknown> = { planFile }, signal = new AbortController().signal) {
  const service = new AgentExitPlanService()
  let request: ExitPlanModeRequest | undefined
  const result = service.handleExitPlanMode('session-visible', input, signal, (value) => { request = value }, { planDirectory, workspaceDirectory: root })
  return { service, result, request }
}

describe('计划审批文档与生命周期', () => {
  test('Given 合法计划 When 查询 owner 并批准 Then 不消费查询且绑定文档版本', async () => {
    const { service, result, request } = submit()
    expect(request?.planDocument).toMatchObject({ displayName: 'implementation.md' })
    expect(request?.planDocument?.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(service.getPendingRequestOwner(request!.requestId)).toBe('session-visible')
    expect(service.getPendingRequestOwner('missing')).toBeNull()
    expect(service.getPendingRequests()).toEqual([request!])
    expect(service.respondToExitPlanMode({ requestId: request!.requestId, action: 'approve_bypass' })?.targetMode).toBe('bypassPermissions')
    expect((await result).behavior).toBe('allow')
    expect(service.getPendingRequests()).toEqual([])
  })

  test.each(['missing', 'outside', 'relative', 'symlink', 'large'] as const)(
    'Given %s 计划文档 When 提交 Then 不展示审批且拒绝', async (kind) => {
      const outside = join(root, 'outside.md')
      writeFileSync(outside, '# 不属于计划目录')
      const linked = join(planDirectory, 'linked.md')
      symlinkSync(outside, linked)
      const large = join(planDirectory, 'large.md')
      writeFileSync(large, 'x'.repeat(1024 * 1024 + 1))
      const files = { missing: undefined, outside, relative: 'plan/implementation.md', symlink: linked, large }
      const controller = new AbortController()
      const { service, result, request } = submit({ planFile: files[kind] }, controller.signal)
      // 旧实现会建立请求；中止仅避免错误路径留下等待中的 Promise。
      if (request) controller.abort()
      expect(request).toBeUndefined()
      expect((await result).behavior).toBe('deny')
      expect(service.getPendingRequests()).toEqual([])
    },
  )

  test.each(['content', 'symlink', 'deleted'] as const)(
    'Given 审批期间文件发生 %s 变化 When 批准 Then 拒绝且不切换权限', async (kind) => {
      const { service, request, result } = submit()
      if (kind === 'content') writeFileSync(planFile, '# 已改变的计划')
      else {
        rmSync(planFile)
        if (kind === 'symlink') {
          const other = join(root, 'replacement.md')
          writeFileSync(other, '# 计划\n先验证，再修改。')
          symlinkSync(other, planFile)
        }
      }
      expect(service.respondToExitPlanMode({ requestId: request!.requestId, action: 'approve_bypass' })?.targetMode).toBeNull()
      expect(await result).toMatchObject({ behavior: 'deny', message: expect.stringContaining('变更') })
    },
  )

  test('Given 提交前已经中止 When 提交 Then 不广播或保留请求', async () => {
    const controller = new AbortController()
    controller.abort()
    const { request, service } = submit({ planFile }, controller.signal)
    const pendingCount = service.getPendingRequests().length
    service.clearSessionPending('session-visible')
    expect(request).toBeUndefined()
    expect(pendingCount).toBe(0)
  })

  test('Given 请求发布时立即响应 When 批准 Then 请求已注册且不会丢失响应', async () => {
    const service = new AgentExitPlanService()
    let response: ReturnType<AgentExitPlanService['respondToExitPlanMode']> = null
    const result = service.handleExitPlanMode('session-visible', { planFile }, new AbortController().signal, (request) => {
      response = service.respondToExitPlanMode({ requestId: request.requestId, action: 'approve_bypass' })
    }, { planDirectory, workspaceDirectory: root })
    if (!response) service.clearSessionPending('session-visible')
    expect(response).toMatchObject({ targetMode: 'bypassPermissions' })
    expect((await result).behavior).toBe('allow')
  })

  test('Given 等待审批 When 中止或清理会话 Then 收束且不再允许迟到批准', async () => {
    const controller = new AbortController()
    const { request, service, result } = submit({ planFile }, controller.signal)
    controller.abort()
    expect((await result).behavior).toBe('deny')
    expect(service.respondToExitPlanMode({ requestId: request!.requestId, action: 'approve_bypass' })).toBeNull()
    const second = submit()
    second.service.clearSessionPending('session-visible')
    expect((await second.result).behavior).toBe('deny')
  })
})
