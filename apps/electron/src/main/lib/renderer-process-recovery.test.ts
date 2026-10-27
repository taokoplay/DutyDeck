import { describe, expect, test } from 'bun:test'
import {
  canRecoverRenderer,
  RendererRecoveryBudget,
  MAX_RENDERER_RECOVERY_ATTEMPTS,
  RENDERER_RECOVERY_WINDOW_MS,
} from './renderer-process-recovery'

describe('renderer process recovery budget', () => {
  test('allows recovery while fewer than two attempts remain in the window', () => {
    const now = 30_000

    expect(canRecoverRenderer([], now)).toBe(true)
    expect(canRecoverRenderer([now - 1], now)).toBe(true)
    expect(canRecoverRenderer([now - 1, now - 2], now)).toBe(false)
  })

  test('ignores attempts outside the recovery window', () => {
    const now = 30_000

    expect(canRecoverRenderer([
      now - RENDERER_RECOVERY_WINDOW_MS,
      now - RENDERER_RECOVERY_WINDOW_MS - 1,
    ], now)).toBe(true)
  })

  test('连续恢复两次后，即使已跨过30秒窗口也不能再次自动恢复', () => {
    expect(canRecoverRenderer([0, 31_000], 62_000, 2)).toBe(false)
  })

  test('keeps the configured recovery limit explicit', () => {
    expect(MAX_RENDERER_RECOVERY_ATTEMPTS).toBe(2)
  })
})

describe('主界面连续恢复生命周期', () => {
  test('加载成功后立即崩溃循环仍只自动恢复两次', () => {
    /** 使用真实预算状态模拟 Electron load→crash 事件。 */
    const budget = new RendererRecoveryBudget()
    budget.markLoaded(0)
    expect(budget.tryRecover(1)).toBe(true)
    budget.markLoaded(2)
    expect(budget.tryRecover(3)).toBe(true)
    budget.markLoaded(4)
    expect(budget.tryRecover(5)).toBe(false)
  })

  test('跨过30秒窗口但每次健康不足60秒时保留连续预算', () => {
    const budget = new RendererRecoveryBudget()
    expect(budget.tryRecover(0)).toBe(true)
    budget.markLoaded(1)
    expect(budget.tryRecover(31_000)).toBe(true)
    budget.markLoaded(31_001)
    expect(budget.tryRecover(62_000)).toBe(false)
  })

  test('连续健康恰满60秒后重新允许两次恢复', () => {
    const budget = new RendererRecoveryBudget()
    expect(budget.tryRecover(0)).toBe(true)
    expect(budget.tryRecover(1)).toBe(true)
    budget.markLoaded(2)
    expect(budget.tryRecover(60_002)).toBe(true)
    expect(budget.tryRecover(60_003)).toBe(true)
    expect(budget.tryRecover(60_004)).toBe(false)
  })

  test('导航或加载失败中断健康期，长时间等待不能释放预算', () => {
    const budget = new RendererRecoveryBudget()
    budget.tryRecover(0)
    budget.tryRecover(1)
    budget.markLoaded(2)
    budget.markLoading(50_000)
    expect(budget.tryRecover(100_000)).toBe(false)
  })

  test('普通刷新不能清空预算，手动错误页重试明确清空', () => {
    const budget = new RendererRecoveryBudget()
    budget.tryRecover(0)
    budget.tryRecover(1)
    budget.markLoaded(2)
    budget.markLoading(3)
    budget.markLoaded(4)
    expect(budget.tryRecover(5)).toBe(false)
    budget.resetForManualRetry()
    expect(budget.tryRecover(6)).toBe(true)
    expect(budget.tryRecover(7)).toBe(true)
    expect(budget.tryRecover(8)).toBe(false)
  })

  test('退出状态不恢复也不消耗预算', () => {
    const budget = new RendererRecoveryBudget()
    expect(budget.tryRecover(0, true)).toBe(false)
    expect(budget.tryRecover(1, false, 'clean-exit')).toBe(false)
    expect(budget.tryRecover(2)).toBe(true)
    expect(budget.tryRecover(3)).toBe(true)
  })
})
