import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createStore, Provider } from 'jotai'
import { ComputerUseStatus } from './ComputerUseStatus'
import { ComputerUseSettings } from '../settings/ComputerUseSettings'
import { computerUseStateAtom } from '../../atoms/computer-use'

test('Given 另一会话的操作 When 渲染会话状态 Then 不显示该窗口标题或画面', () => {
  /** 每个测试使用独立 Jotai store，防止跨会话状态污染。 */
  const store = createStore()
  store.set(computerUseStateAtom, { snapshot: { config: { enabled: true }, installation: null, operation: { id: 'op', sessionId: 'owner', pid: 1, windowId: '2', title: '私有窗口', startedAt: 1, observedAt: 2, status: 'active', image: 'data:image/png;base64,a' } }, busy: false, stoppingOperationId: null, stop: null, error: null, request: null })
  expect(renderToStaticMarkup(<Provider store={store}><ComputerUseStatus sessionId="other" /></Provider>)).toBe('')
  /** 所属会话可查看最近观察，但不会声称是实时画面。 */
  const html = renderToStaticMarkup(<Provider store={store}><ComputerUseStatus sessionId="owner" /></Provider>)
  expect(html).toContain('私有窗口')
  expect(html).toContain('非实时')
  expect(html).toContain('停止操作')
})

test('Given 未完成安装检测 When 设置页展示 Then 显示未检测且不声称已授权', () => {
  const store = createStore()
  store.set(computerUseStateAtom, { snapshot: { config: { enabled: false }, installation: null, operation: null }, busy: false, stoppingOperationId: null, stop: null, error: null, request: null })
  const html = renderToStaticMarkup(<Provider store={store}><ComputerUseSettings /></Provider>)
  expect(html).toContain('尚未检测')
  expect(html).toContain('aria-checked="false"')
  expect(html).toContain('安装成功不代表系统授权')
  expect(html).toContain('暂无操作')
  expect(html).toContain('未验证')
})

test('Given Windows Driver 状态 When 设置页展示 Then 使用 UI Automation 与屏幕捕获术语', () => {
  /** Windows UI 不应沿用 macOS 的 TCC 名称。 */
  const store = createStore()
  store.set(computerUseStateAtom, { snapshot: {
    config: { enabled: false }, installation: { platform: 'windows', status: 'installed', driverPath: 'C:\\cua-driver.exe', version: '0.38.0' },
    permissions: { accessibility: 'granted', screenRecording: 'granted', checkedAt: 1 }, operation: null,
  }, busy: false, stoppingOperationId: null, stop: null, error: null, request: null })
  const html = renderToStaticMarkup(<Provider store={store}><ComputerUseSettings /></Provider>)
  expect(html).toContain('UI Automation')
  expect(html).toContain('屏幕捕获')
  expect(html).not.toContain('辅助功能：')
})
