import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

/** 独立 Bun 子进程隔离 smoke 的生命周期替身，不污染同进程的其他业务测试。 */
test('Given 直接选择媒体模型 When 真实准备 Agent 运行 Then 仅装配媒体能力并保留边界和计划权限', () => {
  /** 只执行离线脚本；其所有持久化和收费生成出口均立即拒绝调用。 */
  const result = Bun.spawnSync([process.execPath, 'run', resolve(import.meta.dir, '../../../scripts/agent-media-selection-smoke.ts')], {
    stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  })
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain('PASS: prepareAgentRun 真实入口与媒体 Provider 离线装配')
})
